import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { DIRECTIVE_RULES } from '../../src/core/directive-rules.js';
import { RULESET_VERSION, TOOL_NAME } from '../../src/core/meta.js';
import { decode } from '../../src/core/text.js';
import type { AnyRule, Artifact, FileChange } from '../../src/core/types.js';
import { VERSION } from '../../src/core/version.js';
import { createFile, insertLine, replaceSpan } from '../../src/fix/edits.js';
import { fixRounds, type FixRun, type FixSelection } from '../../src/fix/index.js';
import { builtinRules } from '../../src/rules/index.js';
import {
  fenceFor,
  formatSuggestionsJson,
  MAX_COMMENT_LENGTH,
  MAX_SUGGESTIONS,
  type ReviewComment,
  SUGGESTION_MARKER_PREFIX,
  SUGGESTION_SKIP_REASONS,
  SUGGESTIONS_JSON_SCHEMA,
  type SuggestionsReport,
  toSuggestionsReport,
} from '../../src/report/suggestions-json.js';
import {
  type DiffRanges,
  type LineRange,
  parseUnifiedDiff,
} from '../../src/report/unified-diff.js';
import { utf8Bom } from '../fix/helpers.js';
import { testRule } from '../fix/helpers.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';
import { GITHUB_TOKEN } from './fix-fixtures.js';
import { unsafeCodePoints } from './safety.js';

const ajv = new Ajv2020({ strict: true, allErrors: true });
const schema = JSON.parse(
  readFileSync(new URL('../../schemas/suggestions.schema.json', import.meta.url), 'utf8'),
) as object;
const validate = ajv.compile<SuggestionsReport>(schema);

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Test rules on AGENTS.md
// ---------------------------------------------------------------------------------------------

function lines(artifact: Artifact): string[] {
  return artifact.decoded.text.split('\n');
}

/** Replaces each `todo` with `TODO`: one finding and one safe fix per occurrence. */
const upper = testRule({
  id: 'test/upper',
  check(context, artifact) {
    const { text } = artifact.decoded;
    for (
      let offset = text.indexOf('todo');
      offset !== -1;
      offset = text.indexOf('todo', offset + 1)
    ) {
      context.report({
        artifact,
        message: 'todo is lower case.',
        span: { offset, length: 4 },
        fix: {
          id: 'test/upper#replace',
          class: 'safe',
          title: 'Write TODO',
          changes: [replaceSpan(artifact, { offset, length: 4 }, 'TODO')],
        },
      });
    }
  },
});

/** One safe fix with two edits: `alpha` and `omega` get a capital letter. */
const pair = testRule({
  id: 'test/pair',
  check(context, artifact) {
    const { text } = artifact.decoded;
    const alpha = text.indexOf('alpha');
    const omega = text.indexOf('omega');
    if (alpha === -1 || omega === -1) return;
    const change: FileChange = {
      kind: 'edit',
      path: artifact.path,
      edits: [
        { offset: alpha, length: 1, text: 'A' },
        { offset: omega, length: 1, text: 'O' },
      ],
    };
    context.report({
      artifact,
      message: 'alpha and omega are lower case.',
      fix: { id: 'test/pair#both', class: 'safe', title: 'Capitalize', changes: [change] },
    });
  },
});

/** `# Spaced` with two blank lines after it gets a third: an insertion inside a run of blanks. */
const spacing = testRule({
  id: 'test/spacing',
  check(context, artifact) {
    const all = lines(artifact);
    if (all[0] !== '# Spaced' || all[1] !== '' || all[2] !== '' || all[3] === '') return;
    context.report({
      artifact,
      message: 'Three blank lines are expected.',
      fix: {
        id: 'test/spacing#blank',
        class: 'safe',
        title: 'Add a blank line',
        changes: [insertLine(artifact, 1, '')],
      },
    });
  },
});

