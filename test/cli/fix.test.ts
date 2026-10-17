import { readFileSync } from 'node:fs';
import { readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIX_HELP } from '../../src/cli/help.js';
import { EXIT, type Io, type Prompt, run } from '../../src/cli/run.js';
import type { FixReport } from '../../src/fix/index.js';
import type * as Rules from '../../src/rules/index.js';
import { capture, type Captured, removeTempDirs, tempDir, writeFiles } from './helpers.js';
import { ROTATE } from './fix-rules.js';

// The built-in rules plus test-only rules that attach fixes (see fix-rules.ts). The test rule
// with the id mcp/literal-secret stands in for the built-in one, which emits no fix yet.
vi.mock('../../src/rules/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Rules>();
  const { FIX_TEST_RULES } = await import('./fix-rules.js');
  return {
    ...actual,
    builtinRules: [
      ...actual.builtinRules.filter((rule) => rule.meta.id !== 'mcp/literal-secret'),
      ...FIX_TEST_RULES,
    ],
  };
});

afterEach(removeTempDirs);

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile<FixReport>(
  JSON.parse(
    readFileSync(new URL('../../schemas/fix.schema.json', import.meta.url), 'utf8'),
  ) as object,
);

function parseReport(text: string): FixReport {
  const value: unknown = JSON.parse(text);
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
  return value as FixReport;
}

/** AGENTS.md without a heading and without "Reviewed.": one safe and one review fix. */
const UNFIXED = 'Use pnpm.\n';
const SAFE_FIXED = '# Agents\n\nUse pnpm.\n';
const ALL_FIXED = '# Agents\n\nUse pnpm.\nReviewed.\n';

async function repo(files: Record<string, string> = { 'AGENTS.md': UNFIXED }): Promise<string> {
  const root = await tempDir();
  await writeFiles(root, files);
  return root;
}

async function text(root: string, path: string): Promise<string> {
  return readFile(join(root, ...path.split('/')), 'utf8');
}

interface Scripted extends Prompt {
  readonly questions: string[];
}

/** Answers in order; undefined (or running out) is the end of input. */
function scripted(answers: readonly (string | undefined)[], isTTY = true): Scripted {
  const queue = [...answers];
  const questions: string[] = [];
  return {
    isTTY,
    questions,
    ask: (question) => {
      questions.push(question);
      return Promise.resolve(queue.shift());
    },
  };
}

/** A terminal session: stdout and stdin are TTYs, color off. */
function terminal(cwd: string, prompt: Prompt | undefined, extra: Partial<Io> = {}): Captured {
  return { ...capture(cwd, { NO_COLOR: '1' }, true), prompt, ...extra };
}

async function fix(
  root: string,
  args: readonly string[],
  io: Captured = capture(root),
): Promise<{ code: number; io: Captured }> {
  const code = await run(['fix', ...args], io);
  return { code, io };
}

