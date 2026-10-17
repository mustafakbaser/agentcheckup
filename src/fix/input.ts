/**
 * Fixes that need the user's words (`Fix.input`): checking an answer, turning the fix into one
 * with changes, and verifying that fix before `agentcheckup fix -i` offers it. The CLI asks; this
 * module decides. Pure, like the rest of src/fix. See
 * docs/adr/0008-write-fixes-to-the-scanned-repository.md.
 *
 * An answer is checked in this order, and the first failure is the message to show:
 * 1. Its shape ({@link checkInputShape}): one line without control, bidirectional, tag or other
 *    invisible characters (the classes of `safeCopiedText`), within the field's length, and the
 *    field's own syntax.
 * 2. The builder ({@link completeInput}): a frontmatter value is written double-quoted with
 *    `yamlSetScalar`, `yamlInsertKey` or `prependFrontmatter`, which parse their result again (a
 *    value that is not a one-line scalar is replaced whole with `yamlReplaceValue`); a suppression
 *    reason becomes an `agentcheckup-disable-next-line` directive: an HTML comment inserted with
 *    `insertLine`, or a `#` comment inside frontmatter with `yamlInsertComment`, which refuses
 *    one that would change the frontmatter's data. When the edit cannot be
 *    made or does not parse back as intended: {@link UNSAFE_VALUE}.
 * 3. The rules ({@link verifyCompletedInput}): the verification rounds of verify.ts with only the
 *    completed fix. It must resolve the input fix's findings and add no error or warning; on
 *    failure the message is the rule's own, so the user can answer again.
 *
 * The completed fix keeps the input fix's id, class, title and notes, so it takes the input
 * fix's place in a second planning pass exactly as an alternative the user picked does.
 */
import { type Analysis, analyze, runRules } from '../core/engine.js';
import { editableFile } from '../core/directive-fixes.js';
import { formatInteger } from '../core/format.js';
import { codePointLength } from '../core/measure.js';
import { NEXT_LINE_KEYWORD } from '../core/suppress.js';
import { positionAt } from '../core/text.js';
import type {
  AnyRule,
  Artifact,
  FileChange,
  Finding,
  Fix,
  FixInput,
  RuleContext,
  Snapshot,
} from '../core/types.js';
import type { FrontmatterResult } from '../parse/types.js';
import { MARKDOWN_OR_IMPORTED_KINDS } from '../platforms/kinds.js';
import { splitToolRules } from '../platforms/permissions.js';
import { applyPlan, FixApplyError } from './apply.js';
import {
  insertLine,
  prependFrontmatter,
  safeCopiedText,
  yamlInsertComment,
  yamlInsertKey,
  yamlReplaceValue,
  yamlSetScalar,
} from './edits.js';
import type { FixSelection, PlannedFix } from './index.js';
import { fixKey } from './plan.js';
import { hasLineBreak, indentAt } from './text.js';
import { compareScans, type FixRun, fixRounds, type FixScanOptions } from './verify.js';

/** Longest value per field, in code points, with a frontmatter target's prefix and suffix. */
export const INPUT_LIMITS: Readonly<Record<FixInput['field'], number>> = {
  'skill-description': 1024,
  'skill-when-clause': 1024,
  'allowed-tools': 1000,
  'cursor-globs': 500,
  'suppression-reason': 200,
};

/** The refusal when a builder cannot write the value, or its result does not parse back. */
export const UNSAFE_VALUE = 'could not write this value safely';

const FIELD_NAMES: Readonly<Record<FixInput['field'], string>> = {
  'skill-description': 'The description',
  'skill-when-clause': 'The description',
  'allowed-tools': 'allowed-tools',
  'cursor-globs': 'globs',
  'suppression-reason': 'The reason',
};

/**
 * True when every `(` closes before the next one opens and every `)` closes one, as
 * `splitToolRules` reads them: otherwise the entries would not split where the user meant.
 */
function balancedToolRules(value: string): boolean {
  let inside = false;
  for (const char of value) {
    if (char === '(') {
      if (inside) return false;
      inside = true;
    } else if (char === ')') {
      if (!inside) return false;
      inside = false;
    }
  }
  return !inside;
}