/** `See the notes.` without notes.md: a safe fix that creates it and edits the line. */
const notes = testRule({
  id: 'test/notes',
  check(context, artifact) {
    const offset = artifact.decoded.text.indexOf('See the notes.');
    if (offset === -1 || context.snapshot.paths.has('notes.md')) return;
    context.report({
      artifact,
      message: 'notes.md is missing.',
      fix: {
        id: 'test/notes#create',
        class: 'safe',
        title: 'Create notes.md',
        changes: [
          createFile('notes.md', '# Notes\n'),
          replaceSpan(artifact, { offset, length: 14 }, 'See notes.md.'),
        ],
      },
    });
  },
});

/** `LONG` becomes a line too long for a comment; `FENCE` a line with backtick runs. */
const replace = testRule({
  id: 'test/replace',
  check(context, artifact) {
    const { text } = artifact.decoded;
    const words: [string, string][] = [
      ['LONG', 'x'.repeat(MAX_COMMENT_LENGTH)],
      ['FENCE', 'Run ```` and ``` as code'],
    ];
    for (const [word, replacement] of words) {
      const offset = text.indexOf(word);
      if (offset === -1) continue;
      context.report({
        artifact,
        message: `${word} is here.`,
        fix: {
          id: `test/replace#${word.toLowerCase()}`,
          class: 'safe',
          title: `Replace ${word}`,
          changes: [replaceSpan(artifact, { offset, length: word.length }, replacement)],
        },
      });
    }
  },
});

/** `Review me.` gets a review fix. */
const review = testRule({
  id: 'test/review',
  check(context, artifact) {
    const offset = artifact.decoded.text.indexOf('Review me.');
    if (offset === -1) return;
    context.report({
      artifact,
      message: 'Needs review.',
      fix: {
        id: 'test/review#fix',
        class: 'review',
        title: 'Reviewed',
        changes: [replaceSpan(artifact, { offset, length: 10 }, 'Reviewed.')],
      },
    });
  },
});

const TEST_RULES: readonly AnyRule[] = [upper, pair, spacing, notes, replace, review];
const RULE_META = [
  ...builtinRules.map((rule) => rule.meta),
  ...DIRECTIVE_RULES,
  ...TEST_RULES.map((rule) => rule.meta),
];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const SAFE: FixSelection = { classes: new Set(['safe']), literalSecret: false };

interface Outcome {
  readonly report: SuggestionsReport;
  readonly run: FixRun;
  readonly files: FileMap;
}

const reports: SuggestionsReport[] = [];

/** The whole of every file as one diff range: every line can carry a comment. */
function wholeFiles(files: FileMap): DiffRanges {
  const ranges = new Map<string, LineRange[]>();
  for (const [path, content] of Object.entries(files)) {
    const { text } = decode(
      typeof content === 'string' ? new TextEncoder().encode(content) : content,
    );
    const count = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    if (count > 0) ranges.set(path, [{ start: 1, end: count }]);
  }
  return { files: ranges, truncated: false };
}

function suggest(
  files: FileMap,
  options: {
    readonly rules?: readonly AnyRule[];
    readonly diff?: DiffRanges | string;
    readonly ruleIds?: ReadonlySet<string>;
  } = {},
): Outcome {
  const snapshot = snapshotFrom(files);
  const selection: FixSelection =
    options.ruleIds === undefined ? SAFE : { ...SAFE, ruleIds: options.ruleIds };
  const run = fixRounds(
    snapshot,
    { rules: options.rules ?? builtinRules, trustDirectives: false },
    selection,
    1,
  );
  const diff =
    typeof options.diff === 'string'
      ? parseUnifiedDiff(options.diff)
      : (options.diff ?? wholeFiles(files));
  const report = toSuggestionsReport({
    snapshot,
    run,
    ruleIds: options.ruleIds,
    diff,
    rules: RULE_META,
    sha256,
  });
  reports.push(report);
  return { report, run, files };
}

