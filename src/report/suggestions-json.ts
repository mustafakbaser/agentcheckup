/**
 * `agentcheckup fix --format suggestions`: the safe fixes of one verified round as review
 * comments with suggested changes, for the GitHub Action to post on a pull request
 * (schemas/suggestions.schema.json). Pure: the CLI reads the pull request's diff and the head
 * version of the repository; the Action posts the comments.
 *
 * A suggestion replaces whole lines of the head version, so each change is taken from the line
 * diff of a file before and after the fixes, without context: each hunk of that diff is one
 * comment.
 * - A hunk that replaces lines suggests its new lines for them; one that only removes lines
 *   suggests nothing, which deletes them.
 * - A hunk that only inserts lines has no line of its own to anchor on. It anchors on the line
 *   before the insertion and repeats it above the new lines; an insertion before line 1 anchors
 *   on line 1 and repeats it below them. An empty file has no line to anchor on.
 * - A comment needs its whole range inside one range of the pull request's diff
 *   (`outside-diff` otherwise).
 *
 * The comment body is the suggestion, the first sentence of each rule's fix summary and a
 * hidden marker, `<!-- agentcheckup-suggestion <rule ids> <hash> -->`, with the first 12 hex
 * digits of the SHA-256 of the path, the range and the suggested lines. The Action compares
 * markers to skip a comment it already posted. The suggested lines are the exact text of the
 * fixed file, so they are not escaped: a change whose lines hold a control, bidirectional, tag or
 * other invisible character (anything `forTerminal` would rewrite) is skipped
 * (`hidden-characters`), and so is one with a credential the secret detector finds
 * (`credential`). The fence is longer than any run of backticks in the lines. Everything else in
 * the body is rule metadata, escaped with `forMarkdown`.
 *
 * A fix is suggested only when every file it touches can be: a fix that creates or renames a
 * file, or changes an encoding or byte order mark, is skipped whole, and so is a fix that touches
 * a file that is not UTF-8 without a byte order mark or uses CRLF line endings, whose bytes a
 * suggestion cannot be trusted to keep. Hunks are matched to fixes by the offsets of their edits;
 * a hunk no edit reaches belongs to every fix of its file. Fixes the verified round left out are
 * counted under their reason, and fixes that need review under `not-safe`. At most
 * {@link MAX_SUGGESTIONS} comments are returned, by path and line.
 */
import { compareStrings } from '../core/compare.js';
import { RULESET_VERSION, TOOL_NAME } from '../core/meta.js';
import { decode } from '../core/text.js';
import type { DecodedText, RuleMeta, Snapshot, TextEdit } from '../core/types.js';
import { VERSION } from '../core/version.js';
import { compileFix, createWorkspace } from '../fix/compile.js';
import {
  type DiffHunk,
  type FileDiff,
  fixKey,
  type FixRun,
  type FixSkipReason,
  type PlannedFix,
} from '../fix/index.js';
import { findSecret } from '../rules/mcp/secrets.js';
import { fixOf, isSafeRuleId } from './feedback.js';
import { diffHunks } from './fix-diff.js';
import { escaped, ruleLink } from './markdown-common.js';
import { forJsonOutput, forTerminal } from './sanitize.js';
import { type DiffRanges, insideOneRange } from './unified-diff.js';

/** Comments returned per call: a review with more is noise. */
export const MAX_SUGGESTIONS = 50;

/**
 * A review comment as GitHub's "create a review" API takes it (`comments[]`): a single line, or
 * `start_line` through `line`, on the head side of the diff.
 */
export interface ReviewComment {
  readonly path: string;
  readonly body: string;
  readonly side: 'RIGHT';
  readonly line: number;
  readonly start_line?: number;
  readonly start_side?: 'RIGHT';
}

function longestBacktickRun(lines: readonly string[]): number {
  let longest = 0;
  for (const line of lines) {
    let run = 0;
    for (const char of line) {
      run = char === '`' ? run + 1 : 0;
      if (run > longest) longest = run;
    }
  }
  return longest;
}

/** A code fence that none of `lines` can close: longer than any backtick run in them. */
export function fenceFor(lines: readonly string[]): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(lines) + 1));
}