describe('agentcheckup fix: dry run', () => {
  it('shows every class of fix as a diff, changes nothing and exits 1', async () => {
    const root = await repo();
    const { code, io } = await fix(root, []);
    expect(code).toBe(EXIT.findings);
    const out = io.output();
    expect(out).toContain('safe    test/heading  Add "# Agents" as line 1 of AGENTS.md');
    expect(out).toContain('review  test/footer  Append "Reviewed." to AGENTS.md');
    expect(out).toContain(
      '--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1,4 @@\n+# Agents\n+\n Use pnpm.\n+Reviewed.\n',
    );
    expect(out).toContain('  note: Only a person can say this.');
    expect(out).toContain('Verified on an in-memory copy: 2 findings resolved, 0 new, 0 left.');
    expect(io.errors()).toBe('');
    expect(await text(root, 'AGENTS.md')).toBe(UNFIXED);
    expect(await readdir(root)).toEqual(['AGENTS.md']);
  });

  it('exits 0 when there is nothing to change', async () => {
    const root = await repo({ 'AGENTS.md': ALL_FIXED });
    const { code, io } = await fix(root, []);
    expect(code).toBe(EXIT.ok);
    expect(io.output()).toBe('Nothing to fix.\n');
  });

  it('counts the findings that need judgment, as agentcheckup tasks lists them', async () => {
    const root = await repo({
      'AGENTS.md': UNFIXED,
      // An import of a missing file: no fix, so a task.
      'GEMINI.md': '# Gemini\n\n@docs/missing.md\n',
      // A deprecated transport in an MCP file: no fix, but for the user, never a task.
      '.mcp.json':
        '{ "mcpServers": { "docs": { "type": "sse", "url": "https://x.example/sse" } } }\n',
    });
    const { code, io } = await fix(root, []);
    expect(code).toBe(EXIT.findings);
    expect(io.output()).toMatch(
      /\nVerified on an in-memory copy: 2 findings resolved, 0 new, \d+ left · 1 needs judgment: agentcheckup tasks\n$/,
    );

    const json = await fix(root, ['--format', 'json']);
    expect(json.io.output()).not.toContain('judgment');
    parseReport(json.io.output());
  });

  it('writes JSON that matches schemas/fix.schema.json', async () => {
    const root = await repo();
    const { code, io } = await fix(root, ['--format', 'json']);
    expect(code).toBe(EXIT.findings);
    const report = parseReport(io.output());
    expect(report.mode).toBe('dry-run');
    expect(report.fixes.map((entry) => [entry.ruleId, entry.class, entry.status])).toEqual([
      ['test/footer', 'review', 'planned'],
      ['test/heading', 'safe', 'planned'],
    ]);
    expect(report.files).toHaveLength(1);
    expect(report.files[0]).toMatchObject({ path: 'AGENTS.md', op: 'edit' });
    expect(report.verification).toEqual({ resolved: 2, remaining: 0, introduced: [] });
  });

  it('puts the path of the scanned directory in front of paths, as a scan does', async () => {
    const parent = await tempDir();
    await writeFiles(parent, { 'repo/AGENTS.md': UNFIXED });
    const io = capture(parent);
    expect(await run(['fix', 'repo', '--format', 'json'], io)).toBe(EXIT.findings);
    const report = parseReport(io.output());
    expect(report.pathBase).toBe('repo');
    expect(report.files[0]?.path).toBe('repo/AGENTS.md');
  });

  it('writes the report with --output through the safe writer', async () => {
    const root = await repo();
    const work = await tempDir();
    const { code, io } = await fix(root, ['--output', join(work, 'fixes.diff')]);
    expect(code).toBe(EXIT.findings);
    expect(io.out).toEqual([]);
    expect(await readFile(join(work, 'fixes.diff'), 'utf8')).toContain('+# Agents');

    await symlink(join(work, 'fixes.diff'), join(work, 'link.diff'));
    const refused = await fix(root, ['--output', join(work, 'link.diff')]);
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.io.errors()).toContain('it is a symbolic link');
  });

  it('works with --untrusted, which allows only a dry run', async () => {
    const root = await repo();
    const { code, io } = await fix(root, ['--untrusted']);
    expect(code).toBe(EXIT.findings);
    expect(io.output()).toContain('+# Agents');

    for (const args of [
      ['--untrusted', '--write'],
      ['--untrusted', '-i'],
    ]) {
      const refused = await fix(root, args, terminal(root, scripted([])));
      expect(refused.code).toBe(EXIT.usage);
      expect(refused.io.errors()).toContain('--untrusted allows only a dry run');
    }
    expect(await text(root, 'AGENTS.md')).toBe(UNFIXED);
  });

  it('exits 3 when a rule crashes', async () => {
    const root = await repo({ 'AGENTS.md': 'CRASH\n' });
    const { code, io } = await fix(root, []);
    expect(code).toBe(EXIT.internal);
    expect(io.errors()).toContain('Rule test/crash crashed: test rule crashed');
  });
});