/** The lines between the suggestion fence and its closing fence. */
function suggested(comment: ReviewComment | undefined): string[] {
  const body = (comment?.body ?? '').split('\n');
  const fence = (body[0] ?? '').replace('suggestion', '');
  return body.slice(1, body.indexOf(fence, 1));
}

/**
 * The file after committing every suggestion, as GitHub does: the lines from `start_line` (or
 * `line`) through `line` are replaced by the suggested lines. Later lines first, so earlier
 * line numbers stay valid.
 */
function committed(text: string, comments: readonly ReviewComment[]): string {
  const ending = text.endsWith('\n');
  const all = (ending ? text.slice(0, -1) : text).split('\n');
  const sorted = [...comments].sort((a, b) => b.line - a.line);
  for (const comment of sorted) {
    const start = comment.start_line ?? comment.line;
    all.splice(start - 1, comment.line - start + 1, ...suggested(comment));
  }
  return `${all.join('\n')}${ending ? '\n' : ''}`;
}

/** The text of `path` after the verified fixes. */
function fixedText(run: FixRun, path: string): string {
  const file = run.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`${path} was not changed`);
  return decode(file.after).text;
}

function commentsOn(report: SuggestionsReport, path: string): ReviewComment[] {
  return report.comments.filter((comment) => comment.path === path);
}

const SKILL_DEPLOY =
  '---\nname: Deploy\ndescription: Deploys the web app to production when a release tag is pushed.\n---\n\n# Deploy\n';
const SKILL_NOTES =
  '---\ndescription: Writes release notes from the pull requests merged since the last tag.\nlicense: MIT\n---\n\n# Notes\n';
