import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT, run } from '../../src/cli/run.js';
import type { SuggestionsReport } from '../../src/report/suggestions-json.js';
import type * as Rules from '../../src/rules/index.js';
import { capture, removeTempDirs, tempDir, writeFiles } from './helpers.js';

// The built-in rules plus the test-only rules of fix-rules.ts: test/notes creates a file,
// test/move renames one, test/crash throws.
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

/** The diff that adds every file, whole. */
function addedFiles(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([path, text]) => {
      const lines = text.trimEnd().split('\n');
      return [
        `diff --git a/${path} b/${path}`,
        '--- /dev/null',
        `+++ b/${path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
        '',
      ].join('\n');
    })
    .join('');
}

async function suggest(files: Record<string, string>) {
  const root = await tempDir();
  await writeFiles(root, {
    ...Object.fromEntries(Object.entries(files).map(([path, text]) => [`repo/${path}`, text])),
    'pr.diff': addedFiles(files),
  });
  const io = capture(root);
  const code = await run(
    ['fix', 'repo', '--untrusted', '--format', 'suggestions', '--diff', 'pr.diff'],
    io,
  );
  return { code, io };
}

describe('agentcheckup fix --format suggestions with test rules', () => {
  it('exits 3 and writes nothing when a rule crashed', async () => {
    const { code, io } = await suggest({ 'AGENTS.md': '# Agents\n\nCRASH\nReviewed.\n' });
    expect(code).toBe(EXIT.internal);
    expect(io.output()).toBe('');
    expect(io.errors()).toBe(
      'Rule test/crash crashed: test rule crashed\n' +
        'No suggestions were written: a scan with a crashed rule cannot verify them.\n',
    );
  });

  it('suggests the safe heading, and counts the fix that creates a file and the review fix', async () => {
    const { code, io } = await suggest({ 'AGENTS.md': 'See the notes.\n' });
    expect(code).toBe(EXIT.ok);
    const report = JSON.parse(io.output()) as SuggestionsReport;
    expect(report.comments.map((comment) => [comment.path, comment.line])).toEqual([
      ['AGENTS.md', 1],
    ]);
    expect(report.comments[0]?.body).toContain('```suggestion\n# Agents\n\nSee the notes.\n```');
    expect(report.skipped).toEqual([
      { reason: 'not-safe', count: 1 },
      { reason: 'creates-file', count: 1 },
    ]);
  });
});
