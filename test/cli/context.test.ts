import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTEXT_HELP } from '../../src/cli/help.js';
import { contextExitCode, EXIT, run } from '../../src/cli/run.js';
import type { ScanResult } from '../../src/core/engine.js';
import { scanSnapshot } from '../../src/core/engine.js';
import { builtinRules } from '../../src/rules/index.js';
import { snapshotFrom } from '../helpers/lint.js';
import { capture, CONTEXT_FIXTURE, removeTempDirs, tempDir, writeFiles } from './helpers.js';

afterEach(removeTempDirs);

interface Report {
  readonly schemaVersion: number;
  readonly findings: readonly { readonly ruleId: string; readonly path: string }[];
  readonly inventory: { readonly mcpServers: readonly { readonly id: string }[] };
  readonly context?: {
    readonly agents: readonly string[];
    readonly plans: readonly {
      readonly agent: string;
      readonly cwd: string;
      readonly entries: readonly { readonly path: string; readonly trigger: string }[];
      readonly assumptions: readonly { readonly key: string; readonly value: unknown }[];
      readonly limits: readonly {
        readonly key: string;
        readonly subject: string;
        readonly label?: string;
      }[];
    }[];
    readonly matrix?: { readonly rows: readonly { readonly path: string }[] };
  };
  readonly targets: readonly string[];
}

async function contextJson(args: readonly string[], cwd = CONTEXT_FIXTURE): Promise<Report> {
  const io = capture(cwd);
  expect(await run(['context', ...args, '--format', 'json'], io)).toBe(EXIT.ok);
  return JSON.parse(io.output()) as Report;
}