const APPLY_TO = '---\napplyTo:\n  - "**/*.ts"\n  - "**/*.tsx"\n---\nUse strict TypeScript.\n';
const CLAUDE = '# Claude\n\nKeep answers short.\n';
const AGENTS = 'Use pnpm.\n';
const MCP = '{\n  "mcpServers": {\n    "docs": { "url": "https://mcp.example.com/mcp" }\n  }\n}\n';

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe('toSuggestionsReport: changes', () => {
  it('suggests the new line for a replacement within one line', () => {
    const files = { '.agents/skills/deploy/SKILL.md': SKILL_DEPLOY };
    const { report, run } = suggest(files);
    expect(report.comments).toHaveLength(1);
    const [comment] = report.comments;
    expect(comment).toMatchObject({
      path: '.agents/skills/deploy/SKILL.md',
      line: 2,
      side: 'RIGHT',
    });
    expect(comment).not.toHaveProperty('start_line');
    expect(comment).not.toHaveProperty('start_side');
    expect(suggested(comment)).toEqual(['name: deploy']);
    expect(committed(SKILL_DEPLOY, report.comments)).toBe(
      fixedText(run, '.agents/skills/deploy/SKILL.md'),
    );
    expect(report.skipped).toEqual([]);
  });

  it('anchors an insertion on the line before it and repeats that line first', () => {
    const files = { '.agents/skills/notes/SKILL.md': SKILL_NOTES };
    const { report, run } = suggest(files);
    expect(report.comments).toHaveLength(1);
    expect(report.comments[0]).toMatchObject({ line: 1, side: 'RIGHT' });
    expect(report.comments[0]).not.toHaveProperty('start_line');
    expect(suggested(report.comments[0])).toEqual(['---', 'name: notes']);
    expect(committed(SKILL_NOTES, report.comments)).toBe(
      fixedText(run, '.agents/skills/notes/SKILL.md'),
    );
  });

  it('anchors an insertion before line 1 on line 1 and repeats it last', () => {
    const files = { 'AGENTS.md': AGENTS, 'CLAUDE.md': CLAUDE };
    const { report, run } = suggest(files);
    expect(commentsOn(report, 'CLAUDE.md')).toHaveLength(1);
    const [comment] = commentsOn(report, 'CLAUDE.md');
    expect(comment).toMatchObject({ line: 1, side: 'RIGHT' });
    expect(suggested(comment)).toEqual(['@AGENTS.md', '', '# Claude']);
    expect(committed(CLAUDE, report.comments)).toBe(fixedText(run, 'CLAUDE.md'));
  });

  it('anchors an insertion at the end of a file on its last line', () => {
    const rule = testRule({
      id: 'test/footer',
      check(context, artifact) {
        if (artifact.decoded.text.includes('Done.')) return;
        context.report({
          artifact,
          message: 'No footer.',
          fix: {
            id: 'test/footer#add',
            class: 'safe',
            title: 'Add a footer',
            changes: [insertLine(artifact, 2, 'Done.')],
          },
        });
      },
    });
    const files = { 'AGENTS.md': 'one\ntwo\n' };
    const { report, run } = suggest(files, { rules: [rule] });
    expect(report.comments).toHaveLength(1);
    expect(report.comments[0]).toMatchObject({ line: 2 });
    expect(suggested(report.comments[0])).toEqual(['two', 'Done.']);
    expect(committed('one\ntwo\n', report.comments)).toBe(fixedText(run, 'AGENTS.md'));
  });

  it('suggests a replacement of several lines with start_line and start_side', () => {
    const path = '.github/instructions/ts.instructions.md';
    const files = { [path]: APPLY_TO };
    const { report, run } = suggest(files);
    expect(report.comments).toHaveLength(1);
    expect(report.comments[0]).toMatchObject({
      path,
      line: 4,
      start_line: 2,
      side: 'RIGHT',
      start_side: 'RIGHT',
    });
    expect(suggested(report.comments[0])).toEqual(['applyTo: "**/*.ts,**/*.tsx"']);
    expect(committed(APPLY_TO, report.comments)).toBe(fixedText(run, path));
  });

  it('removes whole lines with an empty suggestion', () => {
    const path = '.claude/settings.json';
    const settings =
      '{\n  "model": "claude-sonnet-4-5",\n  "env": {\n    "DEBUG": "1",\n    "DEBUG": "0"\n  }\n}\n';
    const files = { [path]: settings };
    const { report, run } = suggest(files);
    expect(report.comments).toHaveLength(1);
    expect(report.comments[0]).toMatchObject({ path, line: 4 });
    expect(suggested(report.comments[0])).toEqual([]);
    expect(report.comments[0]?.body.startsWith('```suggestion\n```\n')).toBe(true);
    expect(committed(settings, report.comments)).toBe(fixedText(run, path));
  });

  it('gives each change of a fix its own comment', () => {
    const text = 'alpha\none\ntwo\nthree\nomega\n';
    const { report, run } = suggest({ 'AGENTS.md': text }, { rules: [pair] });
    expect(report.comments.map((comment) => [comment.line, suggested(comment)])).toEqual([
      [1, ['Alpha']],
      [5, ['Omega']],
    ]);
    expect(committed(text, report.comments)).toBe(fixedText(run, 'AGENTS.md'));
  });

  it('merges changes on neighboring lines, from several fixes, into one comment', () => {
    const text = 'a todo\nb todo\nc\n';
    const { report, run } = suggest({ 'AGENTS.md': text }, { rules: [upper] });
    expect(report.comments).toHaveLength(1);
    expect(report.comments[0]).toMatchObject({ line: 2, start_line: 1 });
    expect(suggested(report.comments[0])).toEqual(['a TODO', 'b TODO']);
    expect(committed(text, report.comments)).toBe(fixedText(run, 'AGENTS.md'));
  });

  it('gives a change that no edit reaches to every fix of its file', () => {
    // The line diff puts the new blank line after the run of blank lines, not where the edit
    // inserted it; both give the same text.
    const text = '# Spaced\n\n\nBody.\n';
    const { report, run } = suggest({ 'AGENTS.md': text }, { rules: [spacing] });
    expect(report.comments).toHaveLength(1);
    expect(report.comments[0]?.body).toContain('test/spacing');
    expect(committed(text, report.comments)).toBe(fixedText(run, 'AGENTS.md'));
  });

  it('lists every rule of a change in one paragraph per summary and in the marker', () => {
    const { report } = suggest({ '.agents/skills/deploy/SKILL.md': SKILL_DEPLOY });
    const body = report.comments[0]?.body ?? '';
    expect(body).toContain(
      '**agentcheckup** safe fix for [`skill/name-dir-mismatch`](https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/skill/name-dir-mismatch.md), [`skill/name-format`](https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/skill/name-format.md): Sets \\`name\\` to the directory name\\: safe when that is the name in lowercase with hyphens, review otherwise\\.',
    );
    expect(body.split('\n').at(-1)).toMatch(
      /^<!-- agentcheckup-suggestion skill\/name-dir-mismatch,skill\/name-format [\da-f]{12} -->$/,
    );
  });
});