/**
 * Why `value` cannot be written into `field`, or undefined when it can. `value` is what the file
 * gets: for a frontmatter target, the prefix, the answer and the suffix.
 */
export function checkInputShape(field: FixInput['field'], value: string): string | undefined {
  if (value.trim() === '') return 'The answer is empty.';
  if (hasLineBreak(value) || value.includes('\u2028') || value.includes('\u2029')) {
    return 'Write one line: the answer has a line break.';
  }
  if (safeCopiedText(value, Number.MAX_SAFE_INTEGER) === undefined) {
    return 'The answer has a control, bidirectional or invisible character; type it without one.';
  }
  const limit = INPUT_LIMITS[field];
  const length = codePointLength(value);
  if (length > limit) {
    return `${FIELD_NAMES[field]} can have at most ${formatInteger(limit)} characters; this one has ${formatInteger(length)}.`;
  }
  switch (field) {
    case 'skill-description':
    case 'skill-when-clause':
      if (value.includes('<') || value.includes('>')) {
        return 'A skill description cannot contain "<" or ">": agents read them as XML tags.';
      }
      return undefined;
    case 'suppression-reason':
      if (value.includes('-->')) return 'The reason cannot contain "-->", which ends the comment.';
      return undefined;
    case 'allowed-tools':
      if (!balancedToolRules(value) || splitToolRules(value).length === 0) {
        return 'List tools separated by spaces, each "(" closed by a ")", as in Bash(git add *) Read.';
      }
      return undefined;
    case 'cursor-globs':
      return undefined;
  }
}

/** A completed input fix, or why it could not be completed. */
export type InputCompletion =
  { readonly ok: true; readonly fix: Fix } | { readonly ok: false; readonly message: string };

/** The parses {@link completeInput} reads: an {@link Analysis} of the scanned snapshot. */
export type InputParses = Pick<Analysis, 'index' | 'frontmatter'>;

const RULE_ID = /^[a-z\d]+(?:-[a-z\d]+)*\/[a-z\d]+(?:-[a-z\d]+)*$/;

/** The answer as the value of a frontmatter key, in a new block when the file has none. */
function frontmatterChange(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  input: FixInput,
  key: string,
  value: string,
): FileChange | undefined {
  if (frontmatter.kind === 'absent') {
    return prependFrontmatter(artifact, frontmatter, [{ key, value, style: 'double' }]);
  }
  if (frontmatter.kind !== 'valid') return undefined;
  const { data } = frontmatter;
  if (data.keySpan(key) === undefined) {
    // A skill's description goes after its name, as skill/description-missing puts it.
    const afterName = input.field === 'skill-description' && data.keys.includes('name');
    return yamlInsertKey(artifact, frontmatter, key, value, {
      style: 'double',
      position: afterName ? { after: 'name' } : 'last',
    });
  }
  // A value that is not a one-line scalar, such as a block scalar or a list, is replaced whole.
  return (
    yamlSetScalar(artifact, frontmatter, key, value, { style: 'double' }) ??
    yamlReplaceValue(artifact, frontmatter, key, value, { style: 'double' })
  );
}

/**
 * A `disable-next-line` directive for `ruleId` with `reason`, inserted before line `line` with
 * that line's indentation: a `#` comment between the frontmatter delimiters, an HTML comment
 * after them or in a file without frontmatter. Undefined for a line outside the file, on a
 * delimiter, or in a file whose directives the engine does not read, and when the comment would
 * change the frontmatter's data (inside a block scalar, for example).
 */
function directiveChange(
  artifact: Artifact,
  frontmatter: FrontmatterResult,
  line: number,
  ruleId: string,
  reason: string,
): FileChange | undefined {
  if (!RULE_ID.test(ruleId)) throw new RangeError(`"${ruleId.slice(0, 40)}" is not a rule id.`);
  if (!MARKDOWN_OR_IMPORTED_KINDS.has(artifact.kind)) return undefined;
  const { decoded } = artifact;
  const { text, lineStarts } = decoded;
  const lines = text.length === 0 ? 0 : lineStarts.length - (text.endsWith('\n') ? 1 : 0);
  if (!Number.isSafeInteger(line) || line < 1 || line > lines) return undefined;
  const indent = indentAt(text, lineStarts[line - 1] ?? 0);
  const directive = `${NEXT_LINE_KEYWORD} ${ruleId} -- ${reason}`;

  if (frontmatter.kind === 'absent') {
    return insertLine(artifact, line - 1, `${indent}<!-- ${directive} -->`);
  }
  if (frontmatter.kind !== 'valid') return undefined;
  const opening = positionAt(decoded, frontmatter.span.offset).line;
  const closing = positionAt(decoded, Math.max(0, frontmatter.bodyOffset - 1)).line;
  if (line > closing) return insertLine(artifact, line - 1, `${indent}<!-- ${directive} -->`);
  if (line <= opening || line === closing) return undefined;
  return yamlInsertComment(artifact, frontmatter, line, directive);
}

