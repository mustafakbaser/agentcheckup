import { describe, expect, it } from 'vitest';
import type { FileChange, TextEdit } from '../../src/core/types.js';
import type { PlannedFix } from '../../src/fix/index.js';
import {
  fenceFor,
  isSuggestionComment,
  type LineRange,
  MAX_SUGGESTIONS,
  type ReviewComment,
  SUGGESTION_MARKER,
  suggestionComments,
} from '../../src/report/suggestions.js';
import { applied, GITHUB_TOKEN, planned, skipped } from './fix-fixtures.js';
import { HOSTILE, HOSTILE_ALL } from './hostile.js';
import { unsafeCodePoints } from './safety.js';

const CLAUDE = '# Acme API\n\nUse pnpm.\nRun tests with pnpm test.\n';
const SKILL = '---\nname: Release Notes\ndescription: Write release notes\n---\n\nBody.\n';

function edit(path: string, ...edits: TextEdit[]): FileChange {
  return { kind: 'edit', path, edits };
}

function safeFix(change: FileChange | FileChange[], extra: Partial<PlannedFix['fix']> = {}) {
  return planned('instr/agents-md-ignored-by-claude', {
    class: 'safe',
    title: 'Add "@AGENTS.md" as line 1 of CLAUDE.md',
    changes: Array.isArray(change) ? change : [change],
    ...extra,
  });
}

const texts = new Map([
  ['CLAUDE.md', CLAUDE],
  ['.agents/skills/notes/SKILL.md', SKILL],
]);
const wholeFiles = new Map<string, readonly LineRange[]>([
  ['CLAUDE.md', [{ start: 1, end: 4 }]],
  ['.agents/skills/notes/SKILL.md', [{ start: 1, end: 6 }]],
]);

function suggest(
  fixes: readonly PlannedFix[],
  hunks: ReadonlyMap<string, readonly LineRange[]> = wholeFiles,
  files: ReadonlyMap<string, string> = texts,
): ReviewComment[] {
  return suggestionComments({ fixes, texts: files, hunks });
}

/** The lines between the suggestion fence and its closing fence. */
function suggested(comment: ReviewComment | undefined): string[] {
  const lines = (comment?.body ?? '').split('\n');
  const open = lines.findIndex((line) => line.endsWith('suggestion'));
  const fence = (lines[open] ?? '').replace('suggestion', '');
  const close = lines.indexOf(fence, open + 1);
  return lines.slice(open + 1, close);
}

const importFix = safeFix(edit('CLAUDE.md', { offset: 0, length: 0, text: '@AGENTS.md\n\n' }));
const nameOffset = SKILL.indexOf('Release Notes');
const nameFix = planned('skill/name-format', {
  class: 'safe',
  title: 'Set name to "notes"',
  changes: [
    edit('.agents/skills/notes/SKILL.md', {
      offset: nameOffset,
      length: 'Release Notes'.length,
      text: 'notes',
    }),
  ],
  notes: ['the Claude Code slash command changes to /notes'],
});

