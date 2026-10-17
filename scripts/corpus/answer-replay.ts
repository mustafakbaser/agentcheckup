/**
 * `run.ts --fix-replay --answers synthetic`: completes every fix that needs the user's words with
 * a synthetic answer, as `agentcheckup fix -i` does once the user typed one, and checks what -i
 * then writes:
 *
 * - each answer is completed with src/fix/input.ts `completeInput` (a refusal is counted with its
 *   message: the synthetic answer may not fit, which is not a bug by itself);
 * - the completed fixes take the place of the input fixes through decide(), as in -i, and one
 *   fixRounds run applies and verifies them together (a completed fix verification drops is
 *   counted with the rule's message);
 * - every applied completion resolves its findings and the fixed copy has no new error or warning
 *   (compareFindings of fix-replay.ts);
 * - a second run on the fixed copy asks nothing more of the same rule on the same file.
 *
 * Synthetic answers ({@link syntheticAnswer}), per field: a when-clause
 * `Use when the user asks about <name>.`; a description
 * `Helps with <name> tasks in this project. Use when the user asks about <name>.`; globs for the
 * TypeScript files under src and test; allowed-tools as prefilled. Suppression reasons are not
 * answered: the replay does not trust directives. Output names repositories, so it is for local
 * review only, like the rest of the replay.
 */
import { decide } from '../../src/cli/fix.js';
import { compareStrings } from '../../src/core/compare.js';
import { analyze, type RuleResult } from '../../src/core/engine.js';
import { createParseCache } from '../../src/core/parse-cache.js';
import type { Finding, Fix } from '../../src/core/types.js';
import {
  type AwaitingInput,
  completeInput,
  type FixScanOptions,
  fixRounds,
  type PlannedFix,
  planFixes,
  verifyCompletedInput,
} from '../../src/fix/index.js';
import { forTerminal } from '../../src/report/sanitize.js';
import { builtinRules } from '../../src/rules/index.js';
import { compareFindings, EVERY_FIX, REPLAY_SCAN_OPTIONS, type Violation } from './fix-replay.js';

/** What became of one fix that needs the user's words. */
export type AnswerOutcome =
  /** No synthetic answer for the field. */
  | 'unanswered'
  /** completeInput refused the answer. */
  | 'refused'
  /** Completed, but verification dropped it in the second pass. */
  | 'failed'
  /** Completed, verified and applied. */
  | 'applied';

export interface AnswerEntry {
  readonly ruleId: string;
  readonly fixId: string;
  readonly outcome: AnswerOutcome;
  /** Why it was refused or failed. */
  readonly message?: string;
}

export interface RepoAnswers {
  readonly repo: string;
  readonly ms: number;
  readonly entries: readonly AnswerEntry[];
  readonly violations: readonly Violation[];
}

