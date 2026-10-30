import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DiffHunk } from '../../src/fix/index.js';
import type { ContextAgent } from '../../src/platforms/load/types.js';
import { findSecret } from '../../src/rules/mcp/secrets.js';
import {
  diffHunks,
  type FixRun,
  formatFixDiff,
  formatFixSummary,
  MAX_EDIT_COST,
  NO_NEWLINE_MARKER,
  redactCredentials,
} from '../../src/report/fix-diff.js';
import { HOSTILE, HOSTILE_ALL } from './hostile.js';
import {
  applied,
  awaiting,
  created,
  edited,
  GITHUB_TOKEN,
  hostileRun,
  inputRun,
  INPUTS,
  OPENAI_KEY,
  planned,
  renamed,
  ROTATE,
  sampleRun,
  secretRun,
  skipped,
  writtenRun,
} from './fix-fixtures.js';
import {
  ansiStyle,
  commandLines,
  hasEscOrBel,
  stripKnownSgr,
  tagStyle,
  unsafeCodePoints,
} from './safety.js';

interface TextLine {
  text: string;
  eol: boolean;
}

function splitWithEol(text: string): TextLine[] {
  const parts = text.split('\n');
  const last = parts.pop() ?? '';
  const out = parts.map((part) => ({ text: part, eol: true }));
  if (last !== '') out.push({ text: last, eol: false });
  return out;
}

/**
 * Applies unified-diff hunks to `before`, checking the headers and every context and deleted
 * line. Independent of the implementation: a wrong hunk header or line fails here.
 */
function applyHunks(before: string, hunks: readonly DiffHunk[]): string {
  const old = splitWithEol(before);
  const out: TextLine[] = [];
  let cursor = 0;
  const copyTo = (index: number): void => {
    while (cursor < index) out.push({ ...old[cursor++]! });
  };
  for (const hunk of hunks) {
    copyTo(hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1);
    expect(hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1).toBe(out.length);
    let previous = '';
    let oldCount = 0;
    let newCount = 0;
    for (const line of hunk.lines) {
      if (line === NO_NEWLINE_MARKER) {
        if (previous !== '-') out[out.length - 1]!.eol = false;
        continue;
      }
      const mark = line.charAt(0);
      const text = line.slice(1);
      if (mark !== '+') {
        expect(old[cursor]?.text).toBe(text);
        cursor++;
        oldCount++;
      }
      if (mark !== '-') {
        out.push({ text, eol: true });
        newCount++;
      }
      previous = mark;
    }
    expect([oldCount, newCount]).toEqual([hunk.oldLines, hunk.newLines]);
  }
  copyTo(old.length);
  return out.map((line) => `${line.text}${line.eol ? '\n' : ''}`).join('');
}

function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join('');
}