describe('suggestionComments', () => {
  it('suggests an insertion at line 1 as a replacement of line 1', () => {
    const [comment] = suggest([importFix]);
    expect(comment).toEqual({
      path: 'CLAUDE.md',
      side: 'RIGHT',
      line: 1,
      body: [
        SUGGESTION_MARKER,
        '**agentcheckup** safe fix for [instr/agents\\-md\\-ignored\\-by\\-claude](https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/instr/agents-md-ignored-by-claude.md): Add &quot;@&#8203;AGENTS\\.md&quot; as line 1 of CLAUDE\\.md',
        '',
        '```suggestion',
        '@AGENTS.md',
        '',
        '# Acme API',
        '```',
        '',
      ].join('\n'),
    });
    expect(isSuggestionComment(comment!.body)).toBe(true);
  });

  it('replaces a span within a line and adds the notes', () => {
    const [comment] = suggest([nameFix]);
    expect(comment).toMatchObject({ path: '.agents/skills/notes/SKILL.md', line: 2 });
    expect(comment).not.toHaveProperty('start_line');
    expect(suggested(comment)).toEqual(['name: notes']);
    expect(comment?.body).toContain('\nNote: the Claude Code slash command changes to /notes\n');
  });

  it('anchors a multi-line change with start_line', () => {
    const offset = CLAUDE.indexOf('Use pnpm.');
    const fix = safeFix(
      edit('CLAUDE.md', { offset, length: 'Use pnpm.\nRun'.length, text: 'Use pnpm 12.\nRun' }),
    );
    const [comment] = suggest([fix]);
    expect(comment).toMatchObject({ line: 4, start_line: 3, start_side: 'RIGHT', side: 'RIGHT' });
    expect(suggested(comment)).toEqual(['Use pnpm 12.', 'Run tests with pnpm test.']);
  });

  it('deletes whole lines with an empty suggestion', () => {
    const offset = CLAUDE.indexOf('Use pnpm.');
    const fix = safeFix(edit('CLAUDE.md', { offset, length: 'Use pnpm.\n'.length, text: '' }));
    const [comment] = suggest([fix]);
    expect(comment).toMatchObject({ line: 3 });
    expect(suggested(comment)).toEqual([]);
    expect(comment?.body.endsWith('```suggestion\n```\n')).toBe(true);
  });

  it('edits a last line without a line break', () => {
    const text = '{\n  "a": 1}';
    const fix = safeFix(edit('a.json', { offset: text.indexOf('1'), length: 1, text: '2' }));
    const [comment] = suggest(
      [fix],
      new Map([['a.json', [{ start: 1, end: 2 }]]]),
      new Map([['a.json', text]]),
    );
    expect(comment).toMatchObject({ line: 2 });
    expect(suggested(comment)).toEqual(['  "a": 2}']);
  });

  it('accepts a change inside a hunk and refuses one that reaches outside every hunk', () => {
    const offset = CLAUDE.indexOf('Use pnpm.');
    const fix = safeFix(
      edit('CLAUDE.md', { offset, length: 'Use pnpm.\nRun'.length, text: 'Use pnpm 12.\nRun' }),
    );
    const hunks = (ranges: LineRange[]) => new Map([['CLAUDE.md', ranges]]);
    expect(suggest([fix], hunks([{ start: 3, end: 4 }]))).toHaveLength(1);
    expect(suggest([fix], hunks([{ start: 4, end: 9 }]))).toEqual([]);
    expect(suggest([fix], hunks([{ start: 1, end: 3 }]))).toEqual([]);
    expect(
      suggest(
        [fix],
        hunks([
          { start: 1, end: 3 },
          { start: 4, end: 4 },
        ]),
      ),
    ).toEqual([]);
    expect(suggest([fix], hunks([{ start: 2.5, end: 9 }]))).toEqual([]);
    expect(suggest([fix], new Map())).toEqual([]);
  });

  it('suggests only planned, safe, single-edit, single-file fixes', () => {
    const insert = { offset: 0, length: 0, text: 'x\n' };
    const refused: PlannedFix[] = [
      { ...importFix, fix: { ...importFix.fix, class: 'review' } },
      applied(importFix),
      skipped('a/b', importFix.fix, 'conflict'),
      safeFix([edit('CLAUDE.md', insert), edit('.agents/skills/notes/SKILL.md', insert)]),
      safeFix(edit('CLAUDE.md', insert, { offset: 5, length: 0, text: 'y' })),
      safeFix(edit('CLAUDE.md')),
      safeFix([]),
      safeFix({ kind: 'create', path: 'new.md', text: 'x\n' }),
      safeFix({ kind: 'rename', from: 'CLAUDE.md', to: 'claude.md' }),
      safeFix({ kind: 'encoding', path: 'CLAUDE.md', to: 'utf-8', bom: false }),
      safeFix(edit('missing.md', insert)),
    ];
    for (const fix of refused) expect(suggest([fix])).toEqual([]);
  });

  it('never suggests a credential fix or a change near a credential', () => {
    const text = `{"env": {"TOKEN": "${GITHUB_TOKEN}"}}\n`;
    const files = new Map([['.mcp.json', text]]);
    const hunks = new Map([['.mcp.json', [{ start: 1, end: 1 }]]]);
    const at = text.indexOf(GITHUB_TOKEN);
    const secretFix = planned('mcp/literal-secret', {
      class: 'safe',
      title: 'Read TOKEN from the environment',
      changes: [edit('.mcp.json', { offset: at, length: GITHUB_TOKEN.length, text: '${TOKEN}' })],
    });
    const warned = planned('other/rule', {
      class: 'safe',
      title: 't',
      changes: [edit('.mcp.json', { offset: 0, length: 1, text: '{ ' })],
      warning: 'Rotate it.',
    });
    const nearby = planned('other/rule', {
      class: 'safe',
      title: 't',
      changes: [edit('.mcp.json', { offset: 0, length: 1, text: '{ ' })],
    });
    expect(suggest([secretFix, warned, nearby], hunks, files)).toEqual([]);
    const writes = safeFix(edit('CLAUDE.md', { offset: 0, length: 0, text: `${GITHUB_TOKEN}\n` }));
    expect(suggest([writes])).toEqual([]);
  });

  it('refuses control, bidi, tag and invisible characters and CR in the suggested lines', () => {
    for (const bad of [
      HOSTILE.bidiOverride,
      HOSTILE.bidiIsolates,
      HOSTILE.tags,
      HOSTILE.zeroWidth,
      HOSTILE.nulAndDel,
      HOSTILE.osc52Clipboard,
      HOSTILE.c1Csi,
      HOSTILE.lineSeparators,
      HOSTILE.loneSurrogates,
      'carriage\rreturn',
    ]) {
      const fix = safeFix(edit('CLAUDE.md', { offset: 0, length: 0, text: `${bad}\n` }));
      expect(suggest([fix]), JSON.stringify(bad)).toEqual([]);
    }
    const crlf = new Map([['CLAUDE.md', CLAUDE.replaceAll('\n', '\r\n')]]);
    expect(suggest([importFix], wholeFiles, crlf)).toEqual([]);
    const hidden = new Map([['CLAUDE.md', `# Acme‮ API\n${CLAUDE}`]]);
    expect(suggest([importFix], wholeFiles, hidden)).toEqual([]);
  });

  it('keeps tabs and emoji', () => {
    const fix = safeFix(
      edit('CLAUDE.md', { offset: 0, length: 0, text: '\tindented 👍\u{1F3FD}\n' }),
    );
    expect(suggested(suggest([fix])[0])).toEqual(['\tindented 👍\u{1F3FD}', '# Acme API']);
  });

  it('refuses changes it cannot express as whole lines', () => {
    const appendAtEnd = safeFix(
      edit('CLAUDE.md', { offset: CLAUDE.length, length: 0, text: 'More.\n' }),
    );
    const joinLines = safeFix(
      edit('CLAUDE.md', { offset: CLAUDE.indexOf('\nRun'), length: 1, text: ' ' }),
    );
    const outOfRange = safeFix(edit('CLAUDE.md', { offset: CLAUDE.length, length: 5, text: '' }));
    const negative = safeFix(edit('CLAUDE.md', { offset: -1, length: 0, text: 'x' }));
    const fractional = safeFix(edit('CLAUDE.md', { offset: 0.5, length: 0, text: 'x' }));
    const noChange = safeFix(edit('CLAUDE.md', { offset: 2, length: 4, text: 'Acme' }));
    for (const fix of [appendAtEnd, joinLines, outOfRange, negative, fractional, noChange]) {
      expect(suggest([fix])).toEqual([]);
    }
    const noFinal = new Map([['a.md', 'one\ntwo']]);
    const hunks = new Map([['a.md', [{ start: 1, end: 2 }]]]);
    const addsFinal = safeFix(edit('a.md', { offset: 7, length: 0, text: '\n' }));
    const deletesLast = safeFix(edit('a.md', { offset: 4, length: 3, text: '' }));
    expect(suggest([addsFinal, deletesLast], hunks, noFinal)).toEqual([]);
    expect(suggest([importFix], wholeFiles, new Map([['CLAUDE.md', '']]))).toEqual([]);
  });

  it('keeps the first of two suggestions on overlapping lines', () => {
    const second = safeFix(edit('CLAUDE.md', { offset: 2, length: 4, text: 'ACME' }));
    const elsewhere = safeFix(
      edit('CLAUDE.md', { offset: CLAUDE.indexOf('pnpm.'), length: 4, text: 'npm' }),
    );
    const comments = suggest([importFix, second, elsewhere]);
    expect(comments.map((comment) => comment.line)).toEqual([1, 3]);
  });

  it(`returns at most ${MAX_SUGGESTIONS} comments`, () => {
    const many = Array.from({ length: MAX_SUGGESTIONS + 5 }, (_, index) => `line ${index}\n`).join(
      '',
    );
    const fixes = Array.from({ length: MAX_SUGGESTIONS + 5 }, (_, index) =>
      safeFix(
        edit('many.md', { offset: many.indexOf(`line ${index}\n`), length: 4, text: 'LINE' }),
      ),
    );
    const comments = suggest(
      fixes,
      new Map([['many.md', [{ start: 1, end: MAX_SUGGESTIONS + 5 }]]]),
      new Map([['many.md', many]]),
    );
    expect(comments).toHaveLength(MAX_SUGGESTIONS);
  });

  it('is deterministic', () => {
    expect(suggest([importFix, nameFix])).toEqual(suggest([importFix, nameFix]));
  });
});

