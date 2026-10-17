/**
 * Timing harness for `agentcheckup fix` on the cached corpus (not a CI test; writes nothing):
 *
 *   npx tsx scripts/corpus/fix-timing.ts [--only owner/name ...] [--runs N] [--before]
 *
 * For each repository with a fixable finding (or those named with `--only`), runs `fixRounds`
 * as the dry run of `agentcheckup fix` does (safe and review fixes, mcp/literal-secret not
 * selected) and prints the time of each run and the number of scans:
 *
 * - `after`: the batch strategy with one parse cache per run, as the CLI runs it.
 * - `before`, with `--before`: one scan per fix and no parse cache, as `fix` verified before
 *   the batch strategy (src/fix/verify.ts). Slow: more than ten minutes on the repository with the
 *   most fixes. The two must agree on everything `fixRounds` returns; a difference is printed
 *   and makes the exit status 1.
 *
 * The machine may be busy with other work: `--runs` repeats each measurement and the table shows
 * every run. Output names repositories, so it is for local review only, like corpus/REPORT.md.
 */
import { isDeepStrictEqual, parseArgs } from 'node:util';

import { compareStrings } from '../../src/core/compare.js';
import type { ParseCache } from '../../src/core/parse-cache.js';
import type { AnyRule, FixClass, RuleContext, Snapshot } from '../../src/core/types.js';
import type { FixSelection } from '../../src/fix/index.js';
import { fixRounds, type FixRoundsOptions, type FixRun } from '../../src/fix/verify.js';
import { builtinRules } from '../../src/rules/index.js';
import { loadRepos, log, repoLabel } from './common.js';
import { REPLAY_SCAN_OPTIONS } from './fix-replay.js';
import { loadSnapshot } from './snapshot.js';

const { values } = parseArgs({
  options: {
    only: { type: 'string', multiple: true, default: [] },
    runs: { type: 'string', default: '1' },
    before: { type: 'boolean', default: false },
  },
  strict: true,
});
const runs = Number(values.runs);
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');

/** What the dry run of `agentcheckup fix` selects. */
const DRY_RUN: FixSelection = {
  classes: new Set<FixClass>(['safe', 'review']),
  literalSecret: false,
};

/** Parses nothing ahead: every scan parses every file again, as before the cache. */
const NO_CACHE: ParseCache = {
  decoded: (_bytes, compute) => compute(),
  frontmatter: (_text, compute) => compute(),
  markdown: (_text, _windowEnd, compute) => compute(),
  json: (_text, _dialect, compute) => compute(),
  toml: (_decoded, compute) => compute(),
};

interface Timed {
  readonly ms: number;
  readonly scans: number;
  readonly run: FixRun;
}

/** Runs fixRounds once, counting scans by the calls of the first rule. */
function timed(snapshot: Snapshot, strategy: NonNullable<FixRoundsOptions['strategy']>): Timed {
  let scans = 0;
  const [first, ...rest] = builtinRules;
  if (first === undefined) throw new Error('no rules');
  const counter: AnyRule = {
    meta: first.meta,
    defaultOptions: first.defaultOptions as unknown,
    check(context: RuleContext<unknown>) {
      scans++;
      first.check(context as never);
    },
  };
  const options = {
    ...REPLAY_SCAN_OPTIONS,
    rules: [counter, ...rest],
    ...(strategy === 'isolated' ? { parseCache: NO_CACHE } : {}),
  };
  const start = performance.now();
  const run = fixRounds(snapshot, options, DRY_RUN, undefined, { strategy });
  return { ms: performance.now() - start, scans, run };
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const only = new Set(values.only.map((name) => name.toLowerCase()));
const rows: { repo: string; after: Timed[]; before: Timed[] }[] = [];
let differences = 0;
for (const entry of await loadRepos()) {
  if (only.size > 0 && !only.has(entry.repo.toLowerCase())) continue;
  const loaded = await loadSnapshot(entry);
  if ('problem' in loaded) throw new Error(`${repoLabel(entry)}: ${loaded.problem}`);
  const after = Array.from({ length: runs }, () => timed(loaded.snapshot, 'batch'));
  const [reference] = after;
  if (reference === undefined) continue;
  if (
    only.size === 0 &&
    reference.run.before.findings.every((finding) => finding.fix === undefined)
  )
    continue;
  const before = values.before
    ? Array.from({ length: runs }, () => timed(loaded.snapshot, 'isolated'))
    : [];
  for (const run of before) {
    if (isDeepStrictEqual(run.run, reference.run)) continue;
    differences++;
    log(`${repoLabel(entry)}: the batch and isolated strategies disagree`);
  }
  rows.push({ repo: entry.repo, after, before });
  log(
    `${entry.repo}: after ${after.map((item) => seconds(item.ms)).join(', ')}` +
      (before.length === 0 ? '' : `; before ${before.map((item) => seconds(item.ms)).join(', ')}`),
  );
}

const fastest = (list: readonly Timed[]): number => Math.min(...list.map((item) => item.ms));
const lines = [
  'Repository | fixes | after (each run) | scans | before (each run) | scans',
  '--- | ---: | --- | ---: | --- | ---:',
];
for (const row of [...rows].sort(
  (a, b) => fastest(b.after) - fastest(a.after) || compareStrings(a.repo, b.repo),
)) {
  const [first] = row.after;
  const [old] = row.before;
  lines.push(
    [
      row.repo,
      String(first?.run.applied.length ?? 0),
      row.after.map((item) => seconds(item.ms)).join(', '),
      String(first?.scans ?? 0),
      row.before.length === 0 ? '-' : row.before.map((item) => seconds(item.ms)).join(', '),
      old === undefined ? '-' : String(old.scans),
    ].join(' | '),
  );
}
const total = (pick: (row: (typeof rows)[number]) => readonly Timed[]): number =>
  rows.reduce((sum, row) => sum + (pick(row).length === 0 ? 0 : fastest(pick(row))), 0);
lines.push(
  '',
  `Total over ${String(rows.length)} repositories (fastest run each): ` +
    `after ${seconds(total((row) => row.after))}` +
    (values.before ? `, before ${seconds(total((row) => row.before))}` : '') +
    '.',
);
if (values.before) {
  lines.push(
    differences === 0 ? 'Both strategies agree.' : `Disagreements: ${String(differences)}.`,
  );
}
process.stdout.write(`${lines.join('\n')}\n`);
if (differences > 0) process.exitCode = 1;