describe('diffHunks', () => {
  it('gives no hunks for identical texts', () => {
    expect(diffHunks('a\nb\n', 'a\nb\n')).toEqual([]);
    expect(diffHunks('', '')).toEqual([]);
  });

  it('adds lines at the start with three lines of context', () => {
    expect(
      diffHunks(
        '# Acme\n\nUse pnpm.\nRun tests.\n',
        '@AGENTS.md\n\n# Acme\n\nUse pnpm.\nRun tests.\n',
      ),
    ).toEqual([
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 5,
        lines: ['+@AGENTS.md', '+', ' # Acme', ' ', ' Use pnpm.'],
      },
    ]);
  });

  it('deletes a line in the middle', () => {
    expect(diffHunks(lines(9), lines(9).replace('line 5\n', ''))).toEqual([
      {
        oldStart: 2,
        oldLines: 7,
        newStart: 2,
        newLines: 6,
        lines: [' line 2', ' line 3', ' line 4', '-line 5', ' line 6', ' line 7', ' line 8'],
      },
    ]);
  });

  it('puts deletions before additions within a change', () => {
    const [hunk] = diffHunks('a\nb\nc\n', 'a\nB\nc\n');
    expect(hunk?.lines).toEqual([' a', '-b', '+B', ' c']);
  });

  it('splits changes more than six lines apart into hunks and merges closer ones', () => {
    const base = lines(30);
    const far = base.replace('line 3\n', 'LINE 3\n').replace('line 20\n', 'LINE 20\n');
    expect(diffHunks(base, far).map((hunk) => [hunk.oldStart, hunk.oldLines])).toEqual([
      [1, 6],
      [17, 7],
    ]);
    const near = base.replace('line 3\n', 'LINE 3\n').replace('line 10\n', 'LINE 10\n');
    expect(diffHunks(base, near).map((hunk) => [hunk.oldStart, hunk.oldLines])).toEqual([[1, 13]]);
  });

  it('reports a new file as -0,0 and a deleted text as +0,0', () => {
    expect(diffHunks('', 'a\nb\n')).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] },
    ]);
    expect(diffHunks('a\n', '')).toEqual([
      { oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-a'] },
    ]);
  });

  it('marks a last line without a line break', () => {
    expect(diffHunks('a\nb', 'a\nb\nc')).toEqual([
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [' a', '-b', NO_NEWLINE_MARKER, '+b', '+c', NO_NEWLINE_MARKER],
      },
    ]);
    expect(diffHunks('a\nb', 'A\nb')[0]?.lines).toEqual(['-a', '+A', ' b', NO_NEWLINE_MARKER]);
  });

  it('compares line endings unless told to ignore CR', () => {
    expect(diffHunks('a\r\nb\r\n', 'a\r\nb\n')[0]?.lines).toEqual([' a', '-b', '+b']);
    expect(diffHunks('a\r\nb\r\n', 'a\r\nb\n', { ignoreCr: true })).toEqual([]);
  });

  it('honors another context size', () => {
    const [hunk] = diffHunks(lines(9), lines(9).replace('line 5\n', 'five\n'), { context: 1 });
    expect(hunk?.lines).toEqual([' line 4', '-line 5', '+five', ' line 6']);
  });

  it('turns every pair of texts into hunks that reproduce the new text', () => {
    const line = fc.constantFrom('a', 'b', 'c', '', '  x', 'a\rb');
    const text = fc
      .tuple(fc.array(line, { maxLength: 25 }), fc.boolean())
      .map(([items, final]) => items.map((item) => `${item}\n`).join('') + (final ? 'end' : ''));
    fc.assert(
      fc.property(text, text, (before, after) => {
        expect(applyHunks(before, diffHunks(before, after))).toBe(after);
      }),
      { numRuns: 400 },
    );
  });

  it('is minimal for a single change', () => {
    const before = lines(50);
    const after = before.replace('line 25\n', 'line 25\ninserted\n');
    const [hunk] = diffHunks(before, after);
    expect(hunk?.lines.filter((text) => !text.startsWith(' '))).toEqual(['+inserted']);
  });

  it('falls back to one block past the edit budget, still correct and fast', () => {
    const count = MAX_EDIT_COST + 200;
    const before = lines(count, 'old');
    const after = lines(count, 'new');
    const start = performance.now();
    const hunks = diffHunks(before, after);
    expect(performance.now() - start).toBeLessThan(5000);
    expect(applyHunks(before, hunks)).toBe(after);
    expect(hunks).toHaveLength(1);
  });

  it('is deterministic', () => {
    const before = lines(40).replace('line 7\n', 'x\n');
    const after = lines(40).replace('line 30\n', 'y\n');
    expect(diffHunks(before, after)).toEqual(diffHunks(before, after));
  });
});

describe('redactCredentials', () => {
  it('uses detectable test credentials', () => {
    expect(findSecret(GITHUB_TOKEN)?.length).toBe(GITHUB_TOKEN.length);
    expect(findSecret(OPENAI_KEY)?.length).toBe(OPENAI_KEY.length);
  });

  it('keeps the first four characters and the length', () => {
    expect(redactCredentials(`token=${GITHUB_TOKEN};`)).toBe('token=ghp_…(40 chars);');
    expect(redactCredentials(`a ${OPENAI_KEY} b ${GITHUB_TOKEN}`, [], '...')).toBe(
      `a sk-p...(${OPENAI_KEY.length} chars) b ghp_...(40 chars)`,
    );
  });

  it('redacts every occurrence of a marked value, without a prefix when it is short', () => {
    expect(redactCredentials('x=hunter22 and hunter22', ['hunter22'])).toBe(
      'x=…(8 chars) and …(8 chars)',
    );
    expect(redactCredentials('a long-secret-value-here b', ['long-secret-value-here'])).toBe(
      'a long…(22 chars) b',
    );
  });

  it('leaves text alone that holds no credential', () => {
    expect(redactCredentials('ghp_ is a prefix; abc', ['abc'])).toBe('ghp_ is a prefix; abc');
    expect(redactCredentials('nothing here $&')).toBe('nothing here $&');
  });
});

