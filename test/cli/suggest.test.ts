import { readFileSync } from 'node:fs';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import { FIX_HELP } from '../../src/cli/help.js';
import { EXIT, run } from '../../src/cli/run.js';
import { RULESET_VERSION, TOOL_NAME } from '../../src/core/meta.js';
import { VERSION } from '../../src/core/version.js';
import type { SuggestionsReport } from '../../src/report/suggestions-json.js';
import { MAX_DIFF_BYTES, MAX_DIFF_HUNKS } from '../../src/report/unified-diff.js';
import { capture, removeTempDirs, tempDir, writeFiles } from './helpers.js';

afterEach(removeTempDirs);

/**
 * test/fixtures/suggest: the head of a pull request (repo/), its diff (pull-request.diff) and the
 * comments and skip counts it must give (expected.json).
 */
const FIXTURE = fileURLToPath(new URL('../fixtures/suggest', import.meta.url));
const EXPECTED = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8')) as Pick<
  SuggestionsReport,
  'comments' | 'skipped'
>;

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile<SuggestionsReport>(
  JSON.parse(
    readFileSync(new URL('../../schemas/suggestions.schema.json', import.meta.url), 'utf8'),
  ) as object,
);

function parseReport(text: string): SuggestionsReport {
  const value: unknown = JSON.parse(text);
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
  return value as SuggestionsReport;
}

const SUGGEST = ['--untrusted', '--format', 'suggestions'] as const;

async function suggest(cwd: string, args: readonly string[]) {
  const io = capture(cwd);
  const code = await run(['fix', ...args], io);
  return { code, io };
}

const SKILL = '---\ndescription: Writes release notes from merged pull requests.\n---\n\n# Notes\n';
const SKILL_DIFF = [
  'diff --git a/.agents/skills/notes/SKILL.md b/.agents/skills/notes/SKILL.md',
  '--- /dev/null',
  '+++ b/.agents/skills/notes/SKILL.md',
  '@@ -0,0 +1,5 @@',
  ...SKILL.trimEnd()
    .split('\n')
    .map((line) => `+${line}`),
  '',
].join('\n');

/** A repository with one skill without a name, and the diff that adds it. */
async function skillRepo(): Promise<string> {
  const root = await tempDir();
  await writeFiles(root, { 'repo/.agents/skills/notes/SKILL.md': SKILL, 'pr.diff': SKILL_DIFF });
  return root;
}

describe('agentcheckup fix --format suggestions', () => {
  it('suggests the safe fixes inside the diff of the fixture pull request', async () => {
    const { code, io } = await suggest(FIXTURE, [
      'repo',
      ...SUGGEST,
      '--diff',
      'pull-request.diff',
    ]);
    expect(io.errors()).toBe('');
    expect(code).toBe(EXIT.ok);
    const report = parseReport(io.output());
    expect(report.schemaVersion).toBe(1);
    expect(report.tool).toEqual({ name: TOOL_NAME, version: VERSION });
    expect(report.ruleset).toBe(RULESET_VERSION);
    expect({ comments: report.comments, skipped: report.skipped }).toEqual(EXPECTED);
  });

  it('writes the JSON with --output and nothing to stdout', async () => {
    const root = await skillRepo();
    const { code, io } = await suggest(root, [
      'repo',
      ...SUGGEST,
      '--diff',
      'pr.diff',
      '--output',
      'suggestions.json',
    ]);
    expect(code).toBe(EXIT.ok);
    expect(io.output()).toBe('');
    const report = parseReport(await readFile(join(root, 'suggestions.json'), 'utf8'));
    expect(report.comments).toHaveLength(1);
    expect(report.comments[0]).toMatchObject({ path: '.agents/skills/notes/SKILL.md', line: 1 });
  });

  it('exits 0 with no comments when no fix is inside the diff', async () => {
    const root = await skillRepo();
    await writeFile(join(root, 'empty.diff'), '');
    const { code, io } = await suggest(root, ['repo', ...SUGGEST, '--diff', 'empty.diff']);
    expect(code).toBe(EXIT.ok);
    const report = parseReport(io.output());
    expect(report.comments).toEqual([]);
    expect(report.skipped).toEqual([
      { reason: 'outside-diff', count: 1 },
      { reason: 'needs-input', count: 1 },
    ]);
  });

  it('suggests only the fixes of --rule and rejects an unknown rule', async () => {
    const only = await suggest(FIXTURE, [
      'repo',
      ...SUGGEST,
      '--diff',
      'pull-request.diff',
      '--rule',
      'skill/name-missing',
    ]);
    expect(only.code).toBe(EXIT.ok);
    const report = parseReport(only.io.output());
    expect(report.comments.map((comment) => comment.path)).toEqual([
      '.agents/skills/notes/SKILL.md',
    ]);
    expect(report.skipped).toEqual([]);

    const unknown = await suggest(FIXTURE, [
      'repo',
      ...SUGGEST,
      '--diff',
      'pull-request.diff',
      '--rule',
      'skill/nope',
    ]);
    expect(unknown.code).toBe(EXIT.usage);
    expect(unknown.io.errors()).toContain('--rule: unknown rule "skill/nope"');
  });

  it('reads a diff that is not valid UTF-8', async () => {
    const root = await skillRepo();
    const bytes = Buffer.concat([
      Buffer.from(SKILL_DIFF),
      Buffer.from('diff --git a/latin1.txt b/latin1.txt\n+++ b/latin1.txt\n@@ -1 +1 @@\n-a\n+caf'),
      Buffer.from([0xe9, 0x0a]),
    ]);
    await writeFile(join(root, 'latin1.diff'), bytes);
    const { code, io } = await suggest(root, ['repo', ...SUGGEST, '--diff', 'latin1.diff']);
    expect(code).toBe(EXIT.ok);
    expect(parseReport(io.output()).comments).toHaveLength(1);
  });

  it('warns when the diff has more hunks than it keeps', async () => {
    const root = await skillRepo();
    const hunks = '@@ -1 +1 @@\n-a\n+b\n'.repeat(MAX_DIFF_HUNKS + 1);
    await writeFile(join(root, 'many.diff'), `${SKILL_DIFF}+++ b/other.md\n${hunks}`);
    const { code, io } = await suggest(root, ['repo', ...SUGGEST, '--diff', 'many.diff']);
    expect(code).toBe(EXIT.ok);
    expect(io.errors()).toBe(
      `Warning: the diff has more than ${MAX_DIFF_HUNKS} hunks; changes in the rest are not suggested.\n`,
    );
    expect(parseReport(io.output()).comments).toHaveLength(1);
  });

  it('documents --diff and the format in the help', () => {
    expect(FIX_HELP).toContain('diff (default), json, suggestions');
    expect(FIX_HELP).toContain('--diff <file>');
  });
});