/**
 * The input fix `fix` completed with `answer`: the same fix with the change that writes the
 * answer, and without `input` and `alternatives`. `parses` is the analysis of the snapshot the
 * fix was reported on. A refusal names what to change in the answer, or is {@link UNSAFE_VALUE}
 * when the file cannot take the value: a file reached through a symlink or not decoded cleanly,
 * frontmatter that is not valid, or an edit that does not parse back as intended.
 *
 * Throws a RangeError for a fix without `input` or a directive target whose rule id is malformed.
 */
export function completeInput(fix: Fix, answer: string, parses: InputParses): InputCompletion {
  const { input } = fix;
  if (input === undefined) throw new RangeError(`${fix.id} does not need input.`);
  const words = answer.trim();
  if (words === '') return { ok: false, message: 'The answer is empty.' };
  const { target } = input;
  const value =
    target.kind === 'frontmatter' ? `${target.prefix ?? ''}${words}${target.suffix ?? ''}` : words;
  const problem = checkInputShape(input.field, value);
  if (problem !== undefined) return { ok: false, message: problem };

  const artifact = parses.index.get(target.path);
  if (artifact?.path !== target.path || !editableFile(artifact)) {
    return { ok: false, message: UNSAFE_VALUE };
  }
  const frontmatter = parses.frontmatter(artifact);
  const change =
    target.kind === 'frontmatter'
      ? frontmatterChange(artifact, frontmatter, input, target.key, value)
      : directiveChange(artifact, frontmatter, target.line, target.ruleId, value);
  if (change === undefined) return { ok: false, message: UNSAFE_VALUE };
  return {
    ok: true,
    fix: {
      id: fix.id,
      class: fix.class,
      title: fix.title,
      changes: [change],
      ...(fix.notes === undefined ? {} : { notes: fix.notes }),
      ...(fix.warning === undefined ? {} : { warning: fix.warning }),
    },
  };
}