describe('toSuggestionsReport: the comment body', () => {
  it('ends with a marker holding the hash of the path, the range and the lines', () => {
    const { report } = suggest({ '.github/instructions/ts.instructions.md': APPLY_TO }, {});
    const comment = report.comments[0];
    const lastLine = comment?.body.split('\n').at(-1) ?? '';
    const hash = sha256(
      ['.github/instructions/ts.instructions.md', '2', '4', 'applyTo: "**/*.ts,**/*.tsx"'].join(
        '\n',
      ),
    ).slice(0, 12);
    expect(lastLine).toBe(`${SUGGESTION_MARKER_PREFIX}copilot/apply-to ${hash} -->`);
  });

  it('matches the expected body', () => {
    const { report } = suggest({ '.agents/skills/notes/SKILL.md': SKILL_NOTES });
    expect(report.comments[0]?.body).toBe(
      [
        '```suggestion',
        '---',
        'name: notes',
        '```',
        '',
        '**agentcheckup** safe fix for [`skill/name-missing`](https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/skill/name-missing.md): Sets \\`name\\` to the directory name when that is a valid skill name\\.',
        '',
        `${SUGGESTION_MARKER_PREFIX}skill/name-missing ${sha256('.agents/skills/notes/SKILL.md\n1\n1\n---\nname: notes').slice(0, 12)} -->`,
      ].join('\n'),
    );
  });

  it('picks a fence longer than the longest backtick run', () => {
    expect(fenceFor([])).toBe('```');
    expect(fenceFor(['no ticks', 'one ` tick'])).toBe('```');
    expect(fenceFor(['```js'])).toBe('````');
    expect(fenceFor(['a ``` b', '`````'])).toBe('``````');
  });

  it('uses a fence longer than any run of backticks in the lines', () => {
    const { report } = suggest({ 'AGENTS.md': 'FENCE\n' }, { rules: [replace] });
    const body = report.comments[0]?.body ?? '';
    expect(body.startsWith('`````suggestion\nRun ```` and ``` as code\n`````\n')).toBe(true);
  });

  it('keeps everything outside the suggestion free of unsafe characters', () => {
    const { report } = suggest({ 'AGENTS.md': 'a todo\n' }, { rules: [upper] });
    for (const comment of report.comments) {
      const after = comment.body.slice(comment.body.lastIndexOf('```') + 3);
      expect(unsafeCodePoints(after, { newline: true })).toEqual([]);
    }
  });
});