const plain = (run: FixRun, ascii = false) => formatFixDiff(run, { ascii });

describe('formatFixDiff snapshots', () => {
  it('sample dry run', async () => {
    await expect(plain(sampleRun)).toMatchFileSnapshot('__snapshots__/fix-diff.sample.txt');
  });

  it('sample, styled', async () => {
    await expect(formatFixDiff(sampleRun, { style: tagStyle })).toMatchFileSnapshot(
      '__snapshots__/fix-diff.styled.txt',
    );
  });

  it('sample, ASCII only', async () => {
    const output = plain(sampleRun, true);
    expect(output).toMatch(/^[\t\n\x20-\x7e]*$/);
    await expect(output).toMatchFileSnapshot('__snapshots__/fix-diff.ascii.txt');
  });

  it('credential fix', async () => {
    await expect(plain(secretRun)).toMatchFileSnapshot('__snapshots__/fix-diff.secret.txt');
  });

  it('hostile', async () => {
    await expect(plain(hostileRun)).toMatchFileSnapshot('__snapshots__/fix-diff.hostile.txt');
  });

  it('edge cases: line endings, encodings, final newlines, deletions, renames', async () => {
    const fix = planned('test/edges', {
      class: 'safe',
      title: 'Edge cases',
      changes: [
        'crlf.md',
        'mixed.md',
        'bom.md',
        'utf16.md',
        'final.md',
        'deleted.md',
        'new.md',
        'moved.md',
      ].map((path) => ({ kind: 'edit' as const, path, edits: [] })),
    });
    const run: FixRun = {
      mode: 'dry-run',
      fixes: [fix],
      files: [
        edited('crlf.md', 'a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\nd\r\n'),
        edited('mixed.md', 'a\nb\r\nc\n', 'a\r\nb\r\nc\n'),
        edited('bom.md', '---\nname: x\n---\n', '---\nname: x\n---\n', { before: { bom: true } }),
        edited('utf16.md', '# Notes\n', '# Notes\n', {
          before: { encoding: 'utf-16le', bom: true },
        }),
        edited('final.md', 'one\ntwo', 'one\ntwo\n'),
        edited('deleted.md', lines(12), lines(12).replace('line 2\n', '').replace('line 11\n', '')),
        created('new.md', 'first\r\nsecond'),
        renamed('old-name.md', 'moved.md', 'same\n', 'same\n'),
      ],
      manual: [],
      verification: { resolved: 8, remaining: 0, introduced: [] },
    };
    await expect(plain(run)).toMatchFileSnapshot('__snapshots__/fix-diff.edges.txt');
  });

  it('nothing to fix', () => {
    const run: FixRun = {
      mode: 'dry-run',
      fixes: [],
      files: [],
      manual: sampleRun.manual,
      verification: { resolved: 0, remaining: 1, introduced: [] },
    };
    expect(plain(run)).toBe(
      'Nothing to fix.\nmanual  instr/import-unresolved  CLAUDE.md:3  create docs/setup.md or correct the path\n',
    );
    expect(plain({ ...run, manual: [] })).toBe('Nothing to fix.\n');
  });
});