/**
 * Why a fix, or one change of it, is not suggested.
 * - `outside-diff`: the lines it changes are not all inside one hunk of the pull request.
 * - `not-safe`: the fix needs review, or verification found it adds or changes an MCP server,
 *   hook, permission or env override.
 * - `creates-file`, `renames-file`: a suggestion can only change lines of an existing file.
 * - `encoding-change`: the fix changes the encoding or byte order mark of a file.
 * - `unsupported-encoding`: the file is UTF-16 or has a byte order mark.
 * - `line-endings`: the file uses CRLF line endings, all or some.
 * - `hidden-characters`: a suggested line holds a control, bidirectional, tag or other
 *   invisible character.
 * - `credential`: a suggested line holds a credential.
 * - `conflict`: it overlaps a fix that goes first; it may be suggested once that one is applied.
 * - `verification-failed`: the re-scan showed it does not resolve its finding or adds a problem.
 * - `refused-path`: it changes a path a fix may not touch, such as a file behind a symlink.
 * - `limit`: past a limit: fixes per run, comments per review or the length of a comment.
 */
export const SUGGESTION_SKIP_REASONS = [
  'outside-diff',
  'not-safe',
  'creates-file',
  'renames-file',
  'encoding-change',
  'unsupported-encoding',
  'line-endings',
  'hidden-characters',
  'credential',
  'conflict',
  'verification-failed',
  'refused-path',
  'limit',
] as const;
export type SuggestionSkipReason = (typeof SUGGESTION_SKIP_REASONS)[number];

/** How many fixes, or for the reasons about one change, how many changes, were left out. */
export interface SuggestionSkip {
  readonly reason: SuggestionSkipReason;
  readonly count: number;
}

/** Output of `agentcheckup fix --format suggestions`. */
export interface SuggestionsReport {
  readonly schemaVersion: 1;
  readonly tool: { readonly name: string; readonly version: string };
  readonly ruleset: string;
  /** In the shape of `comments[]` of GitHub's "create a review" API. */
  readonly comments: readonly ReviewComment[];
  /** Only reasons with a count, in the order of {@link SUGGESTION_SKIP_REASONS}. */
  readonly skipped: readonly SuggestionSkip[];
}

export interface SuggestionInput {
  /** The repository as scanned: the pull request's head. */
  readonly snapshot: Snapshot;
  /** One round of `fixRounds` on {@link snapshot}, safe fixes only, without credential fixes. */
  readonly run: Pick<FixRun, 'before' | 'files' | 'applied' | 'skipped' | 'deferred'>;
  /** `--rule`: the rules whose fixes were selected. Every rule when absent. */
  readonly ruleIds?: ReadonlySet<string> | undefined;
  /** The pull request's diff. */
  readonly diff: DiffRanges;
  /** Metadata of the rules, for the reason under each suggestion. */
  readonly rules: readonly RuleMeta[];
  /** The lowercase hex SHA-256 of the UTF-8 bytes of a string, for the marker. */
  readonly sha256: (text: string) => string;
}

export interface SuggestionsJsonOptions {
  /** Default: agentcheckup and its version. */
  readonly tool?: { readonly name: string; readonly version: string } | undefined;
  /** Default: the rule set of this build. */
  readonly ruleset?: string | undefined;
}

/** The start of the marker comment at the end of every body. */
export const SUGGESTION_MARKER_PREFIX = '<!-- agentcheckup-suggestion ';

/** Hex digits of the hash in the marker. */
const MARKER_HASH_LENGTH = 12;

/** GitHub refuses comment bodies over 65,536 characters; this leaves room. */
export const MAX_COMMENT_LENGTH = 60_000;

/** The rule's fix summary is cut after this many code points. */
const MAX_REASON_LENGTH = 300;

/** Skip reasons of the verified round, as far as a dry run can give them. */
const ROUND_REASONS: Readonly<Partial<Record<FixSkipReason, SuggestionSkipReason>>> = {
  conflict: 'conflict',
  'refused-path': 'refused-path',
  'verification-failed': 'verification-failed',
  limit: 'limit',
};

/** A fix of the round, with what it does to each file and whether it can be suggested. */
interface Shape {
  readonly planned: PlannedFix;
  /** Its edits on the scanned text, by path. */
  readonly edits: ReadonlyMap<string, readonly TextEdit[]>;
  readonly reason: SuggestionSkipReason | undefined;
}

/** One suggestion: lines `start` through `end` of `path` become `lines`. */
interface Suggestion {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
  readonly ruleIds: readonly string[];
}

class Counter {
  private readonly counts = new Map<SuggestionSkipReason, number>();

  add(reason: SuggestionSkipReason, count = 1): void {
    if (count > 0) this.counts.set(reason, (this.counts.get(reason) ?? 0) + count);
  }

  list(): SuggestionSkip[] {
    return SUGGESTION_SKIP_REASONS.flatMap((reason) => {
      const count = this.counts.get(reason) ?? 0;
      return count === 0 ? [] : [{ reason, count }];
    });
  }
}