describe('agentcheckup fix --rule', () => {
  it('plans only the fixes of the named rules', async () => {
    const root = await repo();
    const { code, io } = await fix(root, ['--rule', 'test/heading']);
    expect(code).toBe(EXIT.findings);
    expect(io.output()).toContain('test/heading');
    expect(io.output()).not.toContain('test/footer');
  });

  it('exits 2 for an unknown rule id or an empty list', async () => {
    const root = await repo();
    const unknown = await fix(root, ['--rule', 'test/heading,nope/rule,other/x']);
    expect(unknown.code).toBe(EXIT.usage);
    expect(unknown.io.errors()).toContain(
      '--rule: unknown rule "nope/rule", "other/x". Run "agentcheckup rules"',
    );
    expect(unknown.io.errors()).toContain('agentcheckup fix --help');

    const empty = await fix(root, ['--rule', ' , ']);
    expect(empty.code).toBe(EXIT.usage);
    expect(empty.io.errors()).toContain('--rule needs at least one rule id');
  });

  it('fixes mcp/literal-secret only when the rule is named, and redacts the credential', async () => {
    const files = { 'AGENTS.md': '# Agents\n\ntoken: s3cr3t-value-123\nReviewed.\n' };
    const root = await repo(files);

    const unnamed = await fix(root, []);
    expect(unnamed.code).toBe(EXIT.ok);
    expect(unnamed.io.output()).not.toContain('mcp/literal-secret');

    const named = await fix(root, ['--rule', 'mcp/literal-secret']);
    expect(named.code).toBe(EXIT.findings);
    expect(named.io.output()).toContain(`!! ${ROTATE}`);
    expect(named.io.output()).not.toContain('s3cr3t-value-123');

    const review = await fix(root, ['--write', '--review']);
    expect(review.code).toBe(EXIT.ok);
    expect(await text(root, 'AGENTS.md')).toBe(files['AGENTS.md']);

    const written = await fix(root, ['--write', '--review', '--rule', 'mcp/literal-secret']);
    expect(written.code).toBe(EXIT.ok);
    expect(written.io.output()).not.toContain('s3cr3t-value-123');
    expect(await text(root, 'AGENTS.md')).toBe('# Agents\n\ntoken: ${TOKEN}\nReviewed.\n');
  });
});