describe('formatFixDiff content', () => {
  const output = plain(sampleRun);

  it('shows class, rule and title, diff headers, effects and notes', () => {
    expect(output).toContain(
      'safe    instr/agents-md-ignored-by-claude  Add "@AGENTS.md" as line 1 of CLAUDE.md\n--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,3 +1,5 @@\n+@AGENTS.md\n+\n # Acme API\n',
    );
    expect(output).toContain('  effect: Claude Code session start ≈50 → ≈247 tokens');
    expect(output).toContain(
      '  effect: Changed MCP server docs (http, https://docs.example.com) (gate class mcp)',
    );
    expect(output).toContain(
      '  effect: Claude Code in packages/api session start ≈120 → ≈410 tokens',
    );
    expect(output).toContain(
      '  note: copied from the body; reword it to say when to use the skill',
    );
    expect(output).toContain(
      'rename from .cursor/rules/style.md\nrename to .cursor/rules/style.mdc\n--- a/.cursor/rules/style.md\n+++ b/.cursor/rules/style.mdc\n',
    );
    expect(output).toContain(
      '--- /dev/null\n+++ b/packages/api/CLAUDE.md\n@@ -0,0 +1 @@\n+@AGENTS.md\n',
    );
    expect(output).toContain(
      'safe    json/duplicate-key  Delete the first "docs" in .mcp.json\n  skipped: it overlaps a fix that goes first; run agentcheckup fix again\n',
    );
    expect(output).toMatch(
      /\nmanual {2}instr\/import-unresolved {2}CLAUDE\.md:3 {2}create docs\/setup\.md or correct the path\nVerified on an in-memory copy: 5 findings resolved, 0 new, 1 left\.\n$/,
    );
  });

  it('shows a file changed by two fixes once, under the first', () => {
    const run: FixRun = {
      ...sampleRun,
      fixes: [
        ...sampleRun.fixes,
        planned('skill/name-format', {
          class: 'safe',
          title: 'Set the name',
          changes: [{ kind: 'edit', path: 'CLAUDE.md', edits: [] }],
        }),
      ],
    };
    const text = plain(run);
    expect(text.split('+++ b/CLAUDE.md')).toHaveLength(2);
    expect(text).toContain(
      'safe    skill/name-format  Set the name\n  CLAUDE.md: see the diff above\n',
    );
  });

  it('shows files no fix claims under "Other changes"', () => {
    const run: FixRun = { ...sampleRun, files: [...sampleRun.files, created('stray.md', 'x\n')] };
    expect(plain(run)).toContain('Other changes\n--- /dev/null\n+++ b/stray.md\n');
  });

  it('puts pathBase in front of every path', () => {
    const text = formatFixDiff({ ...sampleRun, pathBase: 'sub/dir/' });
    expect(text).toContain('--- a/sub/dir/CLAUDE.md\n+++ b/sub/dir/CLAUDE.md');
    expect(text).toContain('rename from sub/dir/.cursor/rules/style.md');
    expect(text).toContain('Claude Code in sub/dir session start');
    expect(text).toContain('sub/dir/CLAUDE.md:3');
  });

  it('says "Re-scanned" outside a dry run and lists new findings', () => {
    const text = plain(writtenRun);
    expect(text).toContain('Re-scanned: 5 findings resolved, 1 new, 1 left.\n');
    expect(text).toContain(
      '  new info  .agents/skills/release-notes/SKILL.md:3  skill/description-quality  The description does not say when to use the skill.\n',
    );
  });

  it('names the encoding of a created file that is not plain UTF-8', () => {
    const file = created('bom.md', 'x\n');
    const run: FixRun = {
      ...sampleRun,
      fixes: [],
      files: [{ ...file, after: { ...file.after, state: { ...file.after.state, bom: true } } }],
    };
    expect(plain(run)).toContain('Other changes\nencoding: UTF-8 with BOM\n--- /dev/null\n');
  });

  it('cuts very long lines', () => {
    const long = 'x'.repeat(5000);
    const run: FixRun = {
      ...sampleRun,
      fixes: [sampleRun.fixes[0]!],
      files: [edited('CLAUDE.md', `${long}\n`, `@AGENTS.md\n${long}\n`)],
    };
    const line = plain(run)
      .split('\n')
      .find((text) => text.startsWith(' x'));
    expect(line).toBe(` ${'x'.repeat(1000)}…`);
  });

  it('is deterministic', () => {
    expect(plain(sampleRun)).toBe(plain(sampleRun));
    expect(plain(hostileRun)).toBe(plain(hostileRun));
  });
});

