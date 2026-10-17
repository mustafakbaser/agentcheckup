/**
 * The "Fixes" section of corpus/SUMMARY.md: what agentcheckup offers for each finding the corpus
 * scan reports, how scores change after `agentcheckup fix`, and the totals of the fix replay.
 *
 * - Each unsuppressed finding gets one offer ({@link offerOf}): a safe fix, a fix that needs
 *   review, a fix that needs the user's words, a task that `agentcheckup tasks` hands to a coding
 *   agent, or none of these (a finding "For you" without a fix).
 * - Scores: fixes are applied and verified in memory with `fixRounds`, exactly as
 *   `agentcheckup fix --write` and `fix --write --review` would apply them; nothing is written.
 * - Replay: the checks of `run.ts --fix-replay --answers synthetic` (fix-replay.ts,
 *   answer-replay.ts), reduced to counts per repository ({@link replayFacts}).
 *
 * Per repository this keeps counts and three scores. The rendered section adds them up across the
 * corpus and names no repository, path or finding (docs/adr/0005-scoring.md: no per-repository
 * rankings). Output is deterministic: integers, sorted values, medians of sorted lists; no times.
 */
import type { RuleResult } from '../../src/core/engine.js';
import { formatInteger } from '../../src/core/format.js';
import type { ParseCache } from '../../src/core/parse-cache.js';
import type { ArtifactKind, Finding, Snapshot } from '../../src/core/types.js';
import { fixRounds, type FixSelection, LITERAL_SECRET_RULE } from '../../src/fix/index.js';
import { classify } from '../../src/platforms/classify.js';
import { fixOf, needsWords } from '../../src/report/feedback.js';
import { forYouReason } from '../../src/tasks/for-you.js';
import { type RepoAnswers, replayAnswers } from './answer-replay.js';
import {
  type RepoReplay,
  REPLAY_SCAN_OPTIONS,
  replayRepo,
  SAFE_AND_REVIEW_FIXES,
  SAFE_FIXES,
} from './fix-replay.js';

/**
 * What agentcheckup offers for a finding, in this order:
 * - `safe`: a fix `agentcheckup fix --write` applies;
 * - `review`: a fix that needs review, mcp/literal-secret's opt-in fix included;
 * - `input`: a fix that needs the user's words, which only `agentcheckup fix -i` asks for;
 * - `task`: no fix; `agentcheckup tasks` hands it to a coding agent;
 * - `none`: no fix, and "For you" (credentials, hidden content, MCP servers, hooks, permissions,
 *   settings, JSON files), so never a task.
 */
export const OFFERS = ['safe', 'review', 'input', 'task', 'none'] as const;
export type Offer = (typeof OFFERS)[number];

/** What one repository contributes. Never rendered on its own. */
export interface RepoFixFacts {
  /** Unsuppressed findings by what the tool offers for them ({@link offerOf}). */
  readonly findings: Readonly<Record<Offer, number>>;
  /**
   * The score of the scan, and after the fixes `fix --write` (`safe`) and `fix --write --review`
   * (`review`) would apply. Null without artifacts.
   */
  readonly score: {
    readonly before: number | null;
    readonly safe: number | null;
    readonly review: number | null;
  };
  /**
   * Messages of crashes in fixRounds, per selection. After a crash, the score after fixing is the
   * score before.
   */
  readonly crashes: { readonly safe?: string; readonly review?: string };
}

/** One repository's replay, as counts. */
export interface ReplayFacts {
  /** Fixes the replay selected: every class, mcp/literal-secret included. */
  readonly planned: number;
  readonly applied: number;
  /** Skipped or deferred, for any reason. */
  readonly notApplied: number;
  /** Safe fixes that verification made review, because they change a gated item. */
  readonly demoted: number;
  /** Files the applied fixes changed. */
  readonly files: number;
  /** Fixes that need the user's words, by what the synthetic answer did. */
  readonly answers: {
    readonly applied: number;
    /** Refused by the shape checks, or dropped by verification. */
    readonly rejected: number;
    /** No synthetic answer for the field, such as a suppression reason. */
    readonly unanswered: number;
  };
  /** Violations of the replay and of the answers: each is a bug. */
  readonly violations: number;
}

/** The kind of the file at each artifact path of a scan. */
export function kindsOf(
  artifacts: readonly { readonly path: string; readonly kind: ArtifactKind }[],
): Map<string, ArtifactKind> {
  return new Map(artifacts.map((artifact) => [artifact.path, artifact.kind]));
}

