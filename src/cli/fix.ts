/**
 * `agentcheckup fix` (docs/adr/0008-write-fixes-to-the-scanned-repository.md):
 *
 * 1. Walks the repository and plans, applies and verifies fixes in rounds on an in-memory copy
 *    ({@link fixRounds}).
 * 2. A dry run prints the diff or JSON and exits 1 when anything would change.
 * 3. `--write` turns the verified changes into write steps, one unit per group of fixes that
 *    share a file (the final bytes of each file, its creates and renames), and writes them with
 *    {@link writeFixes} against the files the walk read. Then it walks and scans the repository
 *    again and checks on disk that each written fix resolved its findings and added no error or
 *    warning.
 * 4. `-i` asks about each verified fix, then plans again with only the accepted ones (an
 *    alternative the user picked takes the place of the rule's fix in its finding) and writes
 *    those as `--write` does. What is left to the user comes from the scan from disk: the
 *    findings of declined fixes and the manual steps of the findings still there.
 *
 * Every file access goes through src/io; this module only decides and prints.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { compareStrings } from '../core/compare.js';
import {
  type Analysis,
  analyze,
  type RuleResult,
  runRules,
  type ScanResult,
} from '../core/engine.js';
import { decode } from '../core/text.js';
import type { AnyRule, FileChange, Finding, Fix, FixClass, RuleContext } from '../core/types.js';
import {
  type FileDiff,
  fixKey,
  fixRounds,
  type FixRun as FixRounds,
  type FixScanOptions,
  type FixSelection,
  type FixSkipReason,
  type FixVerification,
  leftSteps,
  LITERAL_SECRET_RULE,
  type ManualStep,
  type PlannedFix,
} from '../fix/index.js';
import { relativeInsideRoot } from '../io/paths.js';
import { walk, type WalkOptions } from '../io/walk.js';
import {
  type FixWrite,
  FixWriteError,
  type FixWriteResult,
  writeFixes,
  type WriteStep,
} from '../io/write-fix.js';
import {
  type ChangedFile,
  type FileVersion,
  formatFixDiff,
  formatFixSummary,
  type FixRun as FixView,
} from '../report/fix-diff.js';
import { formatFixJson } from '../report/fix-json.js';
import { forTerminal } from '../report/sanitize.js';
import type { Style } from '../report/stylish.js';
import { builtinRules } from '../rules/index.js';
import { type FixCommandOptions, UsageError } from './args.js';
import {
  allRuleMeta,
  emit,
  errorMessage,
  EXIT,
  type ExitCode,
  type Io,
  loadConfig,
  type Prompt,
  scanOptionsFor,
  styleFor,
} from './common.js';

/** What every step of one `fix` run needs. */
interface Session {
  readonly options: FixCommandOptions;
  readonly io: Io;
  /** The scanned directory, absolute. */
  readonly root: string;
  /** Prefix for shown paths: the root relative to the working directory, or `''`. */
  readonly base: string;
  readonly style: Style;
  readonly snapshot: Awaited<ReturnType<typeof walk>>;
  readonly walkOptions: WalkOptions;
  readonly scanOptions: FixScanOptions;
}

const BOTH_CLASSES: ReadonlySet<FixClass> = new Set(['safe', 'review']);

export async function fix(options: FixCommandOptions, io: Io): Promise<ExitCode> {
  const prompt = options.interactive ? terminalOf(io) : undefined;
  const ruleIds = checkedRuleIds(options.rules);
  const root = resolve(io.cwd, options.path);
  const config = await loadConfig(options, root, io.cwd);
  const walkOptions: WalkOptions = {
    respectGitignore: true,
    scanIgnoredAgentConfig: options.untrusted,
  };
  const session: Session = {
    options,
    io,
    root,
    base: relativeInsideRoot(io.cwd, root) ?? '',
    style: styleFor(options, io),
    snapshot: await walk(root, walkOptions),
    walkOptions,
    scanOptions: scanOptionsFor(options, config, options.targets),
  };

  const selection: FixSelection = {
    // A dry run shows every class; `--write` alone applies the safe fixes.
    classes:
      options.write && !options.review && !options.interactive ? new Set(['safe']) : BOTH_CLASSES,
    ...(ruleIds === undefined ? {} : { ruleIds }),
    literalSecret: options.interactive || (ruleIds?.has(LITERAL_SECRET_RULE) ?? false),
  };
  const rounds = fixRounds(session.snapshot, session.scanOptions, selection);
  for (const warning of rounds.before.configWarnings) {
    io.stderr(`Warning: ${forTerminal(warning)}\n`);
  }

  if (!options.interactive && !options.write) return dryRun(session, rounds);
  if (rounds.before.ruleFailures.length > 0) {
    reportCrashes(rounds.before, io);
    io.stderr('No fixes were written: a scan with a crashed rule cannot verify them.\n');
    return EXIT.internal;
  }
  return prompt === undefined
    ? write(session, rounds, selection)
    : interactive(session, prompt, rounds, ruleIds);
}