describe('formatFixSummary', () => {
  it('summarizes a write', async () => {
    const text = formatFixSummary(writtenRun);
    expect(text).toBe(
      [
        'Applied 5 fixes to 5 files. Re-scanned: 5 findings resolved, 1 new, 1 left.',
        '  Claude Code session start ≈50 → ≈247 tokens',
        '  Claude Code in packages/api session start ≈120 → ≈410 tokens',
        '  Cursor session start ≈304 → ≈614 tokens',
        '  Changed MCP server docs (http, https://docs.example.com) (gate class mcp)',
        '  new info  .agents/skills/release-notes/SKILL.md:3  skill/description-quality  The description does not say when to use the skill.',
        'Not applied: 1 fix',
        '  safe    json/duplicate-key  Delete the first "docs" in .mcp.json: it overlaps a fix that goes first; run agentcheckup fix again',
        'Left: CLAUDE.md:3 instr/import-unresolved (create docs/setup.md or correct the path)',
        'Review the changes with git status and git diff.',
        '',
      ].join('\n'),
    );
    await expect(formatFixSummary(writtenRun, { style: tagStyle })).toMatchFileSnapshot(
      '__snapshots__/fix-summary.styled.txt',
    );
  });

  it('adds token changes of one agent and directory', () => {
    const fixes = [50, 30].map((delta) =>
      planned(
        'test/tokens',
        { class: 'safe', title: 't', changes: [] },
        {
          status: 'applied',
          effects: [{ kind: 'tokens', agent: 'codex', cwd: '', before: 100, after: 100 + delta }],
        },
      ),
    );
    const text = formatFixSummary({ ...writtenRun, fixes, manual: [] }, { ascii: true });
    expect(text).toContain('  Codex session start ~100 -> ~180 tokens\n');
    expect(text).toContain('Applied 2 fixes to 5 files.');
  });

  it('names agents with the same token change together, and keeps the others apart', () => {
    const effect = (agent: ContextAgent, before: number, after: number, cwd = '') =>
      ({ kind: 'tokens', agent, cwd, before, after }) as const;
    const fix = planned(
      'test/tokens',
      { class: 'safe', title: 't', changes: [] },
      {
        status: 'applied',
        effects: [
          effect('claude-code', 15, 30),
          effect('cursor', 27, 30),
          effect('copilot-cli', 27, 30),
          effect('windsurf', 27, 30),
          // Same totals in another directory: a line of its own.
          effect('cursor', 27, 30, 'pkg'),
        ],
      },
    );
    const text = formatFixSummary({ ...writtenRun, fixes: [fix], manual: [] }, { ascii: true });
    expect(text).toContain(
      [
        '  Claude Code session start ~15 -> ~30 tokens',
        '  Cursor, Copilot CLI and Devin Local session start ~27 -> ~30 tokens',
        '  Cursor in pkg session start ~27 -> ~30 tokens',
      ].join('\n'),
    );
  });

  it('frames the summary with the warnings of applied fixes', () => {
    const run: FixRun = {
      ...secretRun,
      mode: 'write',
      fixes: secretRun.fixes.map(applied),
    };
    const text = formatFixSummary(run);
    const banner = `!! ${ROTATE}`;
    expect(text.startsWith(`${banner}\nApplied 2 fixes to 2 files.`)).toBe(true);
    expect(text.endsWith(`Review the changes with git status and git diff.\n${banner}\n`)).toBe(
      true,
    );
    expect(text).not.toContain(GITHUB_TOKEN);
    expect(text).toContain('move ghp_…(40 chars) into your shell environment');
  });

  it('says when nothing was applied', () => {
    const run: FixRun = {
      ...sampleRun,
      mode: 'write',
      fixes: [skipped('a/b', { class: 'safe', title: 'T', changes: [] }, 'changed-since-scan')],
      files: [],
      manual: [...sampleRun.manual, { ruleId: 'x/y', path: 'b.md', line: 1, guidance: 'g' }],
    };
    expect(formatFixSummary(run)).toBe(
      [
        'No fixes applied.',
        'Not applied: 1 fix',
        '  safe    a/b  T: the file changed since the scan',
        'Left: CLAUDE.md:3 instr/import-unresolved (create docs/setup.md or correct the path)',
        '      b.md:1 x/y (g)',
        '',
      ].join('\n'),
    );
  });
});