/** A completed input fix that verified, or the message to answer again with. */
export type InputVerification =
  | {
      readonly ok: true;
      /** The completed fix as verification planned it, with its effects. */
      readonly fix: PlannedFix;
      /** The run with only that fix: its `files` are the diff to show. */
      readonly run: FixRun;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Identity of a fix as its rule reports it, as `fix -i` matches answers to fixes: the class is
 * left out, because verification can demote a fix that `entry` was taken from.
 */
function reportedKey(ruleId: string, fix: Fix): string {
  return fixKey(ruleId, { ...fix, class: 'safe' });
}

/**
 * `rule` reporting `completed` where it reports the fix whose key is `key`, and no other fix: the
 * input fix's findings carry the completed fix, as `fix -i` arranges it, and nothing else of the
 * rule is planned.
 */
function reporting(rule: AnyRule, key: string, completed: Fix): AnyRule {
  return {
    meta: rule.meta,
    defaultOptions: rule.defaultOptions as unknown,
    check(context: RuleContext<unknown>) {
      rule.check({
        ...context,
        report(descriptor) {
          const { fix, ...rest } = descriptor;
          const swapped = fix !== undefined && reportedKey(rule.meta.id, fix) === key;
          context.report(swapped ? { ...rest, fix: completed } : rest);
        },
      });
    },
  };
}

/** Active findings of `ruleId` on `paths`. */
function activeOf(
  findings: readonly Finding[],
  ruleId: string,
  paths: ReadonlySet<string>,
): Finding[] {
  return findings.filter(
    (finding) =>
      finding.suppressed === undefined && finding.ruleId === ruleId && paths.has(finding.path),
  );
}

/**
 * Why `planned`, the completed fix, failed verification: the rule's message when one of the
 * findings it carries is still there, else the first new error or warning with its rule, else a
 * new rule failure, else the risk finding it would hide.
 */
function failureMessage(
  snapshot: Snapshot,
  options: FixScanOptions,
  run: FixRun,
  planned: PlannedFix,
): string {
  if (planned.reason === 'refused-path') return UNSAFE_VALUE;
  if (planned.reason === 'limit') return 'the file would be larger than a fix may write';
  const { fix, ruleId, findings } = planned;
  let next: Snapshot;
  try {
    // applyPlan applies planned fixes only: this one is applied again to read the rules.
    next = applyPlan(snapshot, {
      fixes: [{ fix, ruleId, findings, effects: [], status: 'planned' }],
    });
  } catch (error) {
    if (!(error instanceof FixApplyError)) throw error;
    return UNSAFE_VALUE;
  }
  const after = runRules(analyze(next, options), options);
  const carried = new Set(planned.findings);
  const paths = new Set(
    run.before.findings
      .filter((finding) => carried.has(finding.fingerprint))
      .map((finding) => finding.path),
  );
  const was = activeOf(run.before.findings, planned.ruleId, paths);
  const is = activeOf(after.findings, planned.ruleId, paths);
  if (is.length > was.length - carried.size) {
    // The rule's other findings there keep their fingerprints; the one left is the answer's.
    const others = new Set(
      was
        .filter((finding) => !carried.has(finding.fingerprint))
        .map((finding) => finding.fingerprint),
    );
    const left = is.find((finding) => !others.has(finding.fingerprint)) ?? is[0];
    if (left !== undefined) return left.message;
  }
  const { introduced } = compareScans(run.before, after, new Map(), [planned]);
  const added = introduced.find((finding) => finding.severity !== 'info');
  if (added !== undefined) return `${added.ruleId}: ${added.message}`;
  const crashed = new Set(run.before.ruleFailures.map((failure) => failure.ruleId));
  const failure = after.ruleFailures.find((item) => !crashed.has(item.ruleId));
  if (failure !== undefined) return `rule ${failure.ruleId} failed on the result`;
  return 'the change would hide a security finding that it does not fix';
}

/**
 * Plans, applies and verifies `completed` on an in-memory copy of `snapshot`, with the rounds of
 * verify.ts limited to one round and to the fixes of `entry`'s rule, of which only `completed`
 * (in place of `entry.fix`) is reported. `entry` names the fix as the rule reports it on the
 * finding: an entry of `FixRun.awaitingInput`, or the planned fix whose input alternative was
 * completed. `scanOptions` are those of the run that listed `entry`.
 *
 * The fix passes as any fix does: its findings are gone, no error, warning or rule failure is
 * new, and no risk finding it does not carry is gone. On failure the message says why, in the
 * rule's words where it can, for the prompt to show before asking again.
 */
export function verifyCompletedInput(
  snapshot: Snapshot,
  scanOptions: FixScanOptions,
  entry: { readonly ruleId: string; readonly fix: Fix },
  completed: Fix,
): InputVerification {
  if (completed.input !== undefined) throw new RangeError(`${completed.id} still needs input.`);
  const key = reportedKey(entry.ruleId, entry.fix);
  const options: FixScanOptions = {
    ...scanOptions,
    rules: scanOptions.rules.map((rule) =>
      rule.meta.id === entry.ruleId ? reporting(rule, key, completed) : rule,
    ),
  };
  const selection: FixSelection = {
    classes: new Set(['safe', 'review']),
    ruleIds: new Set([entry.ruleId]),
    literalSecret: true,
  };
  const run = fixRounds(snapshot, options, selection, 1);
  const mine = (planned: PlannedFix): boolean =>
    planned.ruleId === entry.ruleId && planned.fix.id === completed.id;
  const applied = run.applied.find(mine);
  if (applied !== undefined) return { ok: true, fix: applied, run };
  const skipped = [...run.skipped, ...run.deferred].find(mine);
  if (skipped === undefined) {
    return { ok: false, message: 'the finding this answer was for is no longer reported' };
  }
  return { ok: false, message: failureMessage(snapshot, options, run, skipped) };
}