describe('agentcheckup fix --write', () => {
  it('applies the safe fixes, re-scans from disk and exits 0', async () => {
    const root = await repo();
    const { code, io } = await fix(root, ['--write']);
    expect(code).toBe(EXIT.ok);
    expect(await text(root, 'AGENTS.md')).toBe(SAFE_FIXED);
    const out = io.output();
    expect(out).toContain('Verified on an in-memory copy: 1 finding resolved, 0 new, 1 left.');
    expect(out).toContain(
      'Applied 1 fix to 1 file. Re-scanned: 1 finding resolved, 0 new, 1 left.',
    );
    expect(out).toContain('Review the changes with git status and git diff.');
    expect(io.errors()).toBe('');
    expect(await readdir(root)).toEqual(['AGENTS.md']);
  });

  it('applies review fixes too with --review, and a second run finds nothing', async () => {
    const root = await repo();
    const { code, io } = await fix(root, ['--write', '--review', '--format', 'json']);
    expect(code).toBe(EXIT.ok);
    expect(await text(root, 'AGENTS.md')).toBe(ALL_FIXED);
    const report = parseReport(io.output());
    expect(report.mode).toBe('write');
    expect(report.fixes.map((entry) => entry.status)).toEqual(['applied', 'applied']);
    expect(report.verification).toEqual({ resolved: 2, remaining: 0, introduced: [] });

    const again = await fix(root, []);
    expect(again.code).toBe(EXIT.ok);
    expect(again.io.output()).toBe('Nothing to fix.\n');
    const scan = capture(root);
    expect(await run(['--format', 'json'], scan)).toBe(EXIT.ok);
    expect((JSON.parse(scan.output()) as { findings: unknown[] }).findings).toEqual([]);
  });

  it('creates and renames files, making missing directories', async () => {
    const root = await repo({
      'AGENTS.md': '# Agents\n\nSee the notes.\nReviewed.\n',
      'old/AGENTS.md': '# Old\n\nReviewed.\n',
    });
    const { code, io } = await fix(root, ['--write']);
    expect(code).toBe(EXIT.ok);
    expect(io.output()).toContain('Applied 2 fixes to 2 files.');
    expect(await text(root, 'docs/agents-notes.md')).toBe('# Notes\n');
    expect(await text(root, 'new/AGENTS.md')).toBe('# Old\n\nReviewed.\n');
    expect(await readdir(join(root, 'old'))).toEqual([]);
  });

  it('exits 2 for --review without --write', async () => {
    const root = await repo();
    const { code, io } = await fix(root, ['--review']);
    expect(code).toBe(EXIT.usage);
    expect(io.errors()).toContain('--review needs --write');
  });

  it('skips a file that changed since the scan and exits 1 with the reason', async () => {
    const root = await repo();
    const io: Captured = {
      ...capture(root),
      beforeWrite: () => writeFile(join(root, 'AGENTS.md'), 'Use npm.\n'),
    };
    const { code } = await fix(root, ['--write'], io);
    expect(code).toBe(EXIT.findings);
    expect(await text(root, 'AGENTS.md')).toBe('Use npm.\n');
    expect(io.output()).toContain('No fixes applied.');
    expect(io.output()).toContain(
      'Not applied: 1 fix\n  safe    test/heading  Add "# Agents" as line 1 of AGENTS.md: the file changed since the scan',
    );
    expect(io.errors()).toContain('Not written AGENTS.md:');

    const json = await repo();
    const jsonIo: Captured = {
      ...capture(json),
      beforeWrite: () => writeFile(join(json, 'AGENTS.md'), 'Use npm.\n'),
    };
    expect((await fix(json, ['--write', '--format', 'json'], jsonIo)).code).toBe(EXIT.findings);
    const report = parseReport(jsonIo.output());
    expect(report.fixes[0]).toMatchObject({ status: 'skipped', reason: 'changed-since-scan' });
    expect(report.files).toEqual([]);
  });

  it('exits 1 when the scan from disk finds a new warning', async () => {
    const root = await repo();
    const io: Captured = {
      ...capture(root),
      beforeWrite: () => writeFiles(root, { 'pkg/AGENTS.md': 'Use yarn.\nReviewed.\n' }),
    };
    const { code } = await fix(root, ['--write'], io);
    expect(code).toBe(EXIT.findings);
    expect(await text(root, 'AGENTS.md')).toBe(SAFE_FIXED);
    expect(io.output()).toContain('new warning  pkg/AGENTS.md:1  test/heading');
  });

  it('writes nothing when a rule crashes', async () => {
    const root = await repo({ 'AGENTS.md': 'CRASH\n' });
    const { code, io } = await fix(root, ['--write']);
    expect(code).toBe(EXIT.internal);
    expect(io.errors()).toContain('No fixes were written');
    expect(await text(root, 'AGENTS.md')).toBe('CRASH\n');
  });

  it('exits 0 with nothing to write', async () => {
    const root = await repo({ 'AGENTS.md': ALL_FIXED });
    const { code, io } = await fix(root, ['--write']);
    expect(code).toBe(EXIT.ok);
    expect(io.output()).toBe('No fixes applied.\n');
  });
});