describe('credential redaction', () => {
  it('never shows the token, in the diff, notes or manual steps', () => {
    for (const ascii of [false, true]) {
      const text = plain(secretRun, ascii);
      expect(text).not.toContain(GITHUB_TOKEN);
      expect(text).not.toContain(GITHUB_TOKEN.slice(4));
      expect(text).not.toContain(OPENAI_KEY);
    }
    const text = plain(secretRun);
    expect(text).toContain('-        "GITHUB_TOKEN": "ghp_…(40 chars)"');
    // The fix writes the literal environment reference `${GITHUB_TOKEN}`, not a template.
    const envReference = ['$', '{GITHUB_TOKEN}'].join('');
    expect(text).toContain(`+        "GITHUB_TOKEN": "${envReference}"`);
    expect(text).toContain(`export OPENAI_API_KEY=sk-p…(${OPENAI_KEY.length} chars)`);
    expect(text).toContain('note: replaces ghp_…(40 chars)');
  });

  it('frames a credential fix with its warning, before and after', () => {
    const blocks = plain(secretRun).split('\n\n');
    const lines = blocks[0]!.split('\n');
    expect(lines[0]).toBe(`!! ${ROTATE}`);
    expect(lines[lines.length - 1]).toBe(`!! ${ROTATE}`);
  });

  it('redacts a marked span the detector does not know', () => {
    const value = 'internal-credential-0000-value';
    const fix = planned('mcp/literal-secret', {
      class: 'review',
      title: 'Replace it',
      changes: [
        {
          kind: 'edit',
          path: 'a.json',
          edits: [{ offset: 9, length: value.length, text: '${X}' }],
        },
      ],
    });
    const run: FixRun = {
      mode: 'dry-run',
      fixes: [fix],
      files: [edited('a.json', `{"key": "${value}"}\n`, '{"key": "${X}"}\n')],
      manual: [],
      verification: { resolved: 1, remaining: 0, introduced: [] },
    };
    const text = plain(run);
    expect(text).not.toContain(value);
    expect(text).toContain('-{"key": "inte…(30 chars)"}');
  });
});

describe('formatFixDiff safety', () => {
  const runs = [sampleRun, secretRun, hostileRun, writtenRun];

  it('writes no ESC, BEL or other unsafe code point', () => {
    for (const run of runs) {
      for (const output of [plain(run), plain(run, true), formatFixSummary(run)]) {
        expect(hasEscOrBel(output)).toBe(false);
        expect(unsafeCodePoints(output, { newline: true, tab: true })).toEqual([]);
      }
    }
  });

  it('starts no line with a workflow command', () => {
    for (const run of runs) {
      for (const output of [plain(run), formatFixSummary(run)]) {
        expect(commandLines(output)).toEqual([]);
      }
    }
    expect(plain(hostileRun)).toContain(' <U+003A>:stop-commands::x');
  });

  it('with real ANSI colors, every escape sequence comes from the style', () => {
    for (const run of runs) {
      const output = formatFixDiff(run, { style: ansiStyle });
      const stripped = stripKnownSgr(output);
      expect(hasEscOrBel(stripped)).toBe(false);
      expect(stripped).toBe(plain(run));
      const summary = formatFixSummary(run, { style: ansiStyle });
      expect(stripKnownSgr(summary)).toBe(formatFixSummary(run));
    }
    expect(formatFixDiff(sampleRun, { style: ansiStyle })).toContain('\u001b[32m+@AGENTS.md');
  });

  it('ends with exactly one newline', () => {
    for (const run of runs) {
      expect(plain(run)).toMatch(/[^\n]\n$/);
      expect(formatFixSummary(run)).toMatch(/[^\n]\n$/);
    }
  });
});