/** What the tool offers for an unsuppressed finding; see {@link OFFERS}. */
export function offerOf(finding: Finding, kinds: ReadonlyMap<string, ArtifactKind>): Offer {
  const fix = fixOf(finding, 'terminal');
  if (fix !== undefined) return needsWords(fix) ? 'input' : fix.class;
  const kind = kinds.get(finding.path) ?? classify(finding.path)?.kind;
  return forYouReason(finding.ruleId, kind) === undefined ? 'task' : 'none';
}

/**
 * The repository's facts. `result` is the corpus scan of `snapshot` (scanForSummary). Fixes are
 * planned only when the scan offers one of the selected class, so most repositories cost nothing.
 * `parseCache` shares parses with the other scans of the repository.
 */
export function fixFacts(
  snapshot: Snapshot,
  result: Pick<RuleResult, 'findings' | 'score' | 'artifacts'>,
  parseCache?: ParseCache,
): RepoFixFacts {
  const findings: Record<Offer, number> = { safe: 0, review: 0, input: 0, task: 0, none: 0 };
  const kinds = kindsOf(result.artifacts);
  for (const finding of result.findings) {
    if (finding.suppressed !== undefined) continue;
    findings[offerOf(finding, kinds)] += 1;
  }

  const before = result.score.score;
  // Neither selection opts in to mcp/literal-secret.
  const offered = (selection: FixSelection): boolean =>
    result.findings.some(
      (finding) =>
        finding.suppressed === undefined &&
        finding.fix !== undefined &&
        finding.fix.changes.length > 0 &&
        finding.ruleId !== LITERAL_SECRET_RULE &&
        selection.classes.has(finding.fix.class),
    );
  const crashes: { safe?: string; review?: string } = {};
  const after = (selection: FixSelection, name: 'safe' | 'review'): number | null => {
    if (!offered(selection)) return before;
    try {
      const options = {
        ...REPLAY_SCAN_OPTIONS,
        ...(parseCache === undefined ? {} : { parseCache }),
      };
      return fixRounds(snapshot, options, selection).after.score.score;
    } catch (error) {
      crashes[name] = error instanceof Error ? error.message : String(error);
      return before;
    }
  };
  return {
    findings,
    score: {
      before,
      safe: after(SAFE_FIXES, 'safe'),
      review: after(SAFE_AND_REVIEW_FIXES, 'review'),
    },
    crashes,
  };
}

/** The counts of one repository's replay and answers. */
export function summarizeReplay(
  replay: Pick<RepoReplay, 'decisions' | 'files' | 'violations'>,
  answers: Pick<RepoAnswers, 'entries' | 'violations'> | undefined,
): ReplayFacts {
  const applied = replay.decisions.filter((decision) => decision.outcome === 'applied').length;
  const entries = answers?.entries ?? [];
  const answered = (outcomes: readonly string[]): number =>
    entries.filter((entry) => outcomes.includes(entry.outcome)).length;
  return {
    planned: replay.decisions.length,
    applied,
    notApplied: replay.decisions.length - applied,
    demoted: replay.decisions.filter((decision) => decision.demoted).length,
    files: replay.files,
    answers: {
      applied: answered(['applied']),
      rejected: answered(['refused', 'failed']),
      unanswered: answered(['unanswered']),
    },
    violations: replay.violations.length + (answers?.violations.length ?? 0),
  };
}

/**
 * Replays every fix of a repository and answers every fix that needs words, as
 * `run.ts --fix-replay --answers synthetic` does, and keeps the counts. `repo` names the
 * repository in violations, which are counted, never rendered.
 */
export function replayFacts(repo: string, snapshot: Snapshot): ReplayFacts {
  const { replay, before } = replayRepo(repo, snapshot);
  const answers = before === undefined ? undefined : replayAnswers(repo, snapshot, before);
  return summarizeReplay(replay, answers);
}

