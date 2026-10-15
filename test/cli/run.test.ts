import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, exitCodeFor, run, type Io } from '../../src/cli/run.js';
import { scanSnapshot } from '../../src/core/engine.js';
import { VERSION } from '../../src/core/version.js';
import { snapshotFrom } from '../helpers/lint.js';
import { builtinRules } from '../../src/rules/index.js';

const SMOKE = fileURLToPath(new URL('../fixtures/smoke', import.meta.url));

interface Captured extends Io {
  readonly out: string[];
  readonly err: string[];
}

function capture(cwd = process.cwd(), env: Record<string, string> = {}): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    cwd,
    env,
    isTTY: false,
  };
}

let work: string;
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'agentcheckup-cli-'));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('run', () => {
  it('prints help and version', async () => {
    const help = capture();
    expect(await run(['--help'], help)).toBe(EXIT.ok);
    expect(help.out.join('')).toContain('Usage: agentcheckup [path] [options]');

    const version = capture();
    expect(await run(['--version'], version)).toBe(EXIT.ok);
    expect(version.out.join('')).toBe(`${VERSION}\n`);
  });

  it('returns 2 with a hint on usage errors', async () => {
    const io = capture();
    expect(await run(['--format', 'xml'], io)).toBe(EXIT.usage);
    expect(io.err.join('')).toContain('--format must be one of');
    expect(io.err.join('')).toContain('agentcheckup --help');
  });

  it('returns 2 when the path does not exist', async () => {
    const io = capture();
    expect(await run([join(work, 'missing')], io)).toBe(EXIT.usage);
    expect(io.err.join('')).not.toBe('');
  });

  it('reports no configuration for an empty directory and exits 0', async () => {
    const io = capture(work);
    expect(await run([], io)).toBe(EXIT.ok);
    expect(io.out.join('')).toContain('No agent configuration files found');
  });

  it('scans the smoke fixture, fails on errors, and writes JSON to a file', async () => {
    const io = capture();
    const output = join(work, 'report.json');
    expect(await run([SMOKE, '--format', 'json', '--output', output], io)).toBe(EXIT.findings);
    expect(io.out).toEqual([]);
    const report = JSON.parse(await readFile(output, 'utf8')) as {
      findings: { ruleId: string; path: string }[];
    };
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it('rebases paths onto the working directory', async () => {
    const io = capture(join(SMOKE, '..'));
    await run(['smoke', '--format', 'json'], io);
    const report = JSON.parse(io.out.join('')) as { findings: { path: string }[] };
    expect(report.findings.every((finding) => finding.path.startsWith('smoke/'))).toBe(true);
  });

  it('honors --fail-on none and --min-score', async () => {
    expect(await run([SMOKE, '--fail-on', 'none', '--format', 'json'], capture())).toBe(EXIT.ok);
    expect(
      await run([SMOKE, '--fail-on', 'none', '--min-score', '100', '--format', 'json'], capture()),
    ).toBe(EXIT.findings);
  });

  it('loads agentcheckup.config.json and rejects invalid configs', async () => {
    await writeFile(join(work, 'AGENTS.md'), '# Project\n\nUse pnpm.\n');
    await writeFile(join(work, 'agentcheckup.config.json'), '{"targets": ["vim"]}');
    const io = capture(work);
    expect(await run([], io)).toBe(EXIT.usage);
    expect(io.err.join('')).toContain('agentcheckup.config.json');

    await writeFile(join(work, 'agentcheckup.config.json'), '{ not json');
    const broken = capture(work);
    expect(await run([], broken)).toBe(EXIT.usage);
    expect(broken.err.join('')).toContain('not valid JSON');

    // --untrusted ignores the repository's config entirely.
    expect(await run(['--untrusted'], capture(work))).toBe(EXIT.ok);
  });

  it('fails clearly when an explicit --config does not exist', async () => {
    const io = capture(work);
    expect(await run(['--config', 'nope.json'], io)).toBe(EXIT.usage);
    expect(io.err.join('')).toContain('Config file not found');
  });

  it('prints a badge', async () => {
    const io = capture();
    await run([SMOKE, '--format', 'badge'], io);
    // The alt text carries the score, so screen readers announce it.
    expect(io.out.join('')).toMatch(
      /^\[!\[agent config: \d{1,3}\/100\]\(https:\/\/img\.shields\.io\//,
    );
  });

  it('lists and explains rules', async () => {
    const list = capture();
    expect(await run(['rules'], list)).toBe(EXIT.ok);
    expect(list.out.join('')).toContain('directive/missing-reason');

    const json = capture();
    await run(['rules', '--json'], json);
    expect(Array.isArray(JSON.parse(json.out.join('')))).toBe(true);

    const explain = capture();
    expect(await run(['explain', 'directive/unused'], explain)).toBe(EXIT.ok);
    expect(explain.out.join('')).toContain('Sources:');

    const unknown = capture();
    expect(await run(['explain', 'nope/nope'], unknown)).toBe(EXIT.usage);
  });

  it('sanitizes untrusted text in error messages', async () => {
    const io = capture();
    await run(['explain', 'x\u001b[2Jy'], io);
    expect(io.err.join('')).not.toContain('\u001b');
  });
});

describe('exitCodeFor', () => {
  const clean = scanSnapshot(snapshotFrom({ 'AGENTS.md': '# ok\n' }), { rules: builtinRules });

  it('is 0 for a clean result and 3 when a rule crashed', () => {
    expect(exitCodeFor(clean, 'error', undefined)).toBe(EXIT.ok);
    expect(
      exitCodeFor(
        { ...clean, ruleFailures: [{ ruleId: 'x/y', message: 'boom' }] },
        'error',
        undefined,
      ),
    ).toBe(EXIT.internal);
  });

  it('ignores a missing score for --min-score', () => {
    const empty = scanSnapshot(snapshotFrom({ 'README.md': '# hi\n' }), {
      rules: builtinRules,
    });
    expect(exitCodeFor(empty, 'error', 90)).toBe(EXIT.ok);
  });
});