describe('agentcheckup fix -i', () => {
  it('needs a terminal on stdin and stdout', async () => {
    const root = await repo();
    const cases: Captured[] = [
      capture(root),
      terminal(root, undefined),
      terminal(root, scripted(['y'], false)),
      { ...capture(root), prompt: scripted(['y']) },
    ];
    for (const io of cases) {
      expect(await run(['fix', '-i'], io)).toBe(EXIT.usage);
      expect(io.errors()).toContain('-i needs a terminal');
    }
    expect(await text(root, 'AGENTS.md')).toBe(UNFIXED);
  });

  it('takes Enter as yes for a safe fix and no for a review fix', async () => {
    const root = await repo();
    const prompt = scripted(['', '']);
    const io = terminal(root, prompt);
    expect(await run(['fix', '-i'], io)).toBe(EXIT.ok);
    expect(await text(root, 'AGENTS.md')).toBe(SAFE_FIXED);
    expect(prompt.questions).toEqual([
      '(1/2) Apply? [y]es [n]o [d]iff [q]uit (Enter: no) ',
      '(2/2) Apply? [y]es [n]o [d]iff [a]lternatives [q]uit (Enter: yes) ',
    ]);
    const out = io.output();
    expect(out).toContain('review  test/footer  Append "Reviewed." to AGENTS.md\n--- a/AGENTS.md');
    expect(out).toContain('Applied 1 fix to 1 file.');
    expect(out).toContain('Not applied: 1 fix\n  review  test/footer');
    expect(out).toContain(': declined');
  });

  it('shows the diff again, accepts yes and no in any case, and re-asks after a bad answer', async () => {
    const root = await repo();
    const prompt = scripted(['d', 'maybe', 'YES', 'n']);
    const io = terminal(root, prompt);
    expect(await run(['fix', '-i'], io)).toBe(EXIT.ok);
    expect(await text(root, 'AGENTS.md')).toBe('Use pnpm.\nReviewed.\n');
    expect(prompt.questions).toHaveLength(4);
    const out = io.output();
    expect(out.split('+Reviewed.').length).toBe(4);
    expect(out).toContain('Answer y, n, d or q.');
  });

  it('applies an alternative in place of the rule fix', async () => {
    const root = await repo();
    const prompt = scripted(['n', 'a', '', 'a', '7', 'x', '1']);
    const io = terminal(root, prompt);
    expect(await run(['fix', '-i'], io)).toBe(EXIT.ok);
    expect(await text(root, 'AGENTS.md')).toBe('# Project\n\nUse pnpm.\n');
    const out = io.output();
    expect(out).toContain('Alternatives:\n  1  review  Add "# Project" as line 1 of AGENTS.md\n');
    expect(out).toContain('Answer a number from 1 to 1.');
    expect(out).toContain('Using: Add "# Project" as line 1 of AGENTS.md');
    expect(out).toContain('Applied 1 fix to 1 file.');
    expect(prompt.questions.filter((question) => question.startsWith('Use which'))).toHaveLength(4);
  });

  it('says so when a fix has no alternatives', async () => {
    const root = await repo();
    const io = terminal(root, scripted(['a', 'y', 'n']));
    expect(await run(['fix', '-i'], io)).toBe(EXIT.ok);
    expect(io.output()).toContain('This fix has no alternatives.');
    expect(await text(root, 'AGENTS.md')).toBe('Use pnpm.\nReviewed.\n');
  });

  it('stops asking on quit and writes what was accepted', async () => {
    const root = await repo();
    const io = terminal(root, scripted(['y', 'q']));
    expect(await run(['fix', '-i'], io)).toBe(EXIT.ok);
    expect(await text(root, 'AGENTS.md')).toBe('Use pnpm.\nReviewed.\n');

    const none = await repo();
    const quit = terminal(none, scripted(['q']));
    expect(await run(['fix', '-i'], quit)).toBe(EXIT.ok);
    expect(quit.output()).toContain('No fixes applied.');
    expect(await text(none, 'AGENTS.md')).toBe(UNFIXED);
  });

  it('writes nothing when input ends', async () => {
    for (const answers of [['y'], ['a'], ['n', 'a']]) {
      const root = await repo();
      const io = terminal(root, scripted(answers));
      expect(await run(['fix', '-i'], io)).toBe(EXIT.findings);
      expect(io.errors()).toContain('Stopped: no files were changed.');
      expect(await text(root, 'AGENTS.md')).toBe(UNFIXED);
    }
  });

  it('offers mcp/literal-secret, which is not applied unless accepted', async () => {
    const root = await repo({ 'AGENTS.md': '# Agents\n\ntoken: s3cr3t-value-123\nReviewed.\n' });
    const io = terminal(root, scripted(['']));
    expect(await run(['fix', '-i'], io)).toBe(EXIT.ok);
    expect(io.output()).toContain('mcp/literal-secret');
    expect(io.output()).not.toContain('s3cr3t-value-123');
    expect(await text(root, 'AGENTS.md')).toContain('s3cr3t-value-123');

    const accepted = terminal(root, scripted(['y']));
    expect(await run(['fix', '-i'], accepted)).toBe(EXIT.ok);
    expect(await text(root, 'AGENTS.md')).toBe('# Agents\n\ntoken: ${TOKEN}\nReviewed.\n');
    expect(accepted.output()).toContain(`!! ${ROTATE}`);
  });

  it('writes JSON with --output, mode interactive', async () => {
    const root = await repo();
    const work = await tempDir();
    const noOutput = terminal(root, scripted([]));
    expect(await run(['fix', '-i', '--format', 'json'], noOutput)).toBe(EXIT.usage);
    expect(noOutput.errors()).toContain('needs --output');

    const io = terminal(root, scripted(['n', 'y']));
    const output = join(work, 'fix.json');
    expect(await run(['fix', '-i', '--format', 'json', '--output', output], io)).toBe(EXIT.ok);
    const report = parseReport(await readFile(output, 'utf8'));
    expect(report.mode).toBe('interactive');
    expect(report.fixes.map((entry) => [entry.ruleId, entry.status, entry.reason])).toEqual([
      ['test/heading', 'applied', undefined],
      ['test/footer', 'skipped', 'declined'],
    ]);
  });

  it('says there is nothing to fix', async () => {
    const root = await repo({ 'AGENTS.md': ALL_FIXED });
    const io = terminal(root, scripted([]));
    expect(await run(['fix', '-i'], io)).toBe(EXIT.ok);
    expect(io.output()).toBe('Nothing to fix.\nNo fixes applied.\n');
  });

  it('writes nothing when a rule crashes', async () => {
    const root = await repo({ 'AGENTS.md': 'CRASH\n' });
    const io = terminal(root, scripted(['y']));
    expect(await run(['fix', '-i'], io)).toBe(EXIT.internal);
    expect(await text(root, 'AGENTS.md')).toBe('CRASH\n');
  });
});