describe('toSuggestionsReport: what is not suggested', () => {
  it('skips a change outside the diff, and one across two of its ranges', () => {
    const text = 'a todo\nb\nc\nd todo\ne\nf\ng todo\n';
    const diff = parseUnifiedDiff(
      [
        '+++ b/AGENTS.md',
        '@@ -1,2 +1,2 @@',
        ' a todo',
        ' b',
        '@@ -7 +7 @@',
        '-g',
        '+g todo',
        '',
      ].join('\n'),
    );
    const { report } = suggest({ 'AGENTS.md': text }, { rules: [upper], diff });
    expect(report.comments.map((comment) => comment.line)).toEqual([1, 7]);
    expect(report.skipped).toEqual([{ reason: 'outside-diff', count: 1 }]);

    const split = parseUnifiedDiff(
      ['+++ b/AGENTS.md', '@@ -1 +1 @@', '-a', '+a todo', '@@ -2 +2 @@', '-b', '+b todo', ''].join(
        '\n',
      ),
    );
    const neighbors = suggest({ 'AGENTS.md': 'a todo\nb todo\n' }, { rules: [upper], diff: split });
    expect(neighbors.report.comments).toEqual([]);
    expect(neighbors.report.skipped).toEqual([{ reason: 'outside-diff', count: 1 }]);
  });

  it('suggests nothing for a file the diff does not touch', () => {
    const { report } = suggest(
      { '.agents/skills/deploy/SKILL.md': SKILL_DEPLOY },
      { diff: { files: new Map(), truncated: false } },
    );
    expect(report.comments).toEqual([]);
    expect(report.skipped).toEqual([{ reason: 'outside-diff', count: 1 }]);
  });

  it('skips a change whose suggested lines hold hidden characters', () => {
    const files = { 'AGENTS.md': AGENTS, 'CLAUDE.md': '# Web ⁧app⁩\n\nShort.\n' };
    const { report } = suggest(files);
    expect(report.comments).toEqual([]);
    expect(report.skipped).toContainEqual({ reason: 'hidden-characters', count: 1 });
  });

  it('skips a change whose suggested lines hold a credential', () => {
    const { report } = suggest(
      { 'AGENTS.md': `todo rotate ${GITHUB_TOKEN}\n` },
      { rules: [upper] },
    );
    expect(report.comments).toEqual([]);
    expect(report.skipped).toEqual([{ reason: 'credential', count: 1 }]);
  });

  it('counts fixes that need review, once each, within --rule', () => {
    const files = { 'AGENTS.md': 'Review me.\na todo\n' };
    const all = suggest(files, { rules: [upper, review] });
    expect(all.report.comments).toHaveLength(1);
    expect(all.report.skipped).toEqual([{ reason: 'not-safe', count: 1 }]);
    const only = suggest(files, { rules: [upper, review], ruleIds: new Set(['test/upper']) });
    expect(only.report.skipped).toEqual([]);
  });

  it('counts a review fix of a built-in rule as not safe', () => {
    const { report } = suggest({ '.mcp.json': MCP });
    expect(report.comments).toEqual([]);
    expect(report.skipped).toEqual([{ reason: 'not-safe', count: 1 }]);
  });

  it('counts a safe fix that verification demoted to review as not safe', () => {
    // A "safe" fix that sets the type of an MCP server, which lets Claude Code start it.
    const activate = testRule({
      id: 'test/activate',
      appliesTo: ['mcp-json'],
      check(context, artifact) {
        const offset = artifact.decoded.text.indexOf('{ "url"');
        if (offset === -1) return;
        context.report({
          artifact,
          message: 'No type.',
          fix: {
            id: 'test/activate#type',
            class: 'safe',
            title: 'Add a type',
            changes: [replaceSpan(artifact, { offset, length: 7 }, '{ "type": "http", "url"')],
          },
        });
      },
    });
    const { report, run } = suggest({ '.mcp.json': MCP }, { rules: [activate] });
    expect(run.skipped.map((planned) => [planned.fix.class, planned.reason])).toEqual([
      ['review', 'verification-failed'],
    ]);
    expect(report.comments).toEqual([]);
    expect(report.skipped).toEqual([{ reason: 'not-safe', count: 1 }]);
  });

  it('skips a fix that renames a file', () => {
    const files = { '.cursor/rules/style.md': '---\ndescription: Style\n---\nUse tabs.\n' };
    const { report } = suggest(files);
    expect(report.comments).toEqual([]);
    expect(report.skipped).toEqual([{ reason: 'renames-file', count: 1 }]);
  });

  it('skips a fix that creates a file, with its edits', () => {
    const text = 'See the notes.\nkeep\na todo\n';
    const { report } = suggest({ 'AGENTS.md': text }, { rules: [notes, upper] });
    expect(report.comments.map((comment) => suggested(comment))).toEqual([['a TODO']]);
    expect(report.skipped).toEqual([{ reason: 'creates-file', count: 1 }]);
  });

  it('skips a fix that changes the encoding, and every fix in that file', () => {
    const path = '.agents/skills/deploy/SKILL.md';
    const { report } = suggest({ [path]: utf8Bom(SKILL_DEPLOY) });
    expect(report.comments).toEqual([]);
    expect(report.skipped.map((skip) => skip.reason)).toEqual(['encoding-change']);
  });

  it('skips a file with a byte order mark', () => {
    const { report } = suggest({ 'AGENTS.md': AGENTS, 'CLAUDE.md': utf8Bom(CLAUDE) });
    expect(report.comments).toEqual([]);
    expect(report.skipped).toEqual([{ reason: 'unsupported-encoding', count: 1 }]);
  });

  it('skips a file with CRLF line endings', () => {
    const { report } = suggest({
      'AGENTS.md': AGENTS,
      'CLAUDE.md': CLAUDE.replaceAll('\n', '\r\n'),
    });
    expect(report.comments).toEqual([]);
    expect(report.skipped).toEqual([{ reason: 'line-endings', count: 1 }]);
  });

  it('skips an insertion into an empty file, which has no line to anchor on', () => {
    const rule = testRule({
      id: 'test/fill',
      check(context, artifact) {
        if (artifact.decoded.text !== '') return;
        context.report({
          artifact,
          message: 'Empty.',
          fix: {
            id: 'test/fill#line',
            class: 'safe',
            title: 'Fill',
            changes: [insertLine(artifact, 0, 'Filled.')],
          },
        });
      },
    });
    const diff: DiffRanges = {
      files: new Map([['AGENTS.md', [{ start: 1, end: 5 }]]]),
      truncated: false,
    };
    const { report } = suggest({ 'AGENTS.md': '' }, { rules: [rule], diff });
    expect(report.comments).toEqual([]);
    expect(report.skipped).toEqual([{ reason: 'outside-diff', count: 1 }]);
  });

  it(`keeps at most ${MAX_SUGGESTIONS} comments and skips a body that is too long`, () => {
    const text = Array.from({ length: MAX_SUGGESTIONS + 5 }, (_, index) => `${index} todo\n-`).join(
      '\n',
    );
    const { report } = suggest({ 'AGENTS.md': `${text}\nLONG\n` }, { rules: [upper, replace] });
    expect(report.comments).toHaveLength(MAX_SUGGESTIONS);
    expect(report.comments.at(-1)?.line).toBe(MAX_SUGGESTIONS * 2 - 1);
    expect(report.skipped).toEqual([{ reason: 'limit', count: 6 }]);
  });

  it('maps the reasons of the verified round', () => {
    const outcome = suggest({ 'AGENTS.md': 'a todo\n' }, { rules: [upper] });
    const [planned] = outcome.run.applied;
    if (planned === undefined) throw new Error('no fix');
    const skip = (
      reason: 'conflict' | 'refused-path' | 'verification-failed' | 'limit' | 'declined',
    ) => ({ ...planned, status: 'skipped', reason }) as const;
    const report = toSuggestionsReport({
      snapshot: snapshotFrom({ 'AGENTS.md': 'a todo\n' }),
      run: {
        ...outcome.run,
        applied: [],
        files: [],
        skipped: [
          skip('refused-path'),
          skip('verification-failed'),
          skip('limit'),
          skip('declined'),
        ],
        deferred: [skip('conflict')],
      },
      diff: wholeFiles(outcome.files),
      rules: RULE_META,
      sha256,
    });
    expect(report.comments).toEqual([]);
    expect(report.skipped).toEqual([
      { reason: 'conflict', count: 1 },
      { reason: 'verification-failed', count: 2 },
      { reason: 'refused-path', count: 1 },
      { reason: 'limit', count: 1 },
    ]);
  });
});