/** Why no fix touching this file can be suggested, or undefined when fixes can be. */
function fileProblem(
  file: FileDiff,
  before: DecodedText | undefined,
  after: DecodedText,
): SuggestionSkipReason | undefined {
  if (file.op === 'create' || before === undefined) return 'creates-file';
  if (file.op === 'rename') return 'renames-file';
  if (before.encoding !== after.encoding || before.hasBom !== after.hasBom) {
    return 'encoding-change';
  }
  if (before.encoding !== 'utf-8' || before.hasBom) return 'unsupported-encoding';
  const crlf = (decoded: DecodedText): boolean =>
    decoded.lineEnding === 'crlf' || decoded.lineEnding === 'mixed';
  if (crlf(before) || crlf(after)) return 'line-endings';
  return undefined;
}

function shapeOf(
  planned: PlannedFix,
  workspace: ReturnType<typeof createWorkspace>,
  problems: ReadonlyMap<string, SuggestionSkipReason | undefined>,
): Shape {
  const compiled = compileFix(planned.fix, workspace);
  if (!compiled.ok) return { planned, edits: new Map(), reason: 'verification-failed' };
  const { files, creates } = compiled.compiled;
  const edits = new Map(files.map((file) => [file.origin, file.edits]));
  let reason: SuggestionSkipReason | undefined;
  if (creates.length > 0) reason = 'creates-file';
  else if (files.some((file) => file.path !== file.origin)) reason = 'renames-file';
  else if (files.some((file) => file.reencode)) reason = 'encoding-change';
  else reason = files.map((file) => problems.get(file.origin)).find((found) => found !== undefined);
  return { planned, edits, reason };
}

/** Lines of a decoded text, as the line diff counts them: a final line break ends the last. */
function lineCount(decoded: DecodedText): number {
  if (decoded.text === '') return 0;
  return decoded.text.endsWith('\n') ? decoded.lineStarts.length - 1 : decoded.lineStarts.length;
}

/** Line `line` (1-based) without its line ending. */
function lineAt(decoded: DecodedText, line: number): string {
  const start = decoded.lineStarts[line - 1] ?? decoded.text.length;
  const end = decoded.lineStarts[line] ?? decoded.text.length;
  let text = decoded.text.slice(start, end);
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text.endsWith('\r')) text = text.slice(0, -1);
  return text;
}

/** The offsets of the scanned text a hunk covers: its old lines, or its insertion point. */
function spanOf(hunk: DiffHunk, decoded: DecodedText): { start: number; end: number } {
  const { lineStarts, text } = decoded;
  if (hunk.oldLines === 0) {
    const point = hunk.oldStart === 0 ? 0 : (lineStarts[hunk.oldStart] ?? text.length);
    return { start: point, end: point };
  }
  return {
    start: lineStarts[hunk.oldStart - 1] ?? text.length,
    end: lineStarts[hunk.oldStart - 1 + hunk.oldLines] ?? text.length,
  };
}

function touches(edit: TextEdit, span: { start: number; end: number }): boolean {
  return edit.offset <= span.end && edit.offset + edit.length >= span.start;
}

/**
 * The lines a hunk replaces and the lines it suggests, as the module comment describes.
 * Undefined for an insertion into an empty file.
 */
function replacementOf(
  hunk: DiffHunk,
  before: DecodedText,
): { start: number; end: number; lines: string[] } | undefined {
  // Hunk lines start with their mark; `\ No newline at end of file` is not a line.
  const added = hunk.lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1));
  if (hunk.oldLines > 0) {
    return { start: hunk.oldStart, end: hunk.oldStart + hunk.oldLines - 1, lines: added };
  }
  if (hunk.oldStart > 0) {
    return {
      start: hunk.oldStart,
      end: hunk.oldStart,
      lines: [lineAt(before, hunk.oldStart), ...added],
    };
  }
  if (lineCount(before) === 0) return undefined;
  return { start: 1, end: 1, lines: [...added, lineAt(before, 1)] };
}

/** A line that every output sanitizer leaves alone: no control or invisible character. */
function isPlainLine(line: string): boolean {
  return forTerminal(line) === line;
}

/** The first sentence of a fix summary. */
function firstSentence(text: string): string {
  const end = text.indexOf('. ');
  return end === -1 ? text : text.slice(0, end + 1);
}

/**
 * One paragraph per fix summary: `**agentcheckup** safe fix for <rules>: <first sentence>`. Rules
 * whose fixes share a summary share a paragraph.
 */