describe('agentcheckup fix -i: what is left', () => {
  // test/footer (review) is asked about first, test/heading (safe) second. test/todo has a
  // manual step; test/heading-name has one only once the heading fix is applied.
  const TODO = 'Use pnpm.\nTODO\n';
  const FOOTER = 'AGENTS.md:1 test/footer (Append "Reviewed." to AGENTS.md)';
  const HEADING = 'AGENTS.md:1 test/heading (Add "# Agents" as line 1 of AGENTS.md)';
  const HEADING_NAME = 'AGENTS.md:1 test/heading-name (name the project in the heading)';

  /** The "Left:" block of the summary, one entry per line without its lead. */
  function left(output: string): string[] {
    const lines = output.split('\n');
    const start = lines.findIndex((line) => line.startsWith('Left: '));
    if (start === -1) return [];
    const block = [lines[start] ?? ''];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith('      ')) break;
      block.push(line);
    }
    return block.map((line) => line.slice('Left: '.length));
  }

  async function session(answers: readonly string[]): Promise<{ root: string; io: Captured }> {
    const root = await repo({ 'AGENTS.md': TODO });
    const io = terminal(root, scripted(answers));
    expect(await run(['fix', '-i'], io)).toBe(EXIT.ok);
    return { root, io };
  }

  it('lists a declined fix and the steps the written files still need', async () => {
    const { root, io } = await session(['n', 'y']);
    expect(await text(root, 'AGENTS.md')).toBe('# Agents\n\nUse pnpm.\nTODO\n');
    expect(left(io.output())).toEqual([
      FOOTER,
      HEADING_NAME,
      'AGENTS.md:4 test/todo (resolve the TODO)',
    ]);
  });

  it('leaves out a step that only an unapplied fix would bring', async () => {
    const { root, io } = await session(['y', 'n']);
    expect(await text(root, 'AGENTS.md')).toBe('Use pnpm.\nTODO\nReviewed.\n');
    expect(left(io.output())).toEqual([HEADING, 'AGENTS.md:2 test/todo (resolve the TODO)']);
  });

  it('lists every finding as it was when every fix is declined or the user quits', async () => {
    for (const answers of [['n', 'n'], ['q']]) {
      const { root, io } = await session(answers);
      expect(await text(root, 'AGENTS.md')).toBe(TODO);
      expect(io.output()).toContain('No fixes applied.');
      expect(left(io.output())).toEqual([
        FOOTER,
        HEADING,
        'AGENTS.md:2 test/todo (resolve the TODO)',
      ]);
    }
  });

  it('lists nothing but the remaining manual steps when every fix is accepted', async () => {
    const { root, io } = await session(['y', 'y']);
    expect(await text(root, 'AGENTS.md')).toBe('# Agents\n\nUse pnpm.\nTODO\nReviewed.\n');
    expect(left(io.output())).toEqual([HEADING_NAME, 'AGENTS.md:4 test/todo (resolve the TODO)']);
  });

  it('writes the same steps to JSON', async () => {
    const root = await repo({ 'AGENTS.md': TODO });
    const output = join(await tempDir(), 'fix.json');
    const io = terminal(root, scripted(['y', 'n']));
    expect(await run(['fix', '-i', '--format', 'json', '--output', output], io)).toBe(EXIT.ok);
    const report = parseReport(await readFile(output, 'utf8'));
    expect(report.manual).toEqual([
      {
        ruleId: 'test/heading',
        path: 'AGENTS.md',
        line: 1,
        guidance: 'Add "# Agents" as line 1 of AGENTS.md',
      },
      { ruleId: 'test/todo', path: 'AGENTS.md', line: 2, guidance: 'resolve the TODO' },
    ]);
  });

  it('keeps to the rules named with --rule', async () => {
    const root = await repo({ 'AGENTS.md': TODO });
    const io = terminal(root, scripted(['n']));
    expect(await run(['fix', '-i', '--rule', 'test/heading'], io)).toBe(EXIT.ok);
    expect(left(io.output())).toEqual([HEADING]);
  });
});