describe('agentcheckup fix --format suggestions: usage errors', () => {
  it.each([
    [['--format', 'suggestions', '--untrusted'], '--format suggestions needs --diff <file>'],
    [['--format', 'suggestions', '--diff', 'pr.diff'], '--format suggestions needs --untrusted'],
    [['--untrusted', '--diff', 'pr.diff'], '--diff works only with --format suggestions.'],
    [['--format', 'json', '--diff', 'pr.diff'], '--diff works only with --format suggestions.'],
    [
      ['--format', 'suggestions', '--diff', 'pr.diff', '--write'],
      'cannot be combined with --write',
    ],
    [['--format', 'suggestions', '--diff', 'pr.diff', '-i'], 'cannot be combined with -i'],
    [
      [...SUGGEST, '--diff', 'pr.diff', '--write'],
      '--untrusted allows only a dry run, so it cannot be combined with --write.',
    ],
  ])('fix %j exits 2', async (args, message) => {
    const root = await skillRepo();
    const { code, io } = await suggest(root, ['repo', ...args]);
    expect(code).toBe(EXIT.usage);
    expect(io.output()).toBe('');
    expect(io.errors()).toContain(message);
    expect(io.errors()).toContain('Run "agentcheckup fix --help" for usage.');
  });

  it('rejects --diff outside the fix command', async () => {
    const root = await skillRepo();
    const io = capture(root);
    expect(await run(['repo', '--diff', 'pr.diff'], io)).toBe(EXIT.usage);
    expect(io.errors()).toContain('--diff works only with the fix command');
  });

  it.skipIf(process.platform === 'win32')('exits 2 for a diff file that is a symlink', async () => {
    const root = await skillRepo();
    await symlink(join(root, 'pr.diff'), join(root, 'link.diff'));
    const linked = await suggest(root, ['repo', ...SUGGEST, '--diff', 'link.diff']);
    expect(linked.code).toBe(EXIT.usage);
    expect(linked.io.errors()).toContain('it is a symbolic link');
  });

  it('exits 2 for a diff file that is missing or too large', async () => {
    const root = await skillRepo();
    const missing = await suggest(root, ['repo', ...SUGGEST, '--diff', 'missing.diff']);
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.io.errors()).toContain('Diff file not found');

    await writeFile(join(root, 'huge.diff'), Buffer.alloc(MAX_DIFF_BYTES + 1, 0x20));
    const huge = await suggest(root, ['repo', ...SUGGEST, '--diff', 'huge.diff']);
    expect(huge.code).toBe(EXIT.usage);
    expect(huge.io.errors()).toContain(`exceeds the ${MAX_DIFF_BYTES}-byte limit`);
    expect(huge.io.output()).toBe('');
  });
});