function reasonLines(ruleIds: readonly string[], rules: ReadonlyMap<string, RuleMeta>): string[] {
  const groups = new Map<string, string[]>();
  for (const ruleId of ruleIds) {
    const summary = rules.get(ruleId)?.fix?.summary;
    const reason = summary === undefined ? '' : firstSentence(summary);
    const links = groups.get(reason) ?? [];
    links.push(ruleLink(ruleId, MAX_REASON_LENGTH));
    groups.set(reason, links);
  }
  return [...groups].map(([reason, links]) => {
    const text = reason === '' ? '' : `: ${escaped(reason, MAX_REASON_LENGTH)}`;
    return `**agentcheckup** safe fix for ${links.join(', ')}${text}`;
  });
}

function bodyOf(
  suggestion: Suggestion,
  rules: ReadonlyMap<string, RuleMeta>,
  sha256: (text: string) => string,
): string {
  const { path, start, end, lines, ruleIds } = suggestion;
  const fence = fenceFor(lines);
  const named = ruleIds.filter(isSafeRuleId);
  const hash = sha256([path, String(start), String(end), ...lines].join('\n')).slice(
    0,
    MARKER_HASH_LENGTH,
  );
  return [
    `${fence}suggestion`,
    ...lines,
    fence,
    '',
    reasonLines(ruleIds, rules).join('\n\n'),
    '',
    `${SUGGESTION_MARKER_PREFIX}${named.length === 0 ? 'unknown' : named.join(',')} ${hash} -->`,
  ].join('\n');
}

function commentOf(suggestion: Suggestion, body: string): ReviewComment {
  const { path, start, end } = suggestion;
  return start === end
    ? { path, line: end, side: 'RIGHT', body }
    : { path, line: end, start_line: start, side: 'RIGHT', start_side: 'RIGHT', body };
}

/** Review fixes of the scan, and safe fixes verification demoted: each counted once. */
function notSafe(input: SuggestionInput): number {
  const keys = new Set<string>();
  for (const finding of input.run.before.findings) {
    const fix = fixOf(finding, 'pull-request');
    if (fix?.class !== 'review') continue;
    if (input.ruleIds !== undefined && !input.ruleIds.has(finding.ruleId)) continue;
    keys.add(fixKey(finding.ruleId, fix));
  }
  const demoted = input.run.skipped.filter(
    (planned) => planned.reason === 'verification-failed' && planned.fix.class === 'review',
  );
  return keys.size + demoted.length;
}

/** The report for `input`, as the module comment describes. */
export function toSuggestionsReport(
  input: SuggestionInput,
  options: SuggestionsJsonOptions = {},
): SuggestionsReport {
  const { run, diff } = input;
  const counter = new Counter();
  const rules = new Map(input.rules.map((meta) => [meta.id, meta]));

  counter.add('not-safe', notSafe(input));
  for (const planned of run.skipped) {
    if (planned.reason === 'verification-failed' && planned.fix.class === 'review') continue;
    const reason = planned.reason === undefined ? undefined : ROUND_REASONS[planned.reason];
    counter.add(reason ?? 'verification-failed');
  }
  counter.add('conflict', run.deferred.length);

  // What can be suggested in each file, by the path the scan read.
  const decoded = new Map<string, { before: DecodedText; after: DecodedText }>();
  const problems = new Map<string, SuggestionSkipReason | undefined>();
  for (const file of run.files) {
    const before = file.before === undefined ? undefined : decode(file.before);
    const after = decode(file.after);
    problems.set(file.from ?? file.path, fileProblem(file, before, after));
    if (file.op === 'edit' && before !== undefined) decoded.set(file.path, { before, after });
  }

  const workspace = createWorkspace(input.snapshot);
  const shapes = run.applied.map((planned) => shapeOf(planned, workspace, problems));
  for (const shape of shapes) if (shape.reason !== undefined) counter.add(shape.reason);

  const suggestions: Suggestion[] = [];
  for (const [path, { before, after }] of decoded) {
    if (problems.get(path) !== undefined) continue;
    const owners = shapes.filter((shape) => shape.edits.has(path));
    if (owners.length === 0) continue;
    for (const hunk of diffHunks(before.text, after.text, { context: 0 })) {
      const span = spanOf(hunk, before);
      const reached = owners.filter((shape) =>
        (shape.edits.get(path) ?? []).some((edit) => touches(edit, span)),
      );
      const fixes = reached.length === 0 ? owners : reached;
      // A fix that cannot be suggested is counted once, with its reason.
      if (fixes.some((shape) => shape.reason !== undefined)) continue;
      const replacement = replacementOf(hunk, before);
      if (
        replacement === undefined ||
        !insideOneRange(diff, path, replacement.start, replacement.end)
      ) {
        counter.add('outside-diff');
      } else if (!replacement.lines.every(isPlainLine)) {
        counter.add('hidden-characters');
      } else if (replacement.lines.some((line) => findSecret(line) !== undefined)) {
        counter.add('credential');
      } else {
        const ruleIds = [...new Set(fixes.map((shape) => shape.planned.ruleId))].sort(
          compareStrings,
        );
        suggestions.push({ path, ...replacement, ruleIds });
      }
    }
  }

  suggestions.sort((a, b) => compareStrings(a.path, b.path) || a.start - b.start);
  const comments: ReviewComment[] = [];
  for (const suggestion of suggestions) {
    const body = bodyOf(suggestion, rules, input.sha256);
    if (comments.length >= MAX_SUGGESTIONS || body.length > MAX_COMMENT_LENGTH) {
      counter.add('limit');
      continue;
    }
    comments.push(commentOf(suggestion, body));
  }

  const tool = options.tool ?? { name: TOOL_NAME, version: VERSION };
  return {
    schemaVersion: 1,
    tool: { name: tool.name, version: tool.version },
    ruleset: options.ruleset ?? RULESET_VERSION,
    comments,
    skipped: counter.list(),
  };
}