describe('suggestion fences', () => {
  it('is longer than the longest backtick run', () => {
    expect(fenceFor([])).toBe('```');
    expect(fenceFor(['no ticks', 'one ` tick'])).toBe('```');
    expect(fenceFor(['```js'])).toBe('````');
    expect(fenceFor(['a ``` b', '`````'])).toBe('``````');
  });

  it('cannot be closed by the suggested lines', () => {
    const fix = safeFix(
      edit('CLAUDE.md', { offset: 0, length: 0, text: '```\n````\n```suggestion\n' }),
    );
    const [comment] = suggest([fix]);
    expect(comment?.body).toContain(
      '\n`````suggestion\n```\n````\n```suggestion\n# Acme API\n`````\n',
    );
    expect(suggested(comment)).toEqual(['```', '````', '```suggestion', '# Acme API']);
  });
});

describe('suggestion bodies', () => {
  it('render titles, notes and rule ids literally', () => {
    const fix = planned('evil:rule,title=x', {
      class: 'safe',
      title: HOSTILE_ALL,
      changes: [edit('CLAUDE.md', { offset: 0, length: 0, text: 'x\n' })],
      notes: [HOSTILE.html, HOSTILE.links, HOSTILE.mentions, '</details>\n\n# Injected'],
    });
    const [comment] = suggest([fix]);
    const body = comment?.body ?? '';
    expect(body.startsWith(`${SUGGESTION_MARKER}\n`)).toBe(true);
    expect(body).not.toContain('<img');
    expect(body).not.toContain('<script');
    expect(body).not.toContain('</details>');
    expect(body).not.toContain('[click](');
    expect(body).not.toContain('@octocat');
    expect(body).not.toContain('\n# Injected');
    expect(body).not.toContain('](https://github.com');
    expect(body).toContain('evil:rule,title=x'.replace(':', '\\:'));
    const outside = body.split('\n').slice(0, -5).join('\n');
    expect(unsafeCodePoints(outside, { newline: true, tab: true })).toEqual([]);
    expect(suggested(comment)).toEqual(['x', '# Acme API']);
  });

  it('finds earlier comments by the marker', () => {
    expect(isSuggestionComment(`${SUGGESTION_MARKER}\nbody`)).toBe(true);
    expect(isSuggestionComment(`quoted ${SUGGESTION_MARKER}`)).toBe(false);
  });
});
