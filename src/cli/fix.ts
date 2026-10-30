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
 * 4. `-i` asks about each verified fix, then about each fix that needs the user's words: it asks
 *    for the words, completes and verifies the fix in memory (src/fix/input.ts) and shows its
 *    diff. It also offers to suppress a warning or info with a reason. Then it plans again with
 *    only the accepted fixes (an alternative, a completed fix or a suppression takes the place of
 *    the rule's fix in its finding) and writes those as `--write` does. What is left to the user
 *    comes from the scan from disk: the findings of declined fixes and the manual steps of the
 *    findings still there.
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
import { createParseCache } from '../core/parse-cache.js';
import { decode } from '../core/text.js';
import type {
  AnyRule,
  FileChange,
  Finding,
  Fix,
  FixClass,
  FixInput,
  RuleContext,
} from '../core/types.js';
import {
  type AwaitingInput,
  completeInput,
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
  needsInput,
  type PlannedFix,
  verifyCompletedInput,
} from '../fix/index.js';
import { relativeInsideRoot } from '../io/paths.js';
import { checkRoot, walk, type WalkOptions } from '../io/walk.js';
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
import { judgmentCount } from '../tasks/index.js';
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
import { prefillable } from './prompt.js';
import { suggest } from './suggest.js';

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
  if (options.format === 'suggestions' || options.diff !== undefined) return suggest(options, io);
  const prompt = options.interactive ? terminalOf(io) : undefined;
  const ruleIds = checkedRuleIds(options.rules);
  const root = (await checkRoot(resolve(io.cwd, options.path))).path;
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
    // Every scan of the run (rounds, -i's second pass, the scan from disk) shares the parses.
    scanOptions: {
      ...scanOptionsFor(options, config, options.targets),
      parseCache: createParseCache(),
    },
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
  const view: FixView = {
    ...viewOf(
      session,
      'dry-run',
      [...rounds.applied, ...rounds.deferred, ...rounds.skipped],
      rounds.files.map(changedFile),
      rounds.manual,
      rounds.verification,
      rounds.awaitingInput,
    ),
    // What `agentcheckup tasks` would hand to an agent now, for the last line of the diff.
    judgment: judgmentCount(
      rounds.before.findings,
      new Map(rounds.before.artifacts.map((artifact) => [artifact.path, artifact.kind])),
    ),
  };
  const report =
    session.options.format === 'json'
      ? formatFixJson(view)
      : formatFixDiff(view, { style: session.style });
  await emit(report, session.options, session.io);
  if (rounds.before.ruleFailures.length > 0) {
    reportCrashes(rounds.before, session.io);
    return EXIT.internal;
  }
  // Fixes that need the user's words change nothing until -i asks for them: like manual steps,
  // they do not make the dry run exit 1.
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
  // Fixes that need the user's words are never written: the summary says -i asks for them.
  const view = viewOf(
    session,
    'write',
    [...outcome.fixes, ...rounds.deferred, ...skipped],
    outcome.files,
    rounds.manual,
    outcome.verification,
    rounds.awaitingInput,
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
  const asked = rounds.applied.length + rounds.awaitingInput.length;
  if (asked > 0 && session.options.output === undefined) io.stdout('\n');

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

/**
 * One fix -i asks about: a verified fix, or a fix that needs the user's words (`entry`), as the
 * planned fix that decide() takes.
 */
interface Offer {
  readonly planned: PlannedFix;
  readonly entry?: AwaitingInput;
}

/** What answering the fixes needs. */
interface Asking {
  readonly session: Session;
  readonly prompt: Prompt;
  readonly rounds: FixRounds;
  /** The changed files of the rounds, for the diffs of verified fixes. */
  readonly files: readonly ChangedFile[];
  /** The files as they are, analyzed, for completing fixes that need the user's words. */
  readonly parses: Analysis;
}

/** The answer about one fix. */
type Answer =
  | { readonly kind: 'yes'; readonly fix: Fix; readonly all?: boolean }
  | { readonly kind: 'no' | 'quit' | 'abort' };

const NO: Answer = { kind: 'no' };
const QUIT: Answer = { kind: 'quit' };
const ABORT: Answer = { kind: 'abort' };

/** A fix that awaits input as the planned fix decide() swaps the completed fix in for. */
function awaitingAsPlanned(entry: AwaitingInput): PlannedFix {
  return {
    fix: entry.fix,
    ruleId: entry.ruleId,
    findings: entry.findings,
    effects: [],
    status: 'planned',
  };
}

/**
 * Asks about each verified fix, then about each fix that needs the user's words, in plan order.
 * [A]ll accepts a fix and the verified fixes of its rule still to come, without asking.
 */
async function ask(session: Session, prompt: Prompt, rounds: FixRounds): Promise<Answers> {
  const { io } = session;
  const accepted = new Map<PlannedFix, Fix>();
  const declined: PlannedFix[] = [];
  const offers: Offer[] = [
    ...rounds.applied.map((planned) => ({ planned })),
    ...rounds.awaitingInput.map((entry) => ({ planned: awaitingAsPlanned(entry), entry })),
  ];
  if (offers.length === 0) {
    io.stdout('Nothing to fix.\n');
    return { accepted, declined, aborted: false };
  }
  const asking: Asking = {
    session,
    prompt,
    rounds,
    files: rounds.files.map(changedFile),
    parses: analyze(session.snapshot, session.scanOptions),
  };
  const all = new Set<string>();

  for (const [index, offer] of offers.entries()) {
    const { planned } = offer;
    const ready = (other: Offer): boolean =>
      other.entry === undefined && other.planned.ruleId === planned.ruleId;
    if (ready(offer) && all.has(planned.ruleId)) {
      accepted.set(planned, planned.fix);
      continue;
    }
    const later = offers.slice(index + 1).filter(ready).length;
    const answer = await askOne(asking, offer, `(${index + 1}/${offers.length})`, later, index);
    switch (answer.kind) {
      case 'abort':
        return { accepted, declined, aborted: true };
      case 'quit':
        declined.push(...offers.slice(index).map((item) => item.planned));
        return { accepted, declined, aborted: false };
      case 'no':
        declined.push(planned);
        break;
      case 'yes':
        accepted.set(planned, answer.fix);
        if (answer.all === true) {
          all.add(planned.ruleId);
          io.stdout(
            `Applying the ${later === 1 ? 'other fix' : `${later} other fixes`} of ` +
              `${forTerminal(planned.ruleId)} too, without asking.\n`,
          );
        }
        break;
    }
  }
  return { accepted, declined, aborted: false };
}

/**
 * Shows one fix and asks about it until the user decides. A verified fix shows its diff; a fix
 * that needs the user's words shows its finding, and yes asks for the words. `later` counts the
 * verified fixes of the same rule still to come, which [A]ll accepts too.
 */
async function askOne(
  asking: Asking,
  offer: Offer,
  counter: string,
  later: number,
  index: number,
): Promise<Answer> {
  const { session, prompt, rounds } = asking;
  const { io } = session;
  const { planned, entry } = offer;
  // As an interactive add shows each hunk: the fix with its diff, then the question.
  const block =
    entry === undefined
      ? fixBlock(session, planned, rounds.applied, filesOf(planned, asking.files))
      : inputBlock(asking, entry);
  io.stdout(`${index === 0 ? '' : '\n'}${block}`);

  const alternatives = planned.fix.alternatives ?? [];
  const suppress = suppression(asking, planned);
  const all = entry === undefined && later > 0;
  const yesByDefault = entry === undefined && planned.fix.class === 'safe';
  const choices: (readonly [string, string, boolean])[] = [
    ['y', '[y]es', true],
    ['n', '[n]o', true],
    ['d', '[d]iff', entry === undefined],
    ['a', '[a]lternatives', alternatives.length > 0],
    ['s', '[s]uppress', suppress !== undefined],
    ['A', '[A]ll', all],
  ];
  const offered = choices.filter(([, , shown]) => shown);
  const lead = entry === undefined ? 'Apply?' : forTerminal(entry.fix.input.question);
  const question =
    `${counter} ${lead} ${offered.map(([, label]) => label).join(' ')} [q]uit ` +
    `(Enter: ${yesByDefault ? 'yes' : 'no'}) `;
  const letters = offered.map(([letter]) => letter).join(', ');
  const yes = (fix: Fix): Answer => ({ kind: 'yes', fix });
  /** The answer once the words were asked for: undefined to ask about the fix again. */
  const worded = (fix: Fix | undefined | null): Answer | undefined =>
    fix === null ? ABORT : fix === undefined ? undefined : yes(fix);

  for (;;) {
    const answer = await prompt.ask(question);
    if (answer === undefined) return ABORT;
    const text = answer.trim();
    // [A]ll is the capital letter: lowercase a lists the alternatives.
    if (all && (text === 'A' || text.toLowerCase() === 'all')) {
      return { kind: 'yes', fix: planned.fix, all: true };
    }
    let decided: Answer | undefined;
    switch (text.toLowerCase()) {
      case '':
        return yesByDefault ? yes(planned.fix) : NO;
      case 'y':
      case 'yes':
        if (entry === undefined) return yes(planned.fix);
        decided = worded(await askWords(asking, planned, entry.fix, false));
        break;
      case 'n':
      case 'no':
        return NO;
      case 'd':
      case 'diff':
        if (entry === undefined) io.stdout(block);
        else io.stdout(`Answer ${letters} or q.\n`);
        break;
      case 'a':
      case 'alternatives': {
        const chosen = await chooseAlternative(prompt, io, alternatives);
        if (chosen === null) return ABORT;
        if (chosen === undefined) break;
        if (!needsInput(chosen)) return yes(chosen);
        io.stdout(`${forTerminal(chosen.input.question)}\n`);
        decided = worded(await askWords(asking, planned, chosen, true));
        break;
      }
      case 's':
      case 'suppress':
        if (suppress === undefined) io.stdout(`Answer ${letters} or q.\n`);
        else decided = worded(await askWords(asking, planned, suppress, false));
        break;
      case 'q':
      case 'quit':
        return QUIT;
      default:
        io.stdout(`Answer ${letters} or q.\n`);
    }
    if (decided !== undefined) return decided;
  }
}

/**
 * A fix that needs the user's words, before they are asked for: its rule, place and title, the
 * message of its finding and its notes. Repository text goes through `forTerminal`.
 */
function inputBlock(asking: Asking, entry: AwaitingInput): string {
  const { session, rounds } = asking;
  const finding = rounds.before.findings.find((item) => entry.findings.includes(item.fingerprint));
  const where = `${forTerminal(withBase(session.base, entry.path))}:${entry.line}`;
  const lines = [
    `${session.style.blue('input')}   ${forTerminal(entry.ruleId)}  ${where}  ${forTerminal(entry.fix.title)}`,
  ];
  if (finding !== undefined) lines.push(`  ${forTerminal(finding.message)}`);
  for (const note of entry.fix.notes ?? []) lines.push(`  note: ${forTerminal(note)}`);
  return `${lines.join('\n')}\n`;
}

/** The answer to `fix`, completed and verified, or why it cannot be used. */
type Checked =
  | {
      readonly ok: true;
      readonly fix: Fix;
      readonly planned: PlannedFix;
      readonly files: readonly ChangedFile[];
      readonly introduced: readonly Finding[];
    }
  | { readonly ok: false; readonly message: string };

/**
 * Completes `fix` with `answer` and verifies it on a copy in memory in place of `planned.fix`
 * (src/fix/input.ts). An alternative (`keepRenames`) keeps the renames of the fix it replaces.
 */
function checkAnswer(
  asking: Asking,
  planned: PlannedFix,
  fix: Fix & { readonly input: FixInput },
  answer: string,
  keepRenames: boolean,
): Checked {
  const completion = completeInput(fix, answer, asking.parses);
  if (!completion.ok) return completion;
  const completed = keepRenames
    ? withRenames(planned.fix, fix.input, completion.fix)
    : completion.fix;
  const { session } = asking;
  const verified = verifyCompletedInput(session.snapshot, session.scanOptions, planned, completed);
  if (!verified.ok) return verified;
  return {
    ok: true,
    fix: completed,
    planned: verified.fix,
    files: verified.run.files.map(changedFile),
    introduced: verified.run.verification.introduced,
  };
}

/**
 * Asks for the words of `fix` (a fix that needs them, an input alternative, or a suppression),
 * which takes the place of `planned.fix`: the `label ›` prompt, prefilled with the fix's text;
 * then the completed fix, checked by a re-scan, with its diff, and `Use this?`. A refused answer
 * shows why and is asked again, prefilled with that answer, as [e]dit does. Resolves with the
 * accepted fix, undefined to go back to the question (an empty answer or [n]o), or null when
 * input ended.
 */
async function askWords(
  asking: Asking,
  planned: PlannedFix,
  fix: Fix & { readonly input: FixInput },
  keepRenames: boolean,
): Promise<Fix | undefined | null> {
  const { session, prompt } = asking;
  const { io, style } = session;
  const { input } = fix;
  let initial = input.initial;
  for (;;) {
    const prefill = initial !== undefined && prefillable(initial) ? initial : undefined;
    const answer = await prompt.ask(`${forTerminal(input.label)} › `, { initial: prefill });
    if (answer === undefined) return null;
    if (answer.trim() === '') return undefined;
    initial = answer;
    const checked = checkAnswer(asking, planned, fix, answer, keepRenames);
    if (!checked.ok) {
      io.stdout(`${style.red('✗')} ${forTerminal(checked.message)}\n`);
      continue;
    }
    io.stdout(fixBlock(session, checked.planned, asking.rounds.applied, checked.files));
    io.stdout(`${style.green('✓')} re-scanned: ${outcomeText(planned, input, checked)}\n`);
    for (const finding of checked.introduced) {
      io.stdout(
        `  new info  ${forTerminal(withBase(session.base, finding.path))}:${finding.range.start.line}  ` +
          `${forTerminal(finding.ruleId)}  ${forTerminal(finding.message)}\n`,
      );
    }
    const use = await useThis(prompt, io);
    if (use === null) return null;
    if (use === 'yes') return checked.fix;
    if (use === 'no') return undefined;
  }
}

/** `the finding is resolved; no new problem.` */
function outcomeText(
  planned: PlannedFix,
  input: FixInput,
  checked: Extract<Checked, { ok: true }>,
): string {
  const findings = new Set(planned.findings).size;
  const subject = findings === 1 ? 'the finding is' : `its ${findings} findings are`;
  const done = input.field === 'suppression-reason' ? 'suppressed' : 'resolved';
  const added = checked.introduced.length;
  const news =
    added === 0 ? 'no new problem' : `${added} new info ${added === 1 ? 'finding' : 'findings'}`;
  return `${subject} ${done}; ${news}.`;
}

/** `Use this?` until the user answers: yes, edit, no, or null when input ended. */
async function useThis(prompt: Prompt, io: Io): Promise<'yes' | 'edit' | 'no' | null> {
  for (;;) {
    const answer = await prompt.ask('Use this? [y]es [e]dit [n]o (Enter: yes) ');
    if (answer === undefined) return null;
    switch (answer.trim().toLowerCase()) {
      case '':
      case 'y':
      case 'yes':
        return 'yes';
      case 'e':
      case 'edit':
        return 'edit';
      case 'n':
      case 'no':
        return 'no';
      default:
        io.stdout('Answer y, e or n.\n');
    }
  }
}

/**
 * An input alternative keeps the renames of the fix it replaces that move the file it writes
 * to: the answer is written into the file as it is, which is then moved as that fix moves it.
 * cursor/md-file-ignored asks for globs this way and still renames the rule to .mdc.
 */
export function withRenames(replaced: Fix, input: FixInput, completed: Fix): Fix {
  let path = input.target.path;
  const renames: FileChange[] = [];
  for (const change of replaced.changes) {
    if (change.kind !== 'rename' || change.from !== path) continue;
    renames.push(change);
    path = change.to;
  }
  return renames.length === 0
    ? completed
    : { ...completed, changes: [...completed.changes, ...renames] };
}

/**
 * True for a finding on a whole file, which is reported at line 1, column 1: a directive put
 * before it would sit on line 1 itself, so no line directive suppresses it.
 */
function onWholeFile(finding: Finding): boolean {
  const { start, end } = finding.range;
  return start.line === 1 && start.column === 1 && end.line === 1 && end.column === 1;
}

/** Rules whose fixes decide() can swap: the built-in rules, not the engine's directive rules. */
const SWAPPABLE: ReadonlySet<string> = new Set(builtinRules.map((rule) => rule.meta.id));

/**
 * The fix behind [s]uppress: a `disable-next-line` directive with a reason before the line of
 * `planned`'s findings, which -i asks for. Offered only when every finding of the fix is a
 * warning or info on one line of a file that takes directives, of a rule decide() can swap, as
 * the scan of the files as they are reports it; never for a risk finding or mcp/literal-secret,
 * which must be fixed, not silenced.
 */
function suppression(
  asking: Asking,
  planned: PlannedFix,
): (Fix & { readonly input: FixInput }) | undefined {
  const { ruleId } = planned;
  if (ruleId === LITERAL_SECRET_RULE || ruleId.startsWith('risk/') || !SWAPPABLE.has(ruleId)) {
    return undefined;
  }
  const carried = new Set(planned.findings);
  const findings = asking.rounds.before.findings.filter((finding) =>
    carried.has(finding.fingerprint),
  );
  const [first] = findings;
  if (first === undefined || findings.length !== carried.size) return undefined;
  const { path } = first;
  const { line } = first.range.start;
  const key = decisionKey(ruleId, planned.fix);
  const fits = findings.every(
    (finding) =>
      finding.severity !== 'error' &&
      finding.category !== 'risk' &&
      !onWholeFile(finding) &&
      finding.path === path &&
      finding.range.start.line === line &&
      // A fix that only an earlier round made possible is not what the scan reports here.
      finding.fix !== undefined &&
      decisionKey(ruleId, finding.fix) === key,
  );
  if (!fits) return undefined;
  const fix: Fix & { readonly input: FixInput } = {
    id: `${ruleId}#suppress`,
    class: 'review',
    title: `Suppress ${ruleId} on line ${line} of ${path}`,
    changes: [],
    input: {
      field: 'suppression-reason',
      question: 'Suppress this finding with a reason?',
      label: 'reason',
      target: { kind: 'directive', path, line, ruleId },
    },
  };
  // A file or line that takes no directive, such as JSON or a frontmatter delimiter.
  return completeInput(fix, 'reason', asking.parses).ok ? fix : undefined;
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
      `  ${index + 1}  ${(needsInput(alternative) ? 'input' : alternative.class).padEnd(7)} ${forTerminal(alternative.title)}`,
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
  awaitingInput: readonly AwaitingInput[] = [],
): FixView {
  return { mode, pathBase: session.base, fixes, files, manual, verification, awaitingInput };
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