describe('formatSuggestionsJson', () => {
  it('writes the report as JSON with tool, rule set and schema version', () => {
    const { report } = suggest({ 'AGENTS.md': 'a todo\n' }, { rules: [upper] });
    const snapshot = snapshotFrom({ 'AGENTS.md': 'a todo\n' });
    const run = fixRounds(snapshot, { rules: [upper], trustDirectives: false }, SAFE, 1);
    const text = formatSuggestionsJson(
      { snapshot, run, diff: wholeFiles({ 'AGENTS.md': 'a todo\n' }), rules: RULE_META, sha256 },
      { tool: { name: TOOL_NAME, version: '9.9.9' }, ruleset: '2027.01' },
    );
    expect(text.endsWith('}\n')).toBe(true);
    const parsed = JSON.parse(text) as SuggestionsReport;
    expect(parsed).toEqual({
      ...report,
      tool: { name: TOOL_NAME, version: '9.9.9' },
      ruleset: '2027.01',
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.tool).toEqual({ name: TOOL_NAME, version: VERSION });
    expect(report.ruleset).toBe(RULESET_VERSION);
    expect(Object.keys(parsed)).toEqual([
      'schemaVersion',
      'tool',
      'ruleset',
      'comments',
      'skipped',
    ]);
    expect(Object.keys(parsed.comments[0] ?? {})).toEqual(['path', 'line', 'side', 'body']);
  });

  it('escapes invisible characters in the JSON text', () => {
    const files = { 'AGENTS.md': 'todo ‮\n' };
    const snapshot = snapshotFrom(files);
    const run = fixRounds(snapshot, { rules: [upper], trustDirectives: false }, SAFE, 1);
    const text = formatSuggestionsJson({
      snapshot,
      run,
      diff: wholeFiles(files),
      rules: RULE_META,
      sha256,
    });
    expect(unsafeCodePoints(text, { newline: true })).toEqual([]);
  });
});

describe('schemas/suggestions.schema.json', () => {
  it('is the schema the source defines', () => {
    expect(schema).toEqual(JSON.parse(JSON.stringify(SUGGESTIONS_JSON_SCHEMA)));
    expect(SUGGESTIONS_JSON_SCHEMA.$defs.skip.properties.reason.enum).toEqual([
      ...SUGGESTION_SKIP_REASONS,
    ]);
  });

  it('accepts every report of these tests', () => {
    expect(reports.length).toBeGreaterThan(10);
    for (const report of reports) {
      expect(validate(report), ajv.errorsText(validate.errors)).toBe(true);
    }
  });

  it('rejects absolute paths, a start line without its side, and unknown reasons', () => {
    const base = {
      schemaVersion: 1,
      tool: { name: TOOL_NAME, version: VERSION },
      ruleset: RULESET_VERSION,
      skipped: [],
    };
    const comment = { path: 'a.md', line: 2, side: 'RIGHT', body: 'x' };
    expect(validate({ ...base, comments: [comment] })).toBe(true);
    expect(validate({ ...base, comments: [{ ...comment, path: '/etc/passwd' }] })).toBe(false);
    expect(validate({ ...base, comments: [{ ...comment, path: 'a/../../b' }] })).toBe(false);
    expect(validate({ ...base, comments: [{ ...comment, start_line: 1 }] })).toBe(false);
    expect(validate({ ...base, comments: [{ ...comment, side: 'LEFT' }] })).toBe(false);
    expect(validate({ ...base, comments: [], skipped: [{ reason: 'other', count: 1 }] })).toBe(
      false,
    );
  });
});
