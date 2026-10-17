/**
 * `--policy <file>`: exit codes, errors, the trust model (repository configuration, ignore
 * entries, directives and .gitignore cannot hide a violation), baselines, every format, and the
 * guarantee that violations never become findings or change the score.
 */
import { createHash } from 'node:crypto';
import { readFile, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, run } from '../../src/cli/run.js';
import { POLICY_MAX_BYTES } from '../../src/io/policy-file.js';
import { HOOKS_NOT_ENFORCED, UNKNOWN_FIELD_REASON } from '../../src/policy/index.js';
import type { PolicyReport } from '../../src/policy/types.js';
import { capture, removeTempDirs, tempDir, writeFiles } from './helpers.js';

afterEach(removeTempDirs);

interface Report {
  readonly score: unknown;
  readonly summary: unknown;
  readonly findings: readonly { readonly ruleId: string }[];
  readonly inventory: { readonly mcpServers: readonly { readonly id: string }[] };
  readonly baseline?: { readonly gate: { readonly hits: readonly unknown[] } };
  readonly policy?: PolicyReport;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const servers = (entries: Record<string, string>): string =>
  json({
    mcpServers: Object.fromEntries(
      Object.entries(entries).map(([name, spec]) => [name, { command: 'npx', args: ['-y', spec] }]),
    ),
  });

/** A repository with one unpinned MCP server, a curl grant and a short CLAUDE.md. */
const REPO: Record<string, string> = {
  '.mcp.json': servers({ fetch: 'mcp-fetch-server' }),
  '.claude/settings.json': json({ permissions: { allow: ['Bash(curl:*)'] } }),
  'CLAUDE.md': '# Project\n\nUse pnpm for everything.\n',
};

const policyOf = (document: object): string =>
  json({ policyVersion: 1, name: 'acme agent policy', ...document });

/** A temporary directory with `repo/` and `policy.json`; commands run from it. */
async function setup(
  document: object | string,
  files: Record<string, string> = REPO,
): Promise<string> {
  const work = await tempDir();
  await writeFiles(join(work, 'repo'), files);
  await writeFile(
    join(work, 'policy.json'),
    typeof document === 'string' ? document : policyOf(document),
  );
  return work;
}

async function scan(
  work: string,
  args: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  const io = capture(work);
  const code = await run(['repo', ...args], io);
  return { code, out: io.output(), err: io.errors() };
}

async function scanReport(work: string, args: readonly string[]): Promise<[number, Report]> {
  const { code, out } = await scan(work, [...args, '--format', 'json']);
  return [code, JSON.parse(out) as Report];
}

const ALLOW_NOTHING = { mcp: { allow: [] } };

// ---------------------------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------------------------

describe('exit codes', () => {
  it('exits 1 on a violation that fails, whatever --fail-on says', async () => {
    const work = await setup(ALLOW_NOTHING);
    const [code, report] = await scanReport(work, ['--policy', 'policy.json', '--fail-on', 'none']);
    expect(code).toBe(EXIT.findings);
    expect(report.policy?.violations).toMatchObject([
      {
        check: 'mcp-not-allowed',
        entry: 'npm:mcp-fetch-server',
        path: 'repo/.mcp.json',
        line: 3,
        fails: true,
      },
    ]);
    // The id stays relative to the scanned directory; only the path carries the prefix.
    expect(report.policy?.violations[0]?.id).toMatch(/^mcp-not-allowed:mcp:\.mcp\.json#fetch@/);
  });

  it('exits 0 when the repository follows the policy', async () => {
    const work = await setup({ mcp: { allow: ['npm:mcp-fetch-server'] } });
    const [code, report] = await scanReport(work, ['--policy', 'policy.json', '--fail-on', 'none']);
    expect(code).toBe(EXIT.ok);
    expect(report.policy).toMatchObject({ name: 'acme agent policy', checks: 2, violations: [] });
  });

  it('never fails in audit mode', async () => {
    const work = await setup({ ...ALLOW_NOTHING, mode: 'audit' });
    const [code, report] = await scanReport(work, ['--policy', 'policy.json', '--fail-on', 'none']);
    expect(code).toBe(EXIT.ok);
    expect(report.policy?.violations.map((violation) => violation.fails)).toEqual([false]);
    expect(report.policy?.notes.map((note) => note.id)).toEqual(['audit-mode']);
  });

  it('says why on stderr when the format does not show the policy', async () => {
    const work = await setup(ALLOW_NOTHING);
    for (const format of ['json', 'sarif', 'badge']) {
      const { code, err } = await scan(work, ['--policy', 'policy.json', '--format', format]);
      expect(code).toBe(EXIT.findings);
      expect(err).toBe('Policy "acme agent policy": 1 violation fails the run.\n');
    }
    const { err } = await scan(work, ['--policy', 'policy.json', '--format', 'stylish']);
    expect(err).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------------------------

describe('with a baseline', () => {
  /** base.json from the repository as it is, then `files` added on top. */
  async function changed(document: object, files: Record<string, string>): Promise<string> {
    const work = await setup(document);
    const io = capture(work);
    const args = ['repo', '--context', '--format', 'json', '--output', 'base.json'];
    expect(await run([...args, '--fail-on', 'none'], io)).toBe(EXIT.ok);
    await writeFiles(join(work, 'repo'), files);
    return work;
  }

  const added = { '.mcp.json': servers({ fetch: 'mcp-fetch-server', other: 'other-server' }) };

  it('existing: report fails only on new violations', async () => {
    const work = await changed({ ...ALLOW_NOTHING, existing: 'report' }, added);
    const [code, report] = await scanReport(work, [
      '--policy',
      'policy.json',
      '--baseline',
      'base.json',
      '--fail-on',
      'none',
    ]);
    expect(code).toBe(EXIT.findings);
    expect(
      report.policy?.violations.map(({ entry, baseline, fails }) => ({ entry, baseline, fails })),
    ).toEqual([
      { entry: 'npm:mcp-fetch-server', baseline: 'unchanged', fails: false },
      { entry: 'npm:other-server', baseline: 'new', fails: true },
    ]);
  });

  it('existing: report passes with only unchanged violations, existing: fail does not', async () => {
    for (const [existing, expected] of [
      ['report', EXIT.ok],
      ['fail', EXIT.findings],
    ] as const) {
      const work = await changed({ ...ALLOW_NOTHING, existing }, {});
      const args = ['--policy', 'policy.json', '--baseline', 'base.json', '--fail-on', 'none'];
      const [code, report] = await scanReport(work, args);
      expect(code, existing).toBe(expected);
      expect(report.policy?.violations.map((violation) => violation.baseline)).toEqual([
        'unchanged',
      ]);
    }
  });

  it('counts a changed server that already violates the policy as new', async () => {
    const pinned = { '.mcp.json': servers({ fetch: 'mcp-fetch-server@1.0.0' }) };
    const work = await changed(ALLOW_NOTHING, pinned);
    const args = ['--policy', 'policy.json', '--baseline', 'base.json', '--fail-on', 'none'];
    const [code, report] = await scanReport(work, args);
    expect(code).toBe(EXIT.findings);
    expect(report.policy?.violations.map((violation) => violation.baseline)).toEqual(['new']);
  });

  it('works with --gate and --context, in every format', async () => {
    const work = await changed(ALLOW_NOTHING, added);
    const args = ['--policy', 'policy.json', '--baseline', 'base.json', '--gate', 'security'];
    for (const format of ['stylish', 'json', 'sarif', 'github', 'markdown', 'badge']) {
      const { code, out } = await scan(work, [...args, '--context', '--format', format]);
      expect(code, format).toBe(EXIT.findings);
      expect(out, format).not.toBe('');
    }
    const [, report] = await scanReport(work, [...args, '--context']);
    expect(report.baseline?.gate.hits.length).toBeGreaterThan(0);
    expect(report.policy?.violations).toHaveLength(2);
    const { out } = await scan(work, [...args, '--format', 'markdown']);
    expect(out.indexOf('### Policy: acme agent policy')).toBeLessThan(
      out.indexOf('### Agent configuration changes'),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The policy file
// ---------------------------------------------------------------------------------------------

describe('policy file problems exit 2', () => {
  async function expectErrors(document: object | string, lines: readonly string[]): Promise<void> {
    const work = await setup(document);
    const { code, out, err } = await scan(work, ['--policy', 'policy.json']);
    expect(code).toBe(EXIT.usage);
    expect(out).toBe('');
    expect(err).toBe(lines.map((line) => `${line}\n`).join(''));
  }

  it('reports an unknown field, one line per problem', async () => {
    await expectErrors({ mcp: { alow: [] }, forbid: ['broad-shel'] }, [
      `policy.json: Unknown field "mcp.alow" (did you mean "mcp.allow"?). ${UNKNOWN_FIELD_REASON}`,
      'policy.json: forbid[0]: unknown setting "broad-shel". Did you mean "broad-shell"? forbid is a closed list: bypass-permissions, auto-approve-project-mcp, mcp-auto-approve, broad-shell, broad-write, gemini-trust, additional-directories, env-endpoint, env-tls, env-code-exec.',
    ]);
  });

  it('refuses ranges, URLs that are not origins and unknown hook events', async () => {
    await expectErrors(
      {
        mcp: { allow: ['npm:mcp-fetch-server@^1.0.0', 'https://mcp.acme.dev/mcp'] },
        hooks: { require: [{ agent: 'claude-code', event: 'PreTooluse' }] },
      },
      [
        'policy.json: mcp.allow[0]: "npm:mcp-fetch-server@^1.0.0" names a version range. Ranges are not allowed: give an exact version or none.',
        'policy.json: mcp.allow[1]: "https://mcp.acme.dev/mcp" is not an origin. A URL entry must be an origin, scheme://host[:port], without a path, query or user name.',
        'policy.json: hooks.require[0].event: "PreTooluse" is not a Claude Code hook event. Did you mean "PreToolUse"?',
      ],
    );
  });

  it('refuses a newer policyVersion', async () => {
    await expectErrors(json({ policyVersion: 2, name: 'future' }), [
      'policy.json: policyVersion 2 is newer than this agentcheckup reads (1). Update agentcheckup to use this policy.',
    ]);
  });

  it('refuses invalid JSON without echoing it', async () => {
    await expectErrors('{"policyVersion": 1, "name": "x",}', [
      'Policy file is not valid JSON (at position 33).',
    ]);
  });

  it('neutralizes hostile text in an error', async () => {
    const work = await setup({ ['evil\u001b]52;c;x\u0007\nname']: 1 });
    const { code, err } = await scan(work, ['--policy', 'policy.json']);
    expect(code).toBe(EXIT.usage);
    expect(err).toContain('Unknown field "evil<U+001B>]52;c;x<U+0007> name"');
    expect(err).not.toContain('\u001b');
    expect(err.split('\n')).toHaveLength(2);
  });

  it('refuses a missing file, a symlink and a file over 256 KiB', async () => {
    const work = await setup(ALLOW_NOTHING);
    const missing = await scan(work, ['--policy', 'nope.json']);
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.err).toBe(`Policy file not found: ${join(work, 'nope.json')}\n`);

    await writeFile(join(work, 'huge.json'), '');
    // Sparse: the size check needs no real data.
    await truncate(join(work, 'huge.json'), POLICY_MAX_BYTES + 1);
    const huge = await scan(work, ['--policy', 'huge.json']);
    expect(huge.code).toBe(EXIT.usage);
    expect(huge.err).toContain(`exceeds the ${POLICY_MAX_BYTES}-byte limit.`);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked policy file', async () => {
    const work = await setup(ALLOW_NOTHING);
    await symlink(join(work, 'policy.json'), join(work, 'link.json'));
    const { code, err } = await scan(work, ['--policy', 'link.json']);
    expect(code).toBe(EXIT.usage);
    expect(err).toBe(
      `Refusing to read policy file ${join(work, 'link.json')}: it is a symbolic link, not a regular file.\n`,
    );
  });

  it('refuses --config, and commands other than a scan', async () => {
    const work = await setup(ALLOW_NOTHING);
    const config = await scan(work, ['--policy', 'policy.json', '--config', 'x.json']);
    expect(config.code).toBe(EXIT.usage);
    expect(config.err).toContain(
      '--policy ignores configuration files, so it cannot be combined with --config.',
    );
    for (const command of ['context', 'fix']) {
      const io = capture(work);
      expect(await run([command, 'repo', '--policy', 'policy.json'], io)).toBe(EXIT.usage);
      expect(io.errors()).toContain(`--policy does not apply to the ${command} command.`);
    }
    // --no-config and --untrusted say what --policy implies.
    const [code] = await scanReport(work, [
      '--policy',
      'policy.json',
      '--no-config',
      '--untrusted',
    ]);
    expect(code).toBe(EXIT.findings);
  });

  it('reports the SHA-256 of the file bytes, which shasum prints', async () => {
    const work = await setup(ALLOW_NOTHING);
    const bytes = await readFile(join(work, 'policy.json'));
    const [, report] = await scanReport(work, ['--policy', 'policy.json']);
    expect(report.policy?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    // Formatting is part of the file: the digest names exactly this file.
    await writeFile(join(work, 'policy.json'), JSON.stringify(JSON.parse(bytes.toString())));
    const [, compact] = await scanReport(work, ['--policy', 'policy.json']);
    expect(compact.policy?.sha256).not.toBe(report.policy?.sha256);
    expect(report.policy?.insideScanRoot).toBe(false);
  });

  it('notes a policy file inside the scanned directory', async () => {
    const work = await setup(ALLOW_NOTHING);
    await writeFile(join(work, 'repo', 'policy.json'), policyOf(ALLOW_NOTHING));
    const [, report] = await scanReport(work, ['--policy', 'repo/policy.json']);
    expect(report.policy?.insideScanRoot).toBe(true);
    expect(report.policy?.notes.map((note) => note.id)).toEqual(['policy-inside-scan-root']);
  });
});

// ---------------------------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------------------------

describe('the repository cannot hide a violation', () => {
  it('ignores its configuration, ignore entries, directives and .gitignore', async () => {
    const work = await setup(
      { ...ALLOW_NOTHING, permissions: { denyCommands: ['curl'] } },
      {
        ...REPO,
        'agentcheckup.config.json': json({
          targets: ['cursor'],
          ignore: ['.mcp.json', '.claude/**'],
          rules: { 'mcp/unpinned-package': 'off' },
        }),
        '.gitignore': '.mcp.json\n.claude/\n',
        'CLAUDE.md':
          '<!-- agentcheckup-disable-file mcp/unpinned-package -- hidden on purpose -->\n\n# Project\n',
      },
    );
    // A trusted scan honors all of it: the server and the grant are out of sight.
    const [, trusted] = await scanReport(work, ['--fail-on', 'none']);
    expect(trusted.inventory.mcpServers).toEqual([]);

    const [code, report] = await scanReport(work, ['--policy', 'policy.json']);
    expect(code).toBe(EXIT.findings);
    expect(report.policy?.violations.map((violation) => violation.check)).toEqual([
      'mcp-not-allowed',
      'denied-tool',
    ]);
  });

  it('checks every agent the budgets name, whatever --targets says', async () => {
    const work = await setup({ budgets: { 'claude-code': { startupTokens: 1 } } });
    // --context with every target reuses the scan's plans; otherwise a second scan plans them.
    for (const extra of [
      ['--targets', 'cursor'],
      ['--targets', 'cursor', '--context'],
      ['--context'],
    ]) {
      const [code, report] = await scanReport(work, ['--policy', 'policy.json', ...extra]);
      expect(code).toBe(EXIT.findings);
      expect(report.policy?.violations.map((violation) => violation.message)).toEqual([
        'Claude Code loads ≈9 tokens at session start in ./ (policy limit ≈1).',
      ]);
    }
  });

  it('evaluates a required hook and says it is not enforced', async () => {
    const work = await setup({ hooks: { require: [{ agent: 'claude-code', event: 'Stop' }] } });
    const [, report] = await scanReport(work, ['--policy', 'policy.json']);
    expect(report.policy?.violations[0]?.message).toBe(
      `The policy requires a Claude Code Stop hook, and none is configured. ${HOOKS_NOT_ENFORCED}`,
    );
    const { out } = await scan(work, ['--policy', 'policy.json', '--format', 'markdown']);
    expect(out).toContain('Configured, not enforced');
  });
});

describe('violations are not findings', () => {
  it('leaves the findings, the summary and the score as an untrusted scan has them', async () => {
    const work = await setup({ ...ALLOW_NOTHING, mcp: { allow: [], requirePin: true } });
    const [, plain] = await scanReport(work, ['--untrusted', '--fail-on', 'none']);
    const [, checked] = await scanReport(work, ['--policy', 'policy.json', '--fail-on', 'none']);
    expect(checked.policy?.violations.length).toBeGreaterThan(0);
    expect(checked.findings).toEqual(plain.findings);
    expect(checked.summary).toEqual(plain.summary);
    expect(checked.score).toEqual(plain.score);
    expect(checked.findings.some((finding) => finding.ruleId.startsWith('policy'))).toBe(false);
  });
});
