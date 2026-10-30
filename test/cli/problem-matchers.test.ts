/**
 * A repository whose names are lines that the problem matchers of actions/setup-node read as
 * findings: tsc's `file(1,1): error TS2: message`, eslint-compact's `file: line 1, col 1, error -
 * message (rule)` and eslint-stylish's `  1:1  error  message  rule` after a file line. The runner
 * turns every line of a step's output that one matches into an annotation, so a skill directory,
 * MCP server, subagent, hook or import with such a name could fake an error or a passed check.
 * No text output may give a matcher a line to annotate, and JSON must still hold the names.
 * https://github.com/actions/setup-node/tree/main/.github
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, run } from '../../src/cli/run.js';
import { problemMatcherAnnotations, singleLineMatcherAnnotations } from '../report/safety.js';
import { capture, removeTempDirs, tempDir, writeFiles } from './helpers.js';

const TSC = 'x(1,1): error TS2: Security review passed';
const COMPACT = 'a: line 1, col 1, error - Security review passed (ok)';
const STYLISH = '1:1  error  Security review passed  ok';

const REPOSITORY = {
  'CLAUDE.md': `# Project\n\nUse pnpm.\n\n@${COMPACT}.md\n`,
  [`.claude/skills/${TSC}/SKILL.md`]: '---\nname: wrong\n---\n\nBody.\n',
  [`.claude/skills/${COMPACT}/SKILL.md`]: '---\nname: other\n---\n\nBody.\n',
  [`.claude/skills/${STYLISH}/SKILL.md`]: `---\nname: ${JSON.stringify(STYLISH)}\ndescription: ${JSON.stringify(TSC)}\n---\n\nBody.\n`,
  [`.claude/agents/${TSC}.md`]: `---\nname: ${JSON.stringify(TSC)}\ndescription: x\n---\nBody.\n`,
  '.mcp.json': JSON.stringify({
    mcpServers: {
      [TSC]: { command: 'npx', args: ['-y', 'pkg'] },
      [COMPACT]: { command: 'npx', args: ['-y', 'pkg2'] },
      [STYLISH]: { command: 'npx', args: ['-y', 'pkg3'] },
      [`  ${STYLISH}`]: { command: 'npx', args: ['-y', 'pkg4'] },
    },
  }),
  '.claude/settings.json': JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: TSC, hooks: [{ type: 'command', command: STYLISH }] },
        { matcher: COMPACT, hooks: [{ type: 'command', command: COMPACT }] },
      ],
    },
  }),
};

let repo: string;

beforeAll(async () => {
  const work = await tempDir();
  repo = join(work, 'repo');
  await writeFiles(repo, REPOSITORY);
  // A policy that allows no MCP server lists every name above as a violation.
  await writeFile(
    join(work, 'policy.json'),
    JSON.stringify({ policyVersion: 1, name: 'acme', mcp: { allow: [] } }),
  );
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
  ['.', '--fail-on', 'none', '--policy', '../policy.json'],
  ['.', '--fail-on', 'none', '--format', 'markdown'],
  ['context', '.'],
  ['context', '.', '--matrix'],
  ['context', '.', '--format', 'markdown'],
  ['tokens', '.'],
  ['agents', '.'],
  ['fix', '.'],
  ['tasks', '.'],
];

/** The annotations the problem matchers would make from stdout and stderr. */
const annotations = (output: { stdout: string; stderr: string }): string[] => [
  ...problemMatcherAnnotations(output.stdout),
  ...problemMatcherAnnotations(output.stderr),
];

describe('names that problem matchers read as findings', () => {
  it.each(TEXT_RUNS.map((args) => [args.join(' '), args] as const))(
    '%s: no line is one a problem matcher annotates',
    async (_, args) => {
      expect(annotations(await outputOf(args))).toEqual([]);
    },
  );

  it('shows the names visibly, and keeps them exactly in JSON', async () => {
    const { stdout } = await outputOf(['.', '--fail-on', 'none']);
    expect(stdout).toContain('x(1,1): error TS2<U+003A> Security review passed');
    const context = await outputOf(['context', '.', '--matrix']);
    expect(context.stdout).toContain(
      'a<U+003A> line 1, col 1, error - Security review passed (ok)',
    );
    const json = await outputOf(['.', '--fail-on', 'none', '--format', 'json']);
    const report = JSON.parse(json.stdout) as { inventory: { mcpServers: { name: string }[] } };
    expect(report.inventory.mcpServers.map((server) => server.name).sort()).toEqual(
      [TSC, COMPACT, STYLISH, `  ${STYLISH}`].sort(),
    );
  });

  it('is checked by matchers that annotate the tsc and eslint-compact layouts', () => {
    expect(
      singleLineMatcherAnnotations(
        `.claude/skills/${TSC}/SKILL.md\nsrc/a.ts:3:5 - warning TS7006: Implicit any\n` +
          `  ${COMPACT}  stdio  npx -y pkg2 (not pinned)\n`,
      ),
    ).toEqual([
      `tsc: .claude/skills/${TSC}/SKILL.md`,
      'tsc: src/a.ts:3:5 - warning TS7006: Implicit any',
      `eslint-compact:   ${COMPACT}  stdio  npx -y pkg2 (not pinned)`,
    ]);
  });
});