describe('fixes that need input', () => {
  const WHEN =
    'input   skill/description-quality  .agents/skills/release-notes/SKILL.md:3  needs your words: a "Use when ..." clause (agentcheckup fix -i)';
  const KEEP =
    'input   skill/non-portable-field  .claude/skills/deploy/SKILL.md:4  needs your words: a reason to keep "user-invocable" (agentcheckup fix -i)';

  it('lists them as input lines before the manual steps, without a diff, and counts them', () => {
    const output = plain(inputRun);
    const before = plain(sampleRun);
    const verified = 'Verified on an in-memory copy: 5 findings resolved, 0 new, 1 left.\n';
    expect(output.slice(0, before.indexOf('manual  '))).toBe(
      before.slice(0, before.indexOf('manual  ')),
    );
    expect(output.slice(before.indexOf('manual  '))).toBe(
      [
        WHEN,
        KEEP,
        'manual  instr/import-unresolved  CLAUDE.md:3  create docs/setup.md or correct the path',
        verified.trimEnd(),
        '2 fixes need your words: run agentcheckup fix -i to answer them.',
        '',
      ].join('\n'),
    );
  });

  it('prints nothing about them when there are none', () => {
    expect(plain({ ...sampleRun, awaitingInput: [] })).toBe(plain(sampleRun));
    expect(formatFixSummary({ ...writtenRun, awaitingInput: [] })).toBe(
      formatFixSummary(writtenRun),
    );
  });

  it('does not say "Nothing to fix." when only input is missing', () => {
    const run: FixRun = {
      mode: 'dry-run',
      fixes: [],
      files: [],
      manual: [],
      verification: { resolved: 0, remaining: 1, introduced: [] },
      awaitingInput: [INPUTS[1]!],
    };
    expect(plain(run)).toBe(
      `${KEEP}\n1 fix needs your words: run agentcheckup fix -i to answer it.\n`,
    );
    expect(formatFixDiff(run, { style: tagStyle })).toContain(
      '<blue>input</blue>   skill/non-portable-field',
    );
  });

  it('puts pathBase in front and sanitizes what the repository controls', () => {
    expect(plain({ ...inputRun, pathBase: 'sub' })).toContain(
      'input   skill/non-portable-field  sub/.claude/skills/deploy/SKILL.md:4  needs your words',
    );
    const hostile = awaiting('evil\u001b[2J/rule', {
      field: 'suppression-reason',
      question: HOSTILE_ALL,
      label: HOSTILE_ALL,
      target: {
        kind: 'directive',
        path: `x${HOSTILE.osc52Clipboard}/AGENTS.md`,
        line: 1,
        ruleId: 'r/x',
      },
    });
    const output = plain({ ...sampleRun, awaitingInput: [hostile] });
    expect(hasEscOrBel(output)).toBe(false);
    expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
    expect(output).not.toMatch(/^::/m);
  });

  it('lists them in the summary after a write', () => {
    const text = formatFixSummary({ ...writtenRun, awaitingInput: INPUTS });
    expect(text).toContain(
      [
        '  safe    json/duplicate-key  Delete the first "docs" in .mcp.json: it overlaps a fix that goes first; run agentcheckup fix again',
        WHEN,
        KEEP,
        '2 fixes need your words: run agentcheckup fix -i to answer them.',
        'Left: CLAUDE.md:3 instr/import-unresolved (create docs/setup.md or correct the path)',
      ].join('\n'),
    );
  });
});

describe('findings that need judgment', () => {
  const verified = 'Verified on an in-memory copy: 5 findings resolved, 0 new, 1 left';

  it('ends the verification line of the dry run with the tasks command', () => {
    const output = plain({ ...sampleRun, judgment: 3 });
    expect(output).toContain(`\n${verified} · 3 need judgment: agentcheckup tasks\n`);
    expect(output).not.toContain(`${verified}.`);
    expect(plain({ ...sampleRun, judgment: 1 })).toContain(
      `\n${verified} · 1 needs judgment: agentcheckup tasks\n`,
    );
    expect(plain({ ...sampleRun, judgment: 3 }, true)).toContain(
      `\n${verified} - 3 need judgment: agentcheckup tasks\n`,
    );
  });

  it('says nothing when no finding needs judgment', () => {
    expect(plain({ ...sampleRun, judgment: 0 })).toBe(plain(sampleRun));
    expect(plain({ ...sampleRun, judgment: undefined })).toBe(plain(sampleRun));
  });

  it('is the last line when nothing is planned, after the fixes that need words', () => {
    const run: FixRun = {
      mode: 'dry-run',
      fixes: [],
      files: [],
      manual: sampleRun.manual,
      verification: { resolved: 0, remaining: 2, introduced: [] },
      awaitingInput: [INPUTS[1]!],
      judgment: 2,
    };
    expect(plain(run).split('\n').slice(-3)).toEqual([
      '1 fix needs your words: run agentcheckup fix -i to answer it.',
      '2 findings need judgment: agentcheckup tasks',
      '',
    ]);
    expect(plain({ ...run, awaitingInput: [], judgment: 1 })).toBe(
      'Nothing to fix.\nmanual  instr/import-unresolved  CLAUDE.md:3  create docs/setup.md or correct the path\n1 finding needs judgment: agentcheckup tasks\n',
    );
  });

  it('leaves the summary after --write alone', () => {
    expect(formatFixSummary({ ...writtenRun, judgment: 3 })).toBe(formatFixSummary(writtenRun));
  });
});