/** The last directory of a skill's path, or the file name without its extension. */
function nameOf(path: string): string {
  const parts = path.split('/');
  const file = parts.at(-1) ?? path;
  if (file === 'SKILL.md' && parts.length >= 2) return parts.at(-2) ?? file;
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

/**
 * The answer a user could type for `entry`, or undefined for a field the replay does not answer:
 * a suppression reason (directives are not trusted here), allowed-tools without a prefilled value.
 */
export function syntheticAnswer(entry: AwaitingInput): string | undefined {
  const { input } = entry.fix;
  const name = nameOf(input.target.path);
  switch (input.field) {
    case 'skill-when-clause':
      return `Use when the user asks about ${name}.`;
    case 'skill-description':
      return `Helps with ${name} tasks in this project. Use when the user asks about ${name}.`;
    case 'cursor-globs':
      return 'src/**/*.ts, test/**/*.ts';
    case 'allowed-tools':
      return input.initial;
    case 'suppression-reason':
      return undefined;
  }
}

const keysOf = (findings: readonly Finding[]) =>
  findings
    .filter((finding) => finding.suppressed === undefined)
    .map(({ ruleId, path, severity, fingerprint }) => ({ ruleId, path, severity, fingerprint }));

/** Identity of a fix of a rule on a set of findings. */
const placeOf = (ruleId: string, fixId: string, findings: readonly string[]): string =>
  `${ruleId}\u0000${fixId}\u0000${[...new Set(findings)].sort(compareStrings).join(',')}`;

/**
 * Answers every fix that needs the user's words in one repository and checks the result.
 * `before` is the replay's scan of `snapshot`. Throws nothing: a crash is a violation.
 */
export function replayAnswers(
  repo: string,
  snapshot: Parameters<typeof fixRounds>[0],
  before: Pick<RuleResult, 'findings'>,
): RepoAnswers {
  const start = performance.now();
  const options: FixScanOptions = { ...REPLAY_SCAN_OPTIONS, parseCache: createParseCache() };
  const entries: AnswerEntry[] = [];
  const violations: Violation[] = [];
  const crash = (stage: string, error: unknown): RepoAnswers => ({
    repo,
    ms: performance.now() - start,
    entries,
    violations: [
      ...violations,
      {
        repo,
        kind: 'crash',
        ruleId: '',
        path: '',
        reason: `${stage}: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
  });

  const accepted = new Map<PlannedFix, Fix>();
  const asked = new Map<PlannedFix, AwaitingInput>();
  try {
    const analysis = analyze(snapshot, options);
    for (const entry of planFixes(analysis, before, EVERY_FIX).awaitingInput) {
      const base = { ruleId: entry.ruleId, fixId: entry.fix.id };
      const answer = syntheticAnswer(entry);
      if (answer === undefined) {
        entries.push({ ...base, outcome: 'unanswered' });
        continue;
      }
      const completion = completeInput(entry.fix, answer, analysis);
      if (!completion.ok) {
        entries.push({ ...base, outcome: 'refused', message: completion.message });
        continue;
      }
      const planned: PlannedFix = {
        fix: entry.fix,
        ruleId: entry.ruleId,
        findings: entry.findings,
        effects: [],
        status: 'planned',
      };
      accepted.set(planned, completion.fix);
      asked.set(planned, entry);
    }
  } catch (error) {
    return crash('completing the answers', error);
  }
  if (accepted.size === 0) return { repo, ms: performance.now() - start, entries, violations };

  try {
    const decided = decide(
      builtinRules,
      accepted,
      [],
      undefined,
      builtinRules.map((rule) => rule.meta.id),
    );
    const run = fixRounds(snapshot, { ...options, rules: decided.rules }, EVERY_FIX);
    const applied = new Set(
      run.applied.map((fix) => placeOf(fix.ruleId, fix.fix.id, fix.findings)),
    );
    for (const [planned, fix] of accepted) {
      const base = { ruleId: planned.ruleId, fixId: fix.id };
      if (applied.has(placeOf(planned.ruleId, fix.id, planned.findings))) {
        entries.push({ ...base, outcome: 'applied' });
        continue;
      }
      // The rule's own words, as -i shows them: verified alone on the original files.
      const entry = asked.get(planned);
      const alone =
        entry === undefined ? undefined : verifyCompletedInput(snapshot, options, entry, fix);
      const message =
        alone === undefined
          ? 'not applied'
          : alone.ok
            ? 'verified alone, but not applied with the other answers'
            : alone.message;
      entries.push({ ...base, outcome: 'failed', message });
    }

    const renames = new Map<string, string>();
    for (const file of run.files) if (file.from !== undefined) renames.set(file.from, file.path);
    violations.push(
      ...compareFindings(
        repo,
        keysOf(run.before.findings),
        keysOf(run.after.findings),
        renames,
        run.applied,
      ).violations,
    );
    const crashed = new Set(run.before.ruleFailures.map((failure) => failure.ruleId));
    for (const failure of run.after.ruleFailures) {
      if (crashed.has(failure.ruleId)) continue;
      violations.push({
        repo,
        kind: 'rule-crash',
        ruleId: failure.ruleId,
        path: '',
        reason: failure.message,
      });
    }

    // A second run asks nothing more of a rule on a file an answer fixed.
    const answered = new Set<string>();
    for (const fix of run.applied) {
      for (const finding of run.before.findings) {
        if (fix.findings.includes(finding.fingerprint)) {
          answered.add(`${fix.ruleId}\u0000${renames.get(finding.path) ?? finding.path}`);
        }
      }
    }
    const second = fixRounds(run.snapshot, options, EVERY_FIX, 1);
    for (const entry of second.awaitingInput) {
      if (!answered.has(`${entry.ruleId}\u0000${entry.path}`)) continue;
      violations.push({
        repo,
        kind: 'not-idempotent',
        ruleId: entry.ruleId,
        path: entry.path,
        reason: `a second run asks again: ${entry.fix.id}`,
      });
    }
  } catch (error) {
    return crash('applying the answers', error);
  }
  return { repo, ms: performance.now() - start, entries, violations };
}

/** The text `--answers synthetic` prints, and the number of violations. */
export function renderAnswers(replays: readonly RepoAnswers[]): {
  readonly text: string;
  readonly violations: number;
} {
  const outcomes: readonly AnswerOutcome[] = ['applied', 'failed', 'refused', 'unanswered'];
  const byRule = new Map<string, Record<AnswerOutcome, number>>();
  const messages = new Map<string, number>();
  for (const replay of replays) {
    for (const entry of replay.entries) {
      const row = byRule.get(entry.ruleId) ?? { applied: 0, failed: 0, refused: 0, unanswered: 0 };
      row[entry.outcome] += 1;
      byRule.set(entry.ruleId, row);
      if (entry.message !== undefined) {
        const key = `${entry.ruleId} ${entry.outcome}: ${entry.message}`;
        messages.set(key, (messages.get(key) ?? 0) + 1);
      }
    }
  }
  const total = (outcome: AnswerOutcome): number =>
    [...byRule.values()].reduce((sum, row) => sum + row[outcome], 0);
  const out: string[] = [
    '',
    `Synthetic answers: ${String(outcomes.reduce((sum, outcome) => sum + total(outcome), 0))} ` +
      `fixes need words; ${outcomes.map((outcome) => `${String(total(outcome))} ${outcome}`).join(', ')}.`,
  ];
  for (const [ruleId, row] of [...byRule].sort(([a], [b]) => compareStrings(a, b))) {
    out.push(
      `  ${ruleId}: ${outcomes.map((outcome) => `${String(row[outcome])} ${outcome}`).join(', ')}`,
    );
  }
  if (messages.size > 0) {
    out.push('Why answers were refused or failed:');
    for (const [message, count] of [...messages].sort(
      ([a, x], [b, y]) => y - x || compareStrings(a, b),
    )) {
      out.push(`  ${String(count)}x ${message}`);
    }
  }
  const times = replays.map((replay) => replay.ms);
  out.push(
    `Time: total ${String(Math.round(times.reduce((sum, value) => sum + value, 0)))} ms, ` +
      `max ${String(Math.round(Math.max(0, ...times)))} ms.`,
  );
  const violations = replays
    .flatMap((replay) => replay.violations)
    .sort(
      (a, b) =>
        compareStrings(a.repo, b.repo) ||
        compareStrings(a.ruleId, b.ruleId) ||
        compareStrings(a.path, b.path) ||
        compareStrings(a.reason, b.reason),
    );
  out.push(
    `Violations with synthetic answers: ${violations.length === 0 ? 'none.' : String(violations.length)}`,
  );
  for (const violation of violations) {
    out.push(
      `  ${violation.kind}  ${violation.repo}  ${violation.ruleId === '' ? '-' : violation.ruleId}  ` +
        `${violation.path === '' ? '-' : violation.path}  ${violation.reason}`,
    );
  }
  return {
    text: `${out.map((line) => forTerminal(line)).join('\n')}\n`,
    violations: violations.length,
  };
}