/** The prompt for -i, or a UsageError unless stdin and stdout are both terminals. */
function terminalOf(io: Io): Prompt {
  const prompt = io.prompt;
  if (prompt === undefined || !prompt.isTTY || !io.isTTY) {
    throw new UsageError(
      '-i needs a terminal: stdin and stdout must both be a TTY. Preview the fixes with ' +
        '"agentcheckup fix", or apply them with "agentcheckup fix --write".',
    );
  }
  return prompt;
}

/** `--rule` as a set, or a UsageError naming the ids no rule has. */
function checkedRuleIds(ids: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (ids === undefined) return undefined;
  const known = new Set(allRuleMeta().map((meta) => meta.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    const names = unknown.map((id) => `"${id}"`).join(', ');
    throw new UsageError(
      `--rule: unknown rule ${names}. Run "agentcheckup rules" to list the rules.`,
    );
  }
  return new Set(ids);
}

function reportCrashes(scan: Pick<ScanResult, 'ruleFailures'>, io: Io): void {
  for (const failure of scan.ruleFailures) {
    io.stderr(`Rule ${forTerminal(failure.ruleId)} crashed: ${forTerminal(failure.message)}\n`);
  }
}

// ---------------------------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------------------------

async function dryRun(session: Session, rounds: FixRounds): Promise<ExitCode> {
  const view = viewOf(
    session,
    'dry-run',
    [...rounds.applied, ...rounds.deferred, ...rounds.skipped],
    rounds.files.map(changedFile),
    rounds.manual,
    rounds.verification,
  );
  const report =
    session.options.format === 'json'
      ? formatFixJson(view)
      : formatFixDiff(view, { style: session.style });
  await emit(report, session.options, session.io);
  if (rounds.before.ruleFailures.length > 0) {
    reportCrashes(rounds.before, session.io);
    return EXIT.internal;
  }
  return rounds.files.length > 0 ? EXIT.findings : EXIT.ok;
}

// ---------------------------------------------------------------------------------------------
// --write
// ---------------------------------------------------------------------------------------------

/**
 * A safe fix that verification demoted to review because it adds or changes an item a gate
 * class flags. With `--write` alone it is not selected, so it is reported apart.
 */
function demoted(planned: PlannedFix): boolean {
  return (
    planned.status === 'skipped' &&
    planned.reason === 'verification-failed' &&
    planned.fix.class === 'review'
  );
}

async function write(
  session: Session,
  rounds: FixRounds,
  selection: FixSelection,
): Promise<ExitCode> {
  const needsReview = selection.classes.has('review') ? [] : rounds.skipped.filter(demoted);
  const skipped = rounds.skipped.filter((planned) => !needsReview.includes(planned));
  const preview = viewOf(
    session,
    'dry-run',
    [...rounds.applied, ...rounds.deferred, ...skipped],
    rounds.files.map(changedFile),
    rounds.manual,
    rounds.verification,
  );
  const outcome = await writeAndVerify(session, rounds.applied, rounds.files, rounds.before);
  if (outcome === undefined) return EXIT.findings;
  const view = viewOf(
    session,
    'write',
    [...outcome.fixes, ...rounds.deferred, ...skipped],
    outcome.files,
    rounds.manual,
    outcome.verification,
  );

  let report: string;
  if (session.options.format === 'json') {
    report = formatFixJson(view);
  } else {
    const parts: string[] = [];
    if (rounds.files.length > 0) parts.push(formatFixDiff(preview, { style: session.style }));
    parts.push(formatFixSummary(view, { style: session.style }));
    if (needsReview.length > 0) {
      const count = needsReview.length;
      parts.push(
        `${count === 1 ? '1 fix needs' : `${count} fixes need`} review: ` +
          `${count === 1 ? 'it adds or changes' : 'they add or change'} an MCP server, hook, ` +
          'permission or env override. Apply with "agentcheckup fix -i" or ' +
          '"agentcheckup fix --write --review".\n',
      );
    }
    report = parts.join('\n');
  }
  await emit(report, session.options, session.io);
  return outcome.exit(view.fixes);
}

/** What writing and the scan from disk found. */
interface WriteOutcome {
  /** The fixes given, each `applied` or `skipped` with the writer's reason, in their order. */
  readonly fixes: readonly PlannedFix[];
  /** The files written. */
  readonly files: readonly ChangedFile[];
  /** The scan of the repository after writing, against the scan before. */
  readonly verification: FixVerification;
  /** The repository after writing, walked and scanned from disk. */
  readonly after: { readonly analysis: Analysis; readonly result: RuleResult };
  /** Old path → new path of each file a written fix renamed. */
  readonly renames: ReadonlyMap<string, string>;
  /** The exit code for a run whose fixes are `fixes`. */
  readonly exit: (fixes: readonly PlannedFix[]) => ExitCode;
}

/**
 * Writes `applied` (verified in memory; `files` their combined changes, from the snapshot the
 * walk read), then walks and scans the repository again. Undefined when the root is no longer
 * usable.
 */
async function writeAndVerify(
  session: Session,
  applied: readonly PlannedFix[],
  files: readonly FileDiff[],
  before: ScanResult,
): Promise<WriteOutcome | undefined> {
  const { io } = session;
  const groups = writeGroups(applied, files);
  await io.beforeWrite?.();
  let results: FixWriteResult[];
  try {
    results =
      groups.length === 0
        ? []
        : await writeFixes(
            session.root,
            session.snapshot.files,
            groups.map((group) => group.write),
          );
  } catch (error) {
    if (!(error instanceof FixWriteError)) throw error;
    io.stderr(`${forTerminal(errorMessage(error))}\n`);
    return undefined;
  }

  const outcome = new Map<PlannedFix, PlannedFix>();
  const written: FileDiff[] = [];
  groups.forEach((group, index) => {
    // writeFixes returns one result per unit, in order.
    const result: FixWriteResult = results[index] ?? {
      id: group.write.id,
      status: 'skipped',
      reason: 'write-failed',
      detail: 'writing failed',
    };
    if (result.status === 'applied') {
      for (const planned of group.fixes) outcome.set(planned, withStatus(planned, 'applied'));
      written.push(...group.files);
      return;
    }
    for (const planned of group.fixes) outcome.set(planned, skip(planned, result.reason));
    const where =
      result.path === undefined ? '' : ` ${forTerminal(withBase(session.base, result.path))}`;
    io.stderr(`Not written${where}: ${forTerminal(result.detail)}\n`);
    if (result.status === 'rolled-back' && result.unrestored.length > 0) {
      const paths = result.unrestored.map((path) => forTerminal(withBase(session.base, path)));
      io.stderr(
        `Could not undo the change to ${paths.join(', ')}: check ${paths.length === 1 ? 'it' : 'them'} with git diff.\n`,
      );
    }
  });
  const fixes = applied.map((planned) => outcome.get(planned) ?? planned);

  const analysis = analyze(await walk(session.root, session.walkOptions), session.scanOptions);
  const after = runRules(analysis, session.scanOptions);
  const renames = new Map<string, string>();
  for (const file of written) if (file.from !== undefined) renames.set(file.from, file.path);
  const check = verifyOnDisk(
    before,
    after,
    renames,
    fixes.filter((planned) => planned.status === 'applied'),
  );
  for (const planned of check.unverified) {
    io.stderr(
      `Written, but the scan from disk still finds what it fixes: ${forTerminal(planned.ruleId)} ` +
        `${forTerminal(planned.fix.title)}\n`,
    );
  }
  reportCrashes(after, io);
  const problems =
    check.unverified.length > 0 ||
    check.verification.introduced.some((finding) => finding.severity !== 'info');

  return {
    fixes,
    files: [...written].sort((a, b) => compareStrings(a.path, b.path)).map(changedFile),
    verification: check.verification,
    after: { analysis, result: after },
    renames,
    exit: (all) => {
      if (after.ruleFailures.length > 0) return EXIT.internal;
      return problems || notApplied(all) ? EXIT.findings : EXIT.ok;
    },
  };
}

/** A selected fix was left out: everything but a fix the user declined counts. */
function notApplied(fixes: readonly PlannedFix[]): boolean {
  return fixes.some((planned) => planned.status === 'skipped' && planned.reason !== 'declined');
}

// ---------------------------------------------------------------------------------------------
// -i
// ---------------------------------------------------------------------------------------------

/** What the user answered. */
interface Answers {
  /** Accepted fixes, with the fix to apply: the rule's or the alternative the user picked. */
  readonly accepted: ReadonlyMap<PlannedFix, Fix>;
  readonly declined: readonly PlannedFix[];
  /** Input ended or was interrupted: nothing is written. */
  readonly aborted: boolean;
}

async function interactive(
  session: Session,
  prompt: Prompt,
  rounds: FixRounds,
  ruleIds: ReadonlySet<string> | undefined,
): Promise<ExitCode> {
  const { io } = session;
  const answers = await ask(session, prompt, rounds);
  if (answers.aborted) {
    io.stderr('Stopped: no files were changed.\n');
    return EXIT.findings;
  }
  // Fixes the dry run could not apply were never offered; they stay as they were.
  const notOffered = [...rounds.deferred, ...rounds.skipped];
  const declined = answers.declined.map((planned) => skip(planned, 'declined'));
  // What is left is read from the files as they are after writing: the findings of declined
  // fixes, and the manual steps of the findings still there.
  const leftSelection: FixSelection = {
    classes: BOTH_CLASSES,
    ...(ruleIds === undefined ? {} : { ruleIds }),
    literalSecret: true,
  };
  // A blank line between the last answer and the summary.
  if (rounds.applied.length > 0 && session.options.output === undefined) io.stdout('\n');

  if (answers.accepted.size === 0) {
    const titles = declinedTitles(answers.declined, rounds.before, rounds.before, new Map());
    const left = leftSteps(
      analyze(session.snapshot, session.scanOptions),
      rounds.before,
      leftSelection,
      (finding) => titles.get(finding.fingerprint),
    );
    const view = viewOf(session, 'interactive', [...declined, ...notOffered], [], left, {
      resolved: 0,
      remaining: rounds.before.findings.filter((finding) => finding.suppressed === undefined)
        .length,
      introduced: [],
    });
    await emit(render(session, view), session.options, io);
    return notApplied(view.fixes) ? EXIT.findings : EXIT.ok;
  }

  const decided = decide(
    builtinRules,
    answers.accepted,
    rounds.applied,
    ruleIds,
    allRuleMeta().map((meta) => meta.id),
  );
  for (const planned of decided.withheld) {
    io.stderr(
      `Not applied: ${forTerminal(planned.ruleId)} ${forTerminal(planned.fix.title)}. ` +
        '-i applies all or none of the fixes of this rule, and one of them was declined.\n',
    );
  }
  const rerun = fixRounds(
    session.snapshot,
    { ...session.scanOptions, rules: decided.rules },
    {
      classes: BOTH_CLASSES,
      ...(decided.ruleIds === undefined ? {} : { ruleIds: decided.ruleIds }),
      literalSecret: true,
    },
  );
  const outcome = await writeAndVerify(session, rerun.applied, rerun.files, rerun.before);
  if (outcome === undefined) return EXIT.findings;
  const titles = declinedTitles(
    [...answers.declined, ...decided.withheld],
    rounds.before,
    outcome.after.result,
    outcome.renames,
  );
  const left = leftSteps(outcome.after.analysis, outcome.after.result, leftSelection, (finding) =>
    titles.get(finding.fingerprint),
  );
  const view = viewOf(
    session,
    'interactive',
    [
      ...outcome.fixes,
      ...rerun.deferred,
      ...rerun.skipped,
      ...declined,
      ...decided.withheld.map((planned) => skip(planned, 'declined')),
      ...notOffered,
    ],
    outcome.files,
    left,
    outcome.verification,
  );
  await emit(render(session, view), session.options, io);
  return outcome.exit(view.fixes);
}

/**
 * The titles of `declined` fixes, keyed by the fingerprint of each of their findings that `after`
 * still has. `after` is a scan of the repository once the accepted fixes are written, and
 * `before` the scan their findings come from. A finding no fix changed keeps its fingerprint;
 * one in a file another fix edited is matched by rule and path (following `renames`) among the
 * findings of `after` that still carry a fix, as many as the declined fixes had there.
 */
export function declinedTitles(
  declined: readonly PlannedFix[],
  before: Pick<RuleResult, 'findings'>,
  after: Pick<RuleResult, 'findings'>,
  renames: ReadonlyMap<string, string>,
): Map<string, string> {
  const keyOf = (ruleId: string, path: string): string => `${ruleId}\u0000${path}`;
  const present = new Set(after.findings.map((finding) => finding.fingerprint));
  const earlier = new Map(before.findings.map((finding) => [finding.fingerprint, finding]));
  const titles = new Map<string, string>();
  const pending = new Map<string, string[]>();
  for (const planned of declined) {
    for (const fingerprint of planned.findings) {
      if (present.has(fingerprint)) {
        if (!titles.has(fingerprint)) titles.set(fingerprint, planned.fix.title);
        continue;
      }
      const finding = earlier.get(fingerprint);
      if (finding === undefined) continue;
      const key = keyOf(finding.ruleId, renames.get(finding.path) ?? finding.path);
      pending.set(key, [...(pending.get(key) ?? []), planned.fix.title]);
    }
  }
  for (const finding of after.findings) {
    if (finding.fix === undefined || titles.has(finding.fingerprint)) continue;
    const title = pending.get(keyOf(finding.ruleId, finding.path))?.shift();
    if (title !== undefined) titles.set(finding.fingerprint, title);
  }
  return titles;
}

function render(session: Session, view: FixView): string {
  return session.options.format === 'json'
    ? formatFixJson(view)
    : formatFixSummary(view, { style: session.style });
}

async function ask(session: Session, prompt: Prompt, rounds: FixRounds): Promise<Answers> {
  const { io } = session;
  const files = rounds.files.map(changedFile);
  const accepted = new Map<PlannedFix, Fix>();
  const declined: PlannedFix[] = [];
  const offered = rounds.applied;
  if (offered.length === 0) io.stdout('Nothing to fix.\n');

  for (const [index, planned] of offered.entries()) {
    // As an interactive add shows each hunk: the fix with its diff, then the question.
    const block = fixBlock(session, planned, offered, filesOf(planned, files));
    io.stdout(`${index === 0 ? '' : '\n'}${block}`);
    const alternatives = planned.fix.alternatives ?? [];
    const safe = planned.fix.class === 'safe';
    const question =
      `(${index + 1}/${offered.length}) Apply? [y]es [n]o [d]iff ` +
      `${alternatives.length > 0 ? '[a]lternatives ' : ''}[q]uit (Enter: ${safe ? 'yes' : 'no'}) `;
    let answered = false;
    while (!answered) {
      const answer = await prompt.ask(question);
      if (answer === undefined) return { accepted, declined, aborted: true };
      switch (answer.trim().toLowerCase()) {
        case '':
          if (safe) accepted.set(planned, planned.fix);
          else declined.push(planned);
          answered = true;
          break;
        case 'y':
        case 'yes':
          accepted.set(planned, planned.fix);
          answered = true;
          break;
        case 'n':
        case 'no':
          declined.push(planned);
          answered = true;
          break;
        case 'd':
        case 'diff':
          io.stdout(block);
          break;
        case 'a':
        case 'alternatives': {
          const chosen = await chooseAlternative(prompt, io, alternatives);
          if (chosen === null) return { accepted, declined, aborted: true };
          if (chosen !== undefined) {
            accepted.set(planned, chosen);
            answered = true;
          }
          break;
        }
        case 'q':
        case 'quit':
          declined.push(...offered.slice(index));
          return { accepted, declined, aborted: false };
        default:
          io.stdout(`Answer y, n, d${alternatives.length > 0 ? ', a' : ''} or q.\n`);
      }
    }
  }
  return { accepted, declined, aborted: false };
}

/**
 * Lists `alternatives` and asks for one. Undefined to go back to the fix, null when input ended.
 */
async function chooseAlternative(
  prompt: Prompt,
  io: Io,
  alternatives: readonly Fix[],
): Promise<Fix | undefined | null> {
  if (alternatives.length === 0) {
    io.stdout('This fix has no alternatives.\n');
    return undefined;
  }
  const lines = alternatives.map(
    (alternative, index) =>
      `  ${index + 1}  ${alternative.class.padEnd(7)} ${forTerminal(alternative.title)}`,
  );
  io.stdout(`Alternatives:\n${lines.join('\n')}\n`);
  for (;;) {
    const answer = await prompt.ask(`Use which (1-${alternatives.length}, Enter to go back)? `);
    if (answer === undefined) return null;
    const text = answer.trim();
    if (text === '') return undefined;
    const choice = /^\d{1,4}$/.test(text) ? Number(text) : 0;
    const alternative = alternatives[choice - 1];
    if (choice >= 1 && alternative !== undefined) {
      io.stdout(`Using: ${forTerminal(alternative.title)}\n`);
      return alternative;
    }
    io.stdout(`Answer a number from 1 to ${alternatives.length}.\n`);
  }
}

/**
 * One fix as the dry run shows it: class, rule, title, the diff of `files` (the files it
 * touches), effects and notes. Every fix of the run goes to the formatter, `planned` first, so
 * the spans that credential fixes replace are redacted in this diff too; only the first block,
 * which shows `files`, is kept. Blocks have no blank lines inside.
 */
function fixBlock(
  session: Session,
  planned: PlannedFix,
  all: readonly PlannedFix[],
  files: readonly ChangedFile[],
): string {
  const text = formatFixDiff(
    {
      mode: 'dry-run',
      pathBase: session.base,
      fixes: [planned, ...all.filter((other) => other !== planned)],
      files,
      manual: [],
      verification: { resolved: 0, remaining: 0, introduced: [] },
    },
    { style: session.style },
  );
  const end = text.indexOf('\n\n');
  return end === -1 ? text : text.slice(0, end + 1);
}

function touchedPaths(change: FileChange): string[] {
  return change.kind === 'rename' ? [change.from, change.to] : [change.path];
}

/** The changed files a fix touches. A file several fixes change shows all their changes. */
function filesOf(planned: PlannedFix, files: readonly ChangedFile[]): ChangedFile[] {
  const paths = new Set(planned.fix.changes.flatMap(touchedPaths));
  return files.filter(
    (file) => paths.has(file.path) || (file.op === 'rename' && paths.has(file.from)),
  );
}

/** What -i plans with in its second pass. */
export interface Decided {
  /** The rules, each reporting only the accepted fixes, an alternative in place of its fix. */
  readonly rules: readonly AnyRule[];
  /** `--rule` without the rules whose fixes -i cannot pick one by one, when one was declined. */
  readonly ruleIds: ReadonlySet<string> | undefined;
  /** Accepted fixes of those rules, which are not applied. */
  readonly withheld: readonly PlannedFix[];
}

/** Identity of a rule's fix across scans. The class is left out: verification can demote it. */
function decisionKey(ruleId: string, fix: Fix): string {
  return fixKey(ruleId, { ...fix, class: 'safe' });
}

/**
 * The second pass of -i: wraps `rules` so that each finding keeps its fix only when the user
 * accepted it, with the chosen alternative swapped in, as the planner expects. Fixes nobody was
 * asked about, such as one that a declined fix would have enabled, are dropped.
 *
 * Findings the engine makes itself (the directive rules) do not pass through a rule, so their
 * fixes cannot be filtered one by one: such a rule's fixes apply only when every one of them
 * offered was accepted as it is. `offered` are the fixes asked about; `known` lists every rule
 * id, for `ruleIds` without `--rule`.
 */
export function decide(
  rules: readonly AnyRule[],
  accepted: ReadonlyMap<PlannedFix, Fix>,
  offered: readonly PlannedFix[],
  ruleIds: ReadonlySet<string> | undefined,
  known: readonly string[],
): Decided {
  const chosen = new Map<string, Fix>();
  for (const [planned, fix] of accepted) chosen.set(decisionKey(planned.ruleId, planned.fix), fix);

  const wrapped = new Set(rules.map((rule) => rule.meta.id));
  const blocked = new Set<string>();
  for (const planned of offered) {
    if (wrapped.has(planned.ruleId)) continue;
    if (accepted.get(planned) !== planned.fix) blocked.add(planned.ruleId);
  }
  const withheld = [...accepted.keys()].filter((planned) => blocked.has(planned.ruleId));

  return {
    rules: rules.map((rule) => decidedRule(rule, chosen)),
    ruleIds:
      blocked.size === 0
        ? ruleIds
        : new Set([...(ruleIds ?? known)].filter((id) => !blocked.has(id))),
    withheld,
  };
}

function decidedRule(rule: AnyRule, chosen: ReadonlyMap<string, Fix>): AnyRule {
  return {
    meta: rule.meta,
    defaultOptions: rule.defaultOptions as unknown,
    check(context: RuleContext<unknown>) {
      rule.check({
        ...context,
        report(descriptor) {
          const { fix: reported, ...rest } = descriptor;
          const fix =
            reported === undefined ? undefined : chosen.get(decisionKey(rule.meta.id, reported));
          context.report(fix === undefined ? rest : { ...rest, fix });
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Write steps
// ---------------------------------------------------------------------------------------------

/** Fixes written as one all-or-nothing unit, because they change the same files. */
export interface WriteGroup {
  readonly write: FixWrite;
  /** The fixes whose changes the steps write, in the order given. */
  readonly fixes: readonly PlannedFix[];
  /** The changed files the steps write. */
  readonly files: readonly FileDiff[];
}

/**
 * Turns verified fixes and their combined file changes into write units. Fixes that touch a
 * common path, directly or through a rename chain, form one unit: the bytes of a file several
 * fixes edit are only known together. A unit's steps are its renames (a file moved away before
 * another takes its name), then its creates, then the final bytes of each edited or renamed
 * file. Units come in the order of their first fix. A changed file no fix names is not written.
 */
export function writeGroups(
  fixes: readonly PlannedFix[],
  files: readonly FileDiff[],
): WriteGroup[] {
  const parent = fixes.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    return root;
  };
  const union = (a: number, b: number): void => {
    const [x, y] = [find(a), find(b)];
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
  };
  const owners = new Map<string, number>();
  fixes.forEach((planned, index) => {
    for (const path of planned.fix.changes.flatMap(touchedPaths)) {
      const owner = owners.get(path);
      if (owner === undefined) owners.set(path, index);
      else union(owner, index);
    }
  });

  // A changed file joins the fixes that name its path or, for a rename, its old path.
  const ownerOf = (file: FileDiff): number | undefined => {
    const named = [file.path, ...(file.from === undefined ? [] : [file.from])]
      .map((path) => owners.get(path))
      .filter((owner): owner is number => owner !== undefined);
    const [first, ...rest] = named;
    if (first === undefined) return undefined;
    for (const other of rest) union(first, other);
    return first;
  };
  const fileOwners = files.map(ownerOf);

  const members = new Map<number, { fixes: PlannedFix[]; files: FileDiff[] }>();
  const member = (index: number): { fixes: PlannedFix[]; files: FileDiff[] } => {
    const root = find(index);
    let entry = members.get(root);
    if (entry === undefined) {
      entry = { fixes: [], files: [] };
      members.set(root, entry);
    }
    return entry;
  };
  fixes.forEach((planned, index) => member(index).fixes.push(planned));
  files.forEach((file, index) => {
    const owner = fileOwners[index];
    if (owner !== undefined) member(owner).files.push(file);
  });

  return [...members.entries()]
    .sort(([a], [b]) => a - b)
    .map(([root, entry]) => ({
      write: { id: String(root), steps: stepsOf(entry.files) },
      fixes: entry.fixes,
      files: entry.files,
    }));
}

function stepsOf(files: readonly FileDiff[]): WriteStep[] {
  const renames = files.filter((file) => file.op === 'rename');
  const ordered: FileDiff[] = [];
  const pending = [...renames];
  while (pending.length > 0) {
    // A rename whose target another pending rename still has to vacate waits for it.
    const index = pending.findIndex(
      (file) => !pending.some((other) => other !== file && other.from === file.path),
    );
    // A cycle: written in order, and the writer refuses the target that exists.
    if (index === -1) {
      ordered.push(...pending.splice(0));
      break;
    }
    ordered.push(...pending.splice(index, 1));
  }

  const steps: WriteStep[] = [];
  for (const file of ordered) {
    if (file.from !== undefined) steps.push({ kind: 'rename', from: file.from, to: file.path });
  }
  for (const file of files) {
    if (file.op === 'create') steps.push({ kind: 'create', path: file.path, bytes: file.after });
  }
  for (const file of files) {
    if (file.op === 'create') continue;
    if (file.op === 'rename' && file.before !== undefined && sameBytes(file.before, file.after)) {
      continue;
    }
    steps.push({ kind: 'replace', path: file.path, bytes: file.after });
  }
  return steps;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Verification on disk
// ---------------------------------------------------------------------------------------------

function active(scan: Pick<ScanResult, 'findings'>): Finding[] {
  return scan.findings.filter((finding) => finding.suppressed === undefined);
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * The scan from disk against the scan before, as the in-memory verification compares them:
 * findings match by rule and path (mapped through `renames`) as a multiset. A written fix is
 * unverified when its findings are not gone: at a rule and path, more findings than before
 * minus those the written fixes resolve there.
 */
export function verifyOnDisk(
  before: Pick<ScanResult, 'findings'>,
  after: Pick<ScanResult, 'findings'>,
  renames: ReadonlyMap<string, string>,
  written: readonly PlannedFix[],
): { verification: FixVerification; unverified: PlannedFix[] } {
  const keyOf = (ruleId: string, path: string): string => `${ruleId}\u0000${path}`;
  const previous = active(before);
  const pool = new Map<string, number>();
  const byFingerprint = new Map<string, string>();
  for (const finding of previous) {
    const key = keyOf(finding.ruleId, renames.get(finding.path) ?? finding.path);
    increment(pool, key);
    byFingerprint.set(finding.fingerprint, key);
  }

  const slots = new Map(pool);
  const counts = new Map<string, number>();
  const introduced: Finding[] = [];
  let matched = 0;
  for (const finding of active(after)) {
    const key = keyOf(finding.ruleId, finding.path);
    increment(counts, key);
    const free = slots.get(key) ?? 0;
    if (free > 0) {
      slots.set(key, free - 1);
      matched++;
    } else {
      introduced.push(finding);
    }
  }

  const resolvedHere = new Map<string, number>();
  for (const planned of written) {
    for (const fingerprint of new Set(planned.findings)) {
      const key = byFingerprint.get(fingerprint);
      if (key !== undefined) increment(resolvedHere, key);
    }
  }
  const failed = new Set<string>();
  for (const [key, resolved] of resolvedHere) {
    if ((counts.get(key) ?? 0) > (pool.get(key) ?? 0) - resolved) failed.add(key);
  }
  const unverified = written.filter((planned) =>
    planned.findings.some((fingerprint) => {
      const key = byFingerprint.get(fingerprint);
      return key !== undefined && failed.has(key);
    }),
  );
  return {
    verification: { resolved: previous.length - matched, remaining: matched, introduced },
    unverified,
  };
}

// ---------------------------------------------------------------------------------------------
// Report input
// ---------------------------------------------------------------------------------------------

function viewOf(
  session: Session,
  mode: FixView['mode'],
  fixes: readonly PlannedFix[],
  files: readonly ChangedFile[],
  manual: readonly ManualStep[],
  verification: FixVerification,
): FixView {
  return { mode, pathBase: session.base, fixes, files, manual, verification };
}

function withBase(base: string, path: string): string {
  return base === '' ? path : `${base}/${path}`;
}

function withStatus(planned: PlannedFix, status: 'planned' | 'applied'): PlannedFix {
  const { status: _status, reason: _reason, ...rest } = planned;
  return { ...rest, status };
}

function skip(planned: PlannedFix, reason: FixSkipReason): PlannedFix {
  const { status: _status, reason: _reason, ...rest } = planned;
  return { ...rest, status: 'skipped', reason };
}

function version(bytes: Uint8Array): FileVersion {
  const decoded = decode(bytes);
  return {
    text: decoded.text,
    state: {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      encoding: decoded.encoding,
      bom: decoded.hasBom,
      lineEnding: decoded.lineEnding,
    },
  };
}

/** A changed file as the report shows it: decoded text and how it is stored, before and after. */
export function changedFile(file: FileDiff): ChangedFile {
  const after = version(file.after);
  if (file.op === 'create' || file.before === undefined) {
    return { op: 'create', path: file.path, after };
  }
  const before = version(file.before);
  if (file.op === 'rename' && file.from !== undefined) {
    return { op: 'rename', path: file.path, from: file.from, before, after };
  }
  return { op: 'edit', path: file.path, before, after };
}