function table(
  header: readonly string[],
  align: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${align.join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

const number = (value: number): string => formatInteger(value);

function percent(part: number, whole: number): string {
  return whole === 0 ? '-' : `${String(Math.round((part / whole) * 100))}%`;
}

/** Median of numbers, as in the score distribution: the mean of the middle two for an even count. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Score changes after fixing, over the repositories with a score. */
export function scoreChanges(
  all: readonly RepoFixFacts[],
  after: 'safe' | 'review',
): { readonly higher: number; readonly medianGain: number; readonly lower: number } {
  const deltas = all.flatMap((item) => {
    const { before } = item.score;
    const fixed = item.score[after];
    return before === null || fixed === null ? [] : [fixed - before];
  });
  const gains = deltas.filter((delta) => delta > 0);
  return {
    higher: gains.length,
    medianGain: median(gains),
    lower: deltas.filter((delta) => delta < 0).length,
  };
}

const OFFER_LABELS: Readonly<Record<Offer, string>> = {
  safe: 'With a safe fix',
  review: 'With a fix that needs review',
  input: 'With a fix that needs your words',
  task: 'A task for a coding agent',
  none: 'None of these: left to you',
};

function replayTable(replays: readonly ReplayFacts[]): string {
  const sum = (pick: (item: ReplayFacts) => number): number =>
    replays.reduce((total, item) => total + pick(item), 0);
  const words =
    sum((item) => item.answers.applied) +
    sum((item) => item.answers.rejected) +
    sum((item) => item.answers.unanswered);
  return table(
    ['Replay', 'Count'],
    ['---', '---:'],
    [
      ['Fixes planned', number(sum((item) => item.planned))],
      ['Applied and verified', number(sum((item) => item.applied))],
      ['Skipped or deferred', number(sum((item) => item.notApplied))],
      ['Safe fixes that verification made review', number(sum((item) => item.demoted))],
      ['Files changed', number(sum((item) => item.files))],
      ['Repositories with a changed file', number(replays.filter((item) => item.files > 0).length)],
      ['Fixes that need your words', number(words)],
      ['Answered with synthetic text and verified', number(sum((item) => item.answers.applied))],
      ['Answers refused or dropped by verification', number(sum((item) => item.answers.rejected))],
      [
        'Not answered: no synthetic text for the field',
        number(sum((item) => item.answers.unanswered)),
      ],
      ['Violations', number(sum((item) => item.violations))],
    ],
  );
}

/**
 * The "Fixes" section. Counts only: no repository names, paths or per-repository rows. Without
 * replays, the replay table is left out.
 */
export function renderFixSection(
  all: readonly RepoFixFacts[],
  replays: readonly ReplayFacts[] = [],
): string {
  const sum = (offer: Offer): number =>
    all.reduce((total, item) => total + item.findings[offer], 0);
  const total = OFFERS.reduce((count, offer) => count + sum(offer), 0);
  const repos = (offer: Offer): string =>
    number(all.filter((item) => item.findings[offer] > 0).length);
  const afterSafe = scoreChanges(all, 'safe');
  const afterReview = scoreChanges(all, 'review');
  const gain = (value: number): string => (value === 0 ? '-' : `+${String(value)}`);
  const sections = [
    'What agentcheckup offers for the findings above, as the scan reports it: a safe fix ' +
      '(`fix --write` applies it), a fix that needs review (`fix --write --review` or `fix -i`), ' +
      'a fix that needs your words (only `fix -i` asks for them), or, without a fix, a task that ' +
      '`agentcheckup tasks` hands to a coding agent. The rest have no fix and are never handed ' +
      'to an agent: credentials, hidden content, MCP servers, hooks, permissions and settings. ' +
      'The review count includes the opt-in fix of `mcp/literal-secret`. See ' +
      '[Fixing findings](../docs/fix.md) and [Tasks for a coding agent](../docs/tasks.md).',
    '',
    table(
      ['Findings', 'Count', 'Share', 'Repositories'],
      ['---', '---:', '---:', '---:'],
      OFFERS.map((offer) => [
        OFFER_LABELS[offer],
        number(sum(offer)),
        percent(sum(offer), total),
        repos(offer),
      ]),
    ),
    '',
    'Scores after applying the fixes in memory and verifying them, as `agentcheckup fix --write` ' +
      'and `fix --write --review` do. `mcp/literal-secret` stays opt-in and is not applied. The ' +
      'median gain is over the repositories whose score rises.',
    '',
    table(
      ['', 'After safe fixes', 'After safe and review fixes'],
      ['---', '---:', '---:'],
      [
        ['Repositories with a higher score', number(afterSafe.higher), number(afterReview.higher)],
        ['Median gain', gain(afterSafe.medianGain), gain(afterReview.medianGain)],
        ['Repositories with a lower score', number(afterSafe.lower), number(afterReview.lower)],
        [
          'Fix runs that crashed',
          number(all.filter((item) => item.crashes.safe !== undefined).length),
          number(all.filter((item) => item.crashes.review !== undefined).length),
        ],
      ],
    ),
  ];
  if (replays.length === 0) return sections.join('\n');
  return [
    ...sections,
    '',
    'The replay (`run.ts --fix-replay --answers synthetic`) applies every fix to an in-memory ' +
      'copy of each repository, the opt-in fix of `mcp/literal-secret` included, and checks ' +
      'that each one resolves its findings, adds no error or warning, leaves nothing for a ' +
      'second run and keeps the load plans consistent with the findings. It then answers each ' +
      'fix that needs words as `fix -i` would, with synthetic text, and checks the same. A ' +
      'violation is a bug in a rule or in the planner.',
    '',
    replayTable(replays),
  ].join('\n');
}