describe('agentcheckup fix arguments', () => {
  it('prints its help', async () => {
    for (const args of [
      ['fix', '--help'],
      ['fix', '-h'],
    ]) {
      const io = capture();
      expect(await run(args, io)).toBe(EXIT.ok);
      expect(io.output()).toBe(FIX_HELP);
    }
    expect(FIX_HELP).toContain('[y]es [n]o [d]iff [a]lternatives');
  });

  it.each([
    [['fix', 'a', 'b'], '"fix" takes at most one path'],
    [['fix', '--fail-on', 'warn'], '--fail-on does not apply to the fix command'],
    [['fix', '--baseline', 'x.json'], '--baseline does not apply to the fix command'],
    [['fix', '--compact'], '--compact does not apply to the fix command'],
    [['fix', '--cwd', 'x'], '--cwd works only with the context command'],
    [['fix', '--format', 'sarif'], '--format must be one of: diff, json'],
    [['--write'], '--write works only with the fix command'],
    [['context', '--rule', 'x/y'], '--rule works only with the fix command'],
    [['context', '-i'], '--interactive works only with the fix command'],
  ])('%j exits 2', async (args, message) => {
    const io = capture();
    expect(await run(args, io)).toBe(EXIT.usage);
    expect(io.errors()).toContain(message);
  });

  it('explains the fix of a rule that has one', async () => {
    const io = capture();
    expect(await run(['explain', 'test/heading'], io)).toBe(EXIT.ok);
    expect(io.output()).toContain(
      'Fix:        safe, review (agentcheckup fix --rule test/heading)\n            Test fix.\n',
    );
  });
});