describe('agentcheckup context', () => {
  it('prints the plan of every modeled agent at the root, and exits 0 despite errors', async () => {
    const io = capture(CONTEXT_FIXTURE);
    expect(await run(['context'], io)).toBe(EXIT.ok);
    const text = io.output();
    expect(text).toContain('Claude Code context · ./\n');
    expect(text).toContain('Codex context · ./\n');
    expect(text).toContain('Cursor context · ./\n');
    expect(text).toMatch(/^ {3}1 {2}AGENTS\.md +271 +68$/m);
    expect(text).toContain('\nSkipped\n');
    expect(text).toContain('≈tokens = characters ÷ 4');
    // The fixture has error findings; they never fail the context command.
    expect(text).not.toContain('Since the baseline');
    expect(io.errors()).toBe('');
  });

  it('plans a session started in a subdirectory with --cwd', async () => {
    const io = capture(CONTEXT_FIXTURE);
    expect(await run(['context', '--cwd', 'packages/api'], io)).toBe(EXIT.ok);
    const text = io.output();
    expect(text).toContain('Claude Code context · packages/api\n');
    expect(text).toContain('Codex context · packages/api\n');
    expect(text).toMatch(/^ {2}\d {2}packages\/api\/CLAUDE\.md /m);
    expect(text).toMatch(/^ {2}1 {2}packages\/api\/AGENTS\.override\.md /m);

    const report = await contextJson(['--cwd', './packages/api/']);
    expect(report.context?.plans.map((plan) => [plan.agent, plan.cwd])).toEqual([
      ['claude-code', 'packages/api'],
      ['codex', 'packages/api'],
      ['cursor', 'packages/api'],
    ]);
  });

  it('names the scanned directory once and shows paths relative to it', async () => {
    const io = capture(join(CONTEXT_FIXTURE, '..'));
    expect(await run(['context', 'context', '--cwd', 'packages/api'], io)).toBe(EXIT.ok);
    const text = io.output();
    expect(
      text.startsWith('Paths are relative to context\n\nClaude Code context · packages/api\n'),
    ).toBe(true);
    expect(text).toMatch(/^ {2}2 {2}packages\/api\/CLAUDE\.md +82 +21$/m);
    expect(text).not.toContain('context/packages/');
  });

  it('rebases JSON paths, limit subjects included, and keeps limit labels as words', async () => {
    const report = await contextJson(
      ['context', '--cwd', 'packages/api'],
      join(CONTEXT_FIXTURE, '..'),
    );
    const codex = report.context?.plans.find((plan) => plan.agent === 'codex');
    expect(codex?.cwd).toBe('context/packages/api');
    expect(codex?.limits).toContainEqual(
      expect.objectContaining({
        key: 'codex.project_doc_max_bytes',
        subject: 'context/packages/api',
        label: 'AGENTS.md chain',
      }),
    );
    const root = await contextJson(
      ['context', '--agent', 'claude-code'],
      join(CONTEXT_FIXTURE, '..'),
    );
    expect(root.context?.plans[0]?.limits).toContainEqual(
      expect.objectContaining({
        key: 'claude-code.skill_listing_budget',
        subject: 'context',
        label: 'skills listing',
      }),
    );
  });

  it('plans only the agents named with --agent', async () => {
    const io = capture(CONTEXT_FIXTURE);
    expect(await run(['context', '--agent', 'codex'], io)).toBe(EXIT.ok);
    expect(io.output()).toContain('Codex context · ./\n');
    expect(io.output()).not.toContain('Claude Code context');
    expect(io.output()).not.toContain('Cursor context');

    const report = await contextJson(['--agent', 'cursor,claude-code']);
    expect(report.context?.agents).toEqual(['claude-code', 'cursor']);
  });

  it('prints the matrix with --matrix', async () => {
    const io = capture(CONTEXT_FIXTURE);
    expect(await run(['context', '--matrix'], io)).toBe(EXIT.ok);
    const text = io.output();
    expect(text).toMatch(/^Files by agent +Claude Code {3}Codex {7}Cursor$/m);
    expect(text).toMatch(/^AGENTS\.md +startup +startup +startup$/m);
    expect(text).toMatch(/^packages\/api\/AGENTS\.override\.md +— +start-dir +—$/m);
    expect(text).toMatch(/^start-dir {7}loaded when a session starts in its directory$/m);

    const report = await contextJson(['--matrix']);
    expect(report.context?.matrix?.rows.length).toBeGreaterThan(10);
    // The root for every agent, then Codex in each directory with an AGENTS.md.
    expect(report.context?.plans.filter((plan) => plan.cwd === '')).toHaveLength(3);
    expect(report.context?.plans.map((plan) => plan.cwd)).toContain('services/billing/ledger');
  });

  it('emits the ScanResult shape with context as JSON', async () => {
    const report = await contextJson([]);
    expect(report.schemaVersion).toBe(1);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.inventory.mcpServers.map((server) => server.id)).toContain(
      'mcp:.mcp.json#filesystem',
    );
    expect(report.context?.agents).toEqual(['claude-code', 'codex', 'cursor']);
    expect(report.context?.matrix).toBeUndefined();
  });

  it('passes --context-window to the plans', async () => {
    const report = await contextJson(['--agent', 'codex', '--context-window', '1000']);
    expect(report.context?.plans[0]?.assumptions).toContainEqual(
      expect.objectContaining({ key: 'codex.context_window', value: 1000 }),
    );
  });

  it('prints Markdown tables', async () => {
    const io = capture(CONTEXT_FIXTURE);
    expect(await run(['context', '--format', 'markdown', '--agent', 'claude-code'], io)).toBe(
      EXIT.ok,
    );
    const text = io.output();
    expect(text).toContain('| # | File |');
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it('writes to --output without color and prints nothing', async () => {
    const work = await tempDir();
    const io = capture(CONTEXT_FIXTURE, { FORCE_COLOR: '1' }, true);
    const output = join(work, 'plans.txt');
    expect(await run(['context', '--output', output], io)).toBe(EXIT.ok);
    expect(io.out).toEqual([]);
    const text = await readFile(output, 'utf8');
    expect(text).toContain('Claude Code context');
    expect(text).not.toContain('\u001b[');
  });

  it('colors terminal output when asked to', async () => {
    const io = capture(CONTEXT_FIXTURE);
    await run(['context', '--color'], io);
    expect(io.output()).toContain('\u001b[1m');
  });

  it('prints its own help', async () => {
    const io = capture();
    expect(await run(['context', '--help'], io)).toBe(EXIT.ok);
    expect(io.output()).toBe(CONTEXT_HELP);
    expect(CONTEXT_HELP).toContain('Usage: agentcheckup context [path] [options]');
    for (const flag of [
      '--agent',
      '--cwd',
      '--matrix',
      '--context-window',
      '--baseline',
      '--gate',
    ]) {
      expect(CONTEXT_HELP).toContain(flag);
    }
  });

  it.each([
    [['--cwd', 'missing'], '--cwd missing: no such directory in .'],
    [['--cwd', 'AGENTS.md'], '--cwd AGENTS.md is a file, not a directory.'],
    [['--cwd', '../outside'], '".." is not allowed'],
    [['--cwd', '/tmp'], 'not an absolute path'],
    [['--agent', 'gemini'], 'does not model what gemini loads yet'],
    [['--agent', 'nope'], 'Unknown agent "nope"'],
    [['--matrix', '--cwd', 'packages'], '--matrix covers the whole repository'],
    [['--context-window', '0'], '--context-window must be a positive whole number'],
    [['--format', 'sarif'], '--format must be one of: text, json, markdown'],
    [['--fail-on', 'warn'], '--fail-on does not apply to the context command.'],
  ])('exits 2 for %j', async (args, message) => {
    const io = capture(CONTEXT_FIXTURE);
    expect(await run(['context', ...args], io)).toBe(EXIT.usage);
    expect(io.out).toEqual([]);
    expect(io.errors()).toContain(message);
    expect(io.errors()).toContain('Run "agentcheckup context --help" for usage.');
  });

  it('exits 2 for a --cwd the walk did not list', async () => {
    const repo = await tempDir();
    await writeFiles(repo, {
      'AGENTS.md': '# Root\n',
      '.gitignore': 'generated/\n',
      'generated/AGENTS.md': '# Generated\n',
      'node_modules/pkg/AGENTS.md': '# Package\n',
      'packages/app/AGENTS.md': '# App\n',
    });
    for (const [cwd, opaque] of [
      ['generated', 'generated/'],
      ['node_modules', 'node_modules/'],
      ['node_modules/pkg', 'node_modules/'],
    ] as const) {
      const io = capture(repo);
      expect(await run(['context', '--cwd', cwd], io)).toBe(EXIT.usage);
      expect(io.errors()).toContain(`agentcheckup did not list ${opaque}`);
    }
    // Listed once .gitignore is not applied.
    expect(await run(['context', '--cwd', 'generated', '--no-gitignore'], capture(repo))).toBe(
      EXIT.ok,
    );
    expect(await run(['context', '--cwd', 'packages/app'], capture(repo))).toBe(EXIT.ok);
  });

  it('plans the agents among the configured targets, or those named with --agent', async () => {
    const repo = await tempDir();
    await writeFiles(repo, {
      'AGENTS.md': '# Root\n',
      'agentcheckup.config.json': '{ "targets": ["copilot", "gemini"] }',
    });
    const none = capture(repo);
    expect(await run(['context'], none)).toBe(EXIT.usage);
    expect(none.errors()).toContain('None of the targets (copilot, gemini) has a load model.');
    expect(none.errors()).toContain('choose with --agent');

    const named = await contextJson(['--agent', 'codex'], repo);
    expect(named.context?.agents).toEqual(['codex']);
    // The agent's rules run too, so its plan and its findings agree.
    expect(named.targets).toEqual(['codex', 'copilot', 'gemini']);

    await writeFile(join(repo, 'agentcheckup.config.json'), '{ "targets": ["cursor"] }');
    expect((await contextJson([], repo)).context?.agents).toEqual(['cursor']);
    // --untrusted ignores the configuration: every modeled agent again.
    expect((await contextJson(['--untrusted'], repo)).context?.agents).toEqual([
      'claude-code',
      'codex',
      'cursor',
    ]);
  });

  it('exits 2 for a bad configuration or a missing path', async () => {
    const repo = await tempDir();
    await writeFiles(repo, { 'agentcheckup.config.json': '{ "targets": ["vim"] }' });
    expect(await run(['context'], capture(repo))).toBe(EXIT.usage);
    expect(await run(['context', join(repo, 'missing')], capture())).toBe(EXIT.usage);
    await mkdir(join(repo, 'empty'));
    expect(await run(['context', 'empty', '--no-config'], capture(repo))).toBe(EXIT.ok);
  });
});

describe('agentcheckup --context', () => {
  it('embeds the load plans and the matrix in a scan', async () => {
    const io = capture(CONTEXT_FIXTURE);
    expect(await run(['--context', '--format', 'json', '--fail-on', 'none'], io)).toBe(EXIT.ok);
    const report = JSON.parse(io.output()) as Report;
    expect(report.context?.matrix).toBeDefined();
    expect(report.context?.plans.length).toBeGreaterThan(3);
  });

  it('keeps the findings and exit code of a scan without it', async () => {
    const plain = capture(CONTEXT_FIXTURE);
    const withContext = capture(CONTEXT_FIXTURE);
    expect(await run(['--format', 'json'], plain)).toBe(EXIT.findings);
    expect(await run(['--context', '--format', 'json'], withContext)).toBe(EXIT.findings);
    const a = JSON.parse(plain.output()) as Report;
    const b = JSON.parse(withContext.output()) as Report;
    expect(b.findings).toEqual(a.findings);
    expect(a.context).toBeUndefined();
  });

  it('accepts --context-window with --context', async () => {
    const io = capture(CONTEXT_FIXTURE);
    await run(['--context', '--context-window', '2000', '--format', 'json'], io);
    const report = JSON.parse(io.output()) as Report;
    const codex = report.context?.plans.find((plan) => plan.agent === 'codex');
    expect(codex?.assumptions).toContainEqual(
      expect.objectContaining({ key: 'codex.context_window', value: 2000 }),
    );
  });
});

describe('contextExitCode', () => {
  const clean = scanSnapshot(snapshotFrom({ 'AGENTS.md': '# ok\n' }), { rules: builtinRules });

  it('is 0 whatever the findings, 3 when a rule crashed, 1 when the gate tripped', () => {
    const failing: ScanResult = {
      ...clean,
      summary: { ...clean.summary, errors: 5 },
    };
    expect(contextExitCode(failing)).toBe(EXIT.ok);
    expect(contextExitCode({ ...clean, ruleFailures: [{ ruleId: 'x/y', message: 'boom' }] })).toBe(
      EXIT.internal,
    );
    const tripped: ScanResult = {
      ...clean,
      baseline: {
        against: { version: '0.0.0', ruleset: clean.ruleset, sameRuleset: true, newRules: [] },
        findings: { new: 0, unchanged: 0, resolved: [] },
        inventory: { added: [], removed: [], changed: [] },
        context: [],
        gate: {
          classes: ['hooks'],
          hits: [{ class: 'hooks', id: 'hook:x#y', change: 'added', summary: 'New hook' }],
        },
      },
    };
    expect(contextExitCode(tripped)).toBe(EXIT.findings);
  });
});
