/**
 * A repository whose names are workflow commands in the runner's older syntax, `##[name]data`,
 * which the GitHub Actions runner reads anywhere in a line of stdout or stderr: a skill that
 * fakes an error annotation, an MCP server that switches command processing off, a hook event
 * that sets a step output, an import and a rule id in the configuration. No command may print a
 * line the runner reads as a command, and JSON must still hold the names exactly.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, run } from '../../src/cli/run.js';
import { commandLines } from '../report/safety.js';
import { capture, removeTempDirs, tempDir, writeFiles } from './helpers.js';

const SKILL = '##[error file=CLAUDE.md;line=1]Fake';
const SERVER = '##[stop-commands]tok123';
const HOOK_EVENT = '##[set-output name=gate-hits;]0';
const RULE_ID = '##[add-mask]rule';

const REPOSITORY = {
  'CLAUDE.md': '# Project\n\nUse pnpm.\n\n@##[warning]injected.md\n',
  [`.claude/skills/${SKILL}/SKILL.md`]:
    '---\nname: "x ##[error file=CLAUDE.md;line=1]Fake: all checks passed"\n' +
    'description: helper ##[add-mask]Claude\n---\n\nBody.\n',
  '.mcp.json': JSON.stringify({
    mcpServers: { [SERVER]: { command: 'npx', args: ['-y', 'pkg'] } },
  }),
  '.claude/settings.json': JSON.stringify({
    hooks: { [HOOK_EVENT]: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
  }),
  'agentcheckup.config.json': JSON.stringify({ rules: { [RULE_ID]: 'warn' } }),
};

let repo: string;
let baseline: string;

beforeAll(async () => {
  const work = await tempDir();
  repo = join(work, 'repo');
  await writeFiles(repo, REPOSITORY);
  // An empty repository's report: every server and hook of the hostile one is new.
  const empty = join(work, 'empty');
  await writeFiles(empty, { 'AGENTS.md': '# Empty\n' });
  baseline = join(work, 'base.json');
  const io = capture(work);
  await run([empty, '--context', '--format', 'json', '--output', baseline], io);
  expect(io.errors()).toBe('');
});

afterAll(removeTempDirs);

/** stdout and stderr of one run. */
async function outputOf(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const io = capture(repo);
  const code = await run([...args], io);
  expect([EXIT.ok, EXIT.findings]).toContain(code);
  return { stdout: io.output(), stderr: io.errors() };
}

const TEXT_RUNS: readonly (readonly string[])[] = [
  ['.', '--fail-on', 'none'],
  ['.', '--fail-on', 'none', '--verbose'],
  ['.', '--fail-on', 'none', '--compact'],
  ['.', '--fail-on', 'none', '--format', 'markdown'],
  // SARIF messages escape brackets anyway (no embedded links, SARIF 2.1.0 §3.11.6).
  ['.', '--fail-on', 'none', '--format', 'sarif'],
  ['.', '--fail-on', 'none', '--baseline', '../base.json', '--gate', 'security'],
  ['context', '.'],
  ['context', '.', '--matrix'],
  ['context', '.', '--format', 'markdown'],
  ['context', '.', '--baseline', '../base.json', '--gate', 'security'],
  ['tokens', '.'],
  ['tokens', '.', '--format', 'markdown'],
  ['agents', '.'],
  ['agents', '.', '--format', 'markdown'],
  ['fix', '.'],
  ['tasks', '.'],
];

const JSON_RUNS: readonly (readonly string[])[] = [
  ['.', '--fail-on', 'none', '--format', 'json'],
  ['.', '--fail-on', 'none', '--format', 'json', '--context'],
  ['.', '--fail-on', 'none', '--format', 'json', '--baseline', '../base.json'],
  ['context', '.', '--format', 'json'],
  ['tokens', '.', '--format', 'json'],
  ['agents', '.', '--format', 'json'],
  ['fix', '.', '--format', 'json'],
  ['tasks', '.', '--format', 'json'],
];

/** Every string in a parsed JSON value. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

describe('names that are workflow commands in the older syntax', () => {
  it.each(TEXT_RUNS.map((args) => [args.join(' '), args] as const))(
    '%s: no line of stdout or stderr is a command',
    async (_, args) => {
      const { stdout, stderr } = await outputOf(args);
      expect(commandLines(stdout)).toEqual([]);
      expect(commandLines(stderr)).toEqual([]);
    },
  );

  it.each(JSON_RUNS.map((args) => [args.join(' '), args] as const))(
    '%s: no line is a command, and the JSON holds the names exactly',
    async (_, args) => {
      const { stdout, stderr } = await outputOf(args);
      expect(commandLines(stdout)).toEqual([]);
      expect(commandLines(stderr)).toEqual([]);
      const texts = strings(JSON.parse(stdout)).join('\n');
      expect(texts).toContain('##[');
    },
  );

  it('shows the names visibly, and warns about the rule id on stderr', async () => {
    const { stdout } = await outputOf(['.', '--fail-on', 'none']);
    expect(stdout).toContain(`##<U+005B>set-output name=gate-hits;]0`);
    const json = await outputOf(['.', '--fail-on', 'none', '--format', 'json']);
    expect(json.stderr).toBe('Warning: Unknown rule "##<U+005B>add-mask]rule" in configuration.\n');
    const report = JSON.parse(json.stdout) as { inventory: { mcpServers: { name: string }[] } };
    expect(report.inventory.mcpServers.map((server) => server.name)).toEqual([SERVER]);
  });
});