/**
 * Pretty JSON (2-space indent, trailing newline) for `fix --format suggestions`.
 * Display-dangerous characters are written as `\uXXXX` escapes, which every JSON parser reads
 * back as the same text.
 */
export function formatSuggestionsJson(
  input: SuggestionInput,
  options: SuggestionsJsonOptions = {},
): string {
  return `${forJsonOutput(JSON.stringify(toSuggestionsReport(input, options), null, 2))}\n`;
}

/** JSON Schema of {@link SuggestionsReport}; scripts/generate-docs.ts writes it to schemas/. */
export const SUGGESTIONS_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://raw.githubusercontent.com/mustafakbaser/agentcheckup/main/schemas/suggestions.schema.json',
  title: 'agentcheckup suggestions output',
  description:
    'Output of `agentcheckup fix --untrusted --format suggestions --diff <file>`: review comments with suggested changes for the safe fixes of a pull request, in the shape of `comments[]` of the GitHub API that creates a pull request review. Lines are 1-based lines of the head version. Paths are POSIX and relative to the scanned directory. Comment bodies hold text from the scanned repository: treat them as untrusted.',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'tool', 'ruleset', 'comments', 'skipped'],
  properties: {
    schemaVersion: {
      description: 'Version of this output shape. Incremented on any incompatible change.',
      const: 1,
    },
    tool: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'version'],
      properties: {
        name: { type: 'string', minLength: 1 },
        version: { type: 'string', minLength: 1 },
      },
    },
    ruleset: {
      description: 'Calendar-versioned rule set, e.g. 2026.10.',
      type: 'string',
      minLength: 1,
    },
    comments: {
      description: 'One comment per change, by path and line.',
      type: 'array',
      maxItems: MAX_SUGGESTIONS,
      items: { $ref: '#/$defs/comment' },
    },
    skipped: {
      description:
        'Fixes, or for outside-diff, hidden-characters, credential and limit single changes, that are not suggested, counted by reason.',
      type: 'array',
      items: { $ref: '#/$defs/skip' },
    },
  },
  $defs: {
    comment: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'line', 'side', 'body'],
      dependentRequired: { start_line: ['start_side'], start_side: ['start_line'] },
      properties: {
        path: {
          description: 'POSIX path relative to the scanned directory. Never absolute, never `..`.',
          type: 'string',
          minLength: 1,
          pattern: '^(?![/\\\\]|[A-Za-z]:)',
          not: { type: 'string', pattern: '(?:^|/)\\.\\.(?:/|$)' },
        },
        line: {
          description: 'The last line the suggestion replaces.',
          type: 'integer',
          minimum: 1,
        },
        start_line: {
          description: 'The first line, when the suggestion replaces more than one.',
          type: 'integer',
          minimum: 1,
        },
        side: { const: 'RIGHT' },
        start_side: { const: 'RIGHT' },
        body: {
          description:
            'A `suggestion` block with the new lines, the reason, and the marker `<!-- agentcheckup-suggestion <rule ids> <12 hex digits> -->` on the last line.',
          type: 'string',
          minLength: 1,
          maxLength: MAX_COMMENT_LENGTH,
        },
      },
    },
    skip: {
      type: 'object',
      additionalProperties: false,
      required: ['reason', 'count'],
      properties: {
        reason: { enum: [...SUGGESTION_SKIP_REASONS] },
        count: { type: 'integer', minimum: 1 },
      },
    },
  },
} as const;
