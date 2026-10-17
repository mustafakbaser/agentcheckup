/**
 * The "Fixes" section of corpus/SUMMARY.md: how much of what the corpus scan finds
 * `agentcheckup fix` can repair, and how scores change after it does.
 *
 * Per repository this keeps counts and three scores. The rendered section adds them up across the
 * corpus and names no repository, path or finding (docs/adr/0005-scoring.md: no per-repository
 * rankings). Fixes are applied and verified in memory with `fixRounds`, exactly as
 * `agentcheckup fix --write` and `fix --write --review` would apply them; nothing is written.
 * Output is deterministic: integers, sorted values, medians of sorted lists.
 */
import type { RuleResult } from '../../src/core/engine.js';
import { formatInteger } from '../../src/core/format.js';
import type { Snapshot } from '../../src/core/types.js';
import { fixRounds, type FixSelection, LITERAL_SECRET_RULE } from '../../src/fix/index.js';
import { fixOf, guidanceOf } from '../../src/report/feedback.js';
import { REPLAY_SCAN_OPTIONS, SAFE_AND_REVIEW_FIXES, SAFE_FIXES } from './fix-replay.js';

/** What one repository contributes. Never rendered on its own. */
export interface RepoFixFacts {
  /** Unsuppressed findings by what the tool offers for them, as the scan reports it. */
  readonly findings: {
    /** A `safe` fix: `agentcheckup fix --write` applies it. */
    readonly safe: number;
    /** A fix that needs review, mcp/literal-secret's opt-in fix included. */
    readonly review: number;
    /** No fix, but a manual step the tool prints. */
    readonly guidance: number;
    /** Neither: the message is all there is. */
    readonly none: number;
  };
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

/**
 * The repository's facts. `result` is the corpus scan of `snapshot` (scanForSummary). Fixes are
 * planned only when the scan offers one of the selected class, so most repositories cost nothing.
 */
export function fixFacts(
  snapshot: Snapshot,
  result: Pick<RuleResult, 'findings' | 'score'>,
): RepoFixFacts {
  const findings = { safe: 0, review: 0, guidance: 0, none: 0 };
  for (const finding of result.findings) {
    if (finding.suppressed !== undefined) continue;
    const fix = fixOf(finding, 'terminal');
    if (fix !== undefined) findings[fix.class] += 1;
    else if (guidanceOf(finding) !== undefined) findings.guidance += 1;
    else findings.none += 1;
  }

  const before = result.score.score;
  // Neither selection opts in to mcp/literal-secret.
  const offered = (selection: FixSelection): boolean =>
    result.findings.some(
      (finding) =>
        finding.suppressed === undefined &&
        finding.fix !== undefined &&
        finding.ruleId !== LITERAL_SECRET_RULE &&
        selection.classes.has(finding.fix.class),
    );
  const crashes: { safe?: string; review?: string } = {};
  const after = (selection: FixSelection, name: 'safe' | 'review'): number | null => {
    if (!offered(selection)) return before;
    try {
      return fixRounds(snapshot, REPLAY_SCAN_OPTIONS, selection).after.score.score;
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

/** The "Fixes" section. Counts only: no repository names, paths or per-repository rows. */
export function renderFixSection(all: readonly RepoFixFacts[]): string {
  const sum = (pick: (item: RepoFixFacts) => number): number =>
    all.reduce((total, item) => total + pick(item), 0);
  const safe = sum((item) => item.findings.safe);
  const review = sum((item) => item.findings.review);
  const guidance = sum((item) => item.findings.guidance);
  const none = sum((item) => item.findings.none);
  const total = safe + review + guidance + none;
  const repos = (pick: (item: RepoFixFacts) => number): string =>
    number(all.filter((item) => pick(item) > 0).length);
  const afterSafe = scoreChanges(all, 'safe');
  const afterReview = scoreChanges(all, 'review');
  const gain = (value: number): string => (value === 0 ? '-' : `+${String(value)}`);
  return [
    'What `agentcheckup fix` offers for the findings above, as the scan reports it: a safe fix ' +
      '(`fix --write` applies it), a fix that needs review (`fix --write --review` or `fix -i`), ' +
      'or guidance only (a manual step the tool prints). The review count includes the opt-in ' +
      'fix of `mcp/literal-secret`. See ' +
      '[Fixing what it finds](../docs/fix.md).',
    '',
    table(
      ['Findings', 'Count', 'Share', 'Repositories'],
      ['---', '---:', '---:', '---:'],
      [
        [
          'With a safe fix',
          number(safe),
          percent(safe, total),
          repos((item) => item.findings.safe),
        ],
        [
          'With a fix that needs review',
          number(review),
          percent(review, total),
          repos((item) => item.findings.review),
        ],
        [
          'Guidance only',
          number(guidance),
          percent(guidance, total),
          repos((item) => item.findings.guidance),
        ],
        ['Neither', number(none), percent(none, total), repos((item) => item.findings.none)],
      ],
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
  ].join('\n');
}
