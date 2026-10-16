import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT, run } from '../../src/cli/run.js';
import { scanSnapshot } from '../../src/core/engine.js';
import { walk } from '../../src/io/walk.js';
import { formatStylish, plainStyle } from '../../src/report/stylish.js';
import { builtinRules } from '../../src/rules/index.js';
import { capture, type Captured } from './helpers.js';

/** test/fixtures/smoke: findings whose files the root load plans skip. */
const SMOKE = fileURLToPath(new URL('../fixtures/smoke', import.meta.url));

const OSC8 = '\u001b]8;;https://';

async function scan(args: readonly string[], io: Captured = capture(SMOKE)): Promise<Captured> {
  expect(await run(args, io)).toBe(EXIT.findings);
  return io;
}

describe('detail levels of a scan', () => {
  it('shows what each agent misses and why by default', async () => {
    const out = (await scan([])).output();
    expect(out).toContain('What each agent misses\n  Claude Code');
    expect(out).toMatch(/^ +why {2}Claude Code never loads these/m);
    expect(out).not.toContain(OSC8);
  });

  it('keeps --compact as the stylish output from before levels existed', async () => {
    const io = await scan(['--compact']);
    const snapshot = await walk(SMOKE);
    const before = formatStylish(scanSnapshot(snapshot, { rules: builtinRules }), {
      style: plainStyle,
      level: 'compact',
    });
    expect(io.output()).toBe(before);
    expect(io.output()).not.toContain('What each agent misses');
    expect(io.output()).not.toMatch(/^ +why {2}/m);
  });

  it('adds rationale and sources with --verbose', async () => {
    const out = (await scan(['--verbose'])).output();
    expect(out).toContain('What each agent misses');
    expect(out).toMatch(/^ +source {2}\S/m);
    expect(out).toMatch(/^ +docs {4}https:\/\/github\.com\/mustafakbaser\/agentcheckup\//m);
  });

  it('exits 2 for --compact with --verbose, and for either with context', async () => {
    for (const args of [
      ['--compact', '--verbose'],
      ['context', '--compact'],
      ['context', '--verbose'],
    ]) {
      const io = capture(SMOKE);
      expect(await run(args, io)).toBe(EXIT.usage);
      expect(io.errors()).toMatch(/--compact and --verbose cannot be combined|context command/);
    }
  });

  it('links rule ids only with color on a terminal', async () => {
    const tty = await scan([], capture(SMOKE, { FORCE_COLOR: '1' }, true));
    expect(tty.output()).toContain(`${OSC8}github.com/mustafakbaser/agentcheckup/blob/main/docs/`);

    const piped = await scan([], capture(SMOKE, { FORCE_COLOR: '1' }, false));
    expect(piped.output()).toContain('\u001b[');
    expect(piped.output()).not.toContain(OSC8);

    const plain = await scan(['--no-color'], capture(SMOKE, {}, true));
    expect(plain.output()).not.toContain('\u001b');
  });

  it('adds the impact table to markdown and the Docs line to github, except with --compact', async () => {
    const markdown = (await scan(['--format', 'markdown'])).output();
    expect(markdown).toContain('### What each agent misses');
    const compactMarkdown = (await scan(['--format', 'markdown', '--compact'])).output();
    expect(compactMarkdown).not.toContain('What each agent misses');

    const github = (await scan(['--format', 'github'])).output();
    expect(github).toContain('%0ADocs: https://github.com/mustafakbaser/agentcheckup/');
    const compactGithub = (await scan(['--format', 'github', '--compact'])).output();
    expect(compactGithub).not.toContain('%0ADocs:');
  });

  it('leaves JSON and SARIF without plans unless --context', async () => {
    for (const format of ['json', 'sarif']) {
      const plain = (await scan(['--format', format])).output();
      const verbose = (await scan(['--format', format, '--verbose'])).output();
      expect(verbose).toBe(plain);
    }
    const json = JSON.parse((await scan(['--format', 'json'])).output()) as object;
    expect(json).not.toHaveProperty('context');
    const context = JSON.parse((await scan(['--format', 'json', '--context'])).output()) as object;
    expect(context).toHaveProperty('context');
  });
});

describe('explain', () => {
  it('says when a rule has no automatic fix', async () => {
    const io = capture();
    expect(await run(['explain', 'instr/claude-md-too-long'], io)).toBe(EXIT.ok);
    expect(io.output()).toContain('\nFix:        No automatic fix; guidance only\n\n');
  });
});
