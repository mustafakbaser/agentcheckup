/**
 * Scans the cached corpus (see fetch.ts) with every built-in rule and writes three files:
 *
 * - corpus/SUMMARY.md, committed: aggregate statistics only (docs/adr/0005-scoring.md).
 * - corpus/results.json and corpus/REPORT.md, gitignored: per-repository results for local
 *   review. results.json holds rule ids, paths and counts, never file content or finding
 *   messages; REPORT.md adds messages for sample findings.
 *
 *   npx tsx scripts/corpus/run.ts                     scan everything, write all three files
 *   npx tsx scripts/corpus/run.ts --only owner/name   scan some repositories and print their
 *                                                     findings instead (writes nothing)
 *
 * Each repository is scanned the way `agentcheck --untrusted` scans a checkout: the Snapshot is
 * built by replaying the walker over the git tree (virtual-walk.ts), and the repository cannot
 * suppress findings.
 *
 * Exit status: 0 ok, 1 a rule crashed on at least one repository (listed on stderr), 2 the cache
 * is incomplete (run fetch.ts first).
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import * as prettier from 'prettier';

import { compareStrings } from '../../src/core/compare.js';
import { scanSnapshot, type ScanResult } from '../../src/core/engine.js';
import { RULESET_VERSION, TOOL_NAME } from '../../src/core/meta.js';
import type { ArtifactKind, Finding, RuleMeta, Severity } from '../../src/core/types.js';
import { VERSION } from '../../src/core/version.js';
import { forJsonOutput, forMarkdown, forTerminal } from '../../src/report/sanitize.js';
import { builtinRules } from '../../src/rules/index.js';
import { CORPUS_DIR, loadRepos, log, type RepoEntry, repoLabel } from './common.js';
import { loadSnapshot } from './snapshot.js';

const { values } = parseArgs({
  options: { only: { type: 'string', multiple: true, default: [] } },
  strict: true,
});

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 3, warn: 2, info: 1 };
const SAMPLES_PER_RULE = 5;

// ---------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------

type SeverityCounts = Record<Severity, number>;

interface RuleCounts extends SeverityCounts {
  /** Artifact paths with at least one finding, sorted. */
  paths: string[];
}

interface RepoSummary {
  readonly repo: string;
  readonly sha: string;
  readonly artifacts: number;
  readonly artifactsByKind: Record<string, number>;
  readonly score: number | null;
  readonly grade: string | null;
  readonly capped: boolean;
  readonly findings: SeverityCounts;
  readonly rules: Record<string, RuleCounts>;
  readonly ruleFailures: string[];
  readonly skipped: Record<string, number>;
  readonly unresolvedSymlinks: number;
  readonly incompleteListing: boolean;
}

interface Scanned {
  readonly entry: RepoEntry;
  readonly result: ScanResult;
  readonly summary: RepoSummary;
}

const zero = (): SeverityCounts => ({ error: 0, warn: 0, info: 0 });

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => compareStrings(a, b)));
}

function summarize(entry: RepoEntry, result: ScanResult, incompleteListing: boolean): RepoSummary {
  const active = result.findings.filter((finding) => !finding.suppressed);
  const findings = zero();
  const rules = new Map<string, RuleCounts & { pathSet: Set<string> }>();
  for (const finding of active) {
    findings[finding.severity] += 1;
    const counts = rules.get(finding.ruleId) ?? { ...zero(), paths: [], pathSet: new Set() };
    counts[finding.severity] += 1;
    counts.pathSet.add(finding.path);
    rules.set(finding.ruleId, counts);
  }
  return {
    repo: entry.repo,
    sha: entry.sha,
    artifacts: result.artifacts.length,
    artifactsByKind: countBy(result.artifacts, (artifact) => artifact.kind),
    score: result.score.score,
    grade: result.score.grade,
    capped: result.score.capped,
    findings,
    rules: Object.fromEntries(
      [...rules]
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([id, { pathSet, ...counts }]) => [
          id,
          { ...counts, paths: [...pathSet].sort(compareStrings) },
        ]),
    ),
    ruleFailures: [...new Set(result.ruleFailures.map((failure) => failure.ruleId))].sort(
      compareStrings,
    ),
    skipped: countBy(result.skipped, (skip) => skip.reason),
    unresolvedSymlinks: result.unresolvedSymlinks.length,
    incompleteListing,
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown helpers. Paths and messages come from third-party repositories: every one goes
// through forMarkdown, or into a code span only when it is plain printable ASCII.
// ---------------------------------------------------------------------------------------------

const PLAIN = /^[\w ./:@+,=~-]+$/;

function code(text: string): string {
  return PLAIN.test(text) ? `\`${text}\`` : forMarkdown(text);
}

function blobUrl(entry: RepoEntry, filePath: string, line: number): string {
  const encoded = filePath
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
  return `https://github.com/${entry.repo}/blob/${entry.sha}/${encoded}#L${String(line)}`;
}

function table(
  header: readonly string[],
  align: readonly string[],
  rows: readonly string[][],
): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${align.join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '-' : `${String(Math.round((part / whole) * 100))}%`;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

interface RuleStats {
  readonly meta: RuleMeta | undefined;
  readonly id: string;
  readonly counts: SeverityCounts;
  readonly repos: number;
  readonly applicableRepos: number;
  readonly paths: number;
  readonly applicableArtifacts: number;
  readonly findings: { readonly scanned: Scanned; readonly finding: Finding }[];
}

function ruleStats(scanned: readonly Scanned[]): RuleStats[] {
  const metas = new Map(builtinRules.map((rule) => [rule.meta.id, rule.meta]));
  const ids = new Set(metas.keys());
  for (const item of scanned) for (const finding of item.result.findings) ids.add(finding.ruleId);
  const stats: RuleStats[] = [];
  for (const id of [...ids].sort(compareStrings)) {
    const meta = metas.get(id);
    const kinds = new Set<ArtifactKind>(meta?.appliesTo ?? []);
    const counts = zero();
    const findings: RuleStats['findings'][number][] = [];
    let repos = 0;
    let applicableRepos = 0;
    let applicableArtifacts = 0;
    let paths = 0;
    for (const item of scanned) {
      const applicable = item.result.artifacts.filter((artifact) =>
        kinds.has(artifact.kind),
      ).length;
      applicableArtifacts += applicable;
      if (applicable > 0) applicableRepos += 1;
      const own = item.result.findings.filter((f) => f.ruleId === id && !f.suppressed);
      if (own.length === 0) continue;
      repos += 1;
      paths += new Set(own.map((finding) => finding.path)).size;
      for (const finding of own) {
        counts[finding.severity] += 1;
        findings.push({ scanned: item, finding });
      }
    }
    stats.push({ meta, id, counts, repos, applicableRepos, paths, applicableArtifacts, findings });
  }
  return stats;
}

/** Up to `limit` findings, spread over as many repositories as possible, worst first. */
function samples(stats: RuleStats, limit: number): RuleStats['findings'] {
  const byRepo = new Map<string, RuleStats['findings'][number][]>();
  for (const item of stats.findings) {
    const list = byRepo.get(item.scanned.entry.repo) ?? [];
    list.push(item);
    byRepo.set(item.scanned.entry.repo, list);
  }
  const worst = (list: RuleStats['findings']): number =>
    Math.max(...list.map((item) => SEVERITY_RANK[item.finding.severity]));
  const queues = [...byRepo.values()]
    .map((list) =>
      [...list].sort(
        (a, b) => SEVERITY_RANK[b.finding.severity] - SEVERITY_RANK[a.finding.severity],
      ),
    )
    .sort((a, b) => worst(b) - worst(a));
  const picked: RuleStats['findings'][number][] = [];
  for (let round = 0; picked.length < limit; round++) {
    let any = false;
    for (const queue of queues) {
      const item = queue[round];
      if (item === undefined) continue;
      any = true;
      picked.push(item);
      if (picked.length >= limit) break;
    }
    if (!any) break;
  }
  return picked;
}

interface Crash {
  readonly ruleId: string;
  readonly message: string;
  /** Repositories where the rule threw this error, in corpus order. */
  readonly repos: readonly string[];
}

/** Rule failures grouped by rule and error message. */
function groupCrashes(scanned: readonly Scanned[]): Crash[] {
  const groups = new Map<string, { ruleId: string; message: string; repos: string[] }>();
  for (const { entry, result } of scanned) {
    for (const failure of result.ruleFailures) {
      const key = `${failure.ruleId}\u0000${failure.message}`;
      const group = groups.get(key) ?? {
        ruleId: failure.ruleId,
        message: failure.message,
        repos: [],
      };
      if (!group.repos.includes(entry.repo)) group.repos.push(entry.repo);
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort(
    (a, b) => compareStrings(a.ruleId, b.ruleId) || compareStrings(a.message, b.message),
  );
}

function listRepos(repos: readonly string[], limit: number): string {
  const shown = repos.slice(0, limit).join(', ');
  return repos.length > limit ? `${shown} and ${String(repos.length - limit)} more` : shown;
}

function severityTotals(scanned: readonly Scanned[]): SeverityCounts {
  const totals = zero();
  for (const item of scanned) {
    for (const severity of ['error', 'warn', 'info'] as const) {
      totals[severity] += item.summary.findings[severity];
    }
  }
  return totals;
}

/** Totals over the whole corpus (no per-repository data). */
function overviewTable(scanned: readonly Scanned[], crashes: readonly Crash[]): string {
  const totals = severityTotals(scanned);
  const count = (test: (item: Scanned) => boolean): string => String(scanned.filter(test).length);
  return table(
    ['', ''],
    ['---', '---:'],
    [
      ['Repositories scanned', String(scanned.length)],
      ['Repositories with artifacts', count((item) => item.summary.artifacts > 0)],
      ['Artifacts', String(scanned.reduce((sum, item) => sum + item.summary.artifacts, 0))],
      ['Errors', String(totals.error)],
      ['Warnings', String(totals.warn)],
      ['Infos', String(totals.info)],
      [
        'Repositories with findings',
        count(
          (item) =>
            item.summary.findings.error + item.summary.findings.warn + item.summary.findings.info >
            0,
        ),
      ],
      ['Rules that crashed', String(new Set(crashes.map((crash) => crash.ruleId)).size)],
    ],
  );
}

function artifactsByKindTable(scanned: readonly Scanned[]): string {
  const kindTotals = new Map<string, { artifacts: number; repos: number }>();
  for (const item of scanned) {
    for (const [kind, count] of Object.entries(item.summary.artifactsByKind)) {
      const value = kindTotals.get(kind) ?? { artifacts: 0, repos: 0 };
      value.artifacts += count;
      value.repos += 1;
      kindTotals.set(kind, value);
    }
  }
  return table(
    ['Kind', 'Artifacts', 'Repositories'],
    ['---', '---:', '---:'],
    [...kindTotals]
      .sort(([a, x], [b, y]) => y.artifacts - x.artifacts || compareStrings(a, b))
      .map(([kind, value]) => [`\`${kind}\``, String(value.artifacts), String(value.repos)]),
  );
}

/** Score buckets by grade, plus mean, median and minimum: aggregate only. */
function scoreDistribution(scanned: readonly Scanned[]): string[] {
  const scores = scanned
    .map((item) => item.summary.score)
    .filter((score): score is number => score !== null)
    .sort((a, b) => a - b);
  const buckets: [string, (score: number) => boolean][] = [
    ['90-100 (A)', (score) => score >= 90],
    ['80-89 (B)', (score) => score >= 80 && score < 90],
    ['70-79 (C)', (score) => score >= 70 && score < 80],
    ['60-69 (D)', (score) => score >= 60 && score < 70],
    ['0-59 (F)', (score) => score < 60],
  ];
  const mean =
    scores.length === 0 ? 0 : scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const median =
    scores.length === 0
      ? 0
      : scores.length % 2 === 1
        ? (scores[(scores.length - 1) / 2] ?? 0)
        : ((scores[scores.length / 2 - 1] ?? 0) + (scores[scores.length / 2] ?? 0)) / 2;
  const capped = scanned.filter((item) => item.summary.capped).length;
  return [
    table(
      ['Score', 'Repositories'],
      ['---', '---:'],
      [
        ...buckets.map(([label, test]) => [label, String(scores.filter(test).length)]),
        ['No artifacts (no score)', String(scanned.length - scores.length)],
      ],
    ),
    '',
    scores.length === 0
      ? 'No repository has a score.'
      : `Mean ${mean.toFixed(1)}, median ${String(median)}, lowest ${String(scores[0])}. ` +
        `${String(capped)} capped by a \`risk\` error.`,
  ];
}

function renderReport(
  repos: readonly RepoEntry[],
  scanned: readonly Scanned[],
  crashes: readonly Crash[],
): string {
  const out: string[] = [];
  const push = (...lines: string[]): void => {
    out.push(...lines);
  };
  push(
    '<!-- Generated by scripts/corpus/run.ts from the pinned corpus. Do not edit by hand. -->',
    '',
    '# Real-world corpus report',
    '',
    `${TOOL_NAME} ${VERSION}, rule set ${RULESET_VERSION}, ${String(builtinRules.length)} built-in rules, ` +
      `scanned as \`--untrusted\` with every platform targeted. Corpus: ${String(repos.length)} ` +
      'repositories pinned in [repos.json](repos.json). See [README.md](README.md). This file lists ' +
      'per-repository results for local review and is not committed.',
    '',
    '## Summary',
    '',
    overviewTable(scanned, crashes),
    '',
    '## Artifacts by kind',
    '',
    artifactsByKindTable(scanned),
    '',
    '## Score distribution',
    '',
    ...scoreDistribution(scanned),
    '',
  );

  // Findings per rule
  const stats = ruleStats(scanned);
  push(
    '## Findings per rule',
    '',
    '"Applicable" counts repositories and artifacts of a kind the rule checks.',
    '',
    stats.length === 0
      ? '_No rules are registered in `builtinRules` yet._'
      : table(
          [
            'Rule',
            'Severity',
            'Repos affected',
            'Applicable repos',
            'Files affected',
            'Applicable files',
            'Errors',
            'Warnings',
            'Infos',
          ],
          ['---', '---', '---:', '---:', '---:', '---:', '---:', '---:', '---:'],
          stats.map((stat) => [
            `\`${stat.id}\``,
            stat.meta?.severity ?? '-',
            `${String(stat.repos)} (${percent(stat.repos, stat.applicableRepos)})`,
            String(stat.applicableRepos),
            `${String(stat.paths)} (${percent(stat.paths, stat.applicableArtifacts)})`,
            String(stat.applicableArtifacts),
            String(stat.counts.error),
            String(stat.counts.warn),
            String(stat.counts.info),
          ]),
        ),
    '',
  );
  const neverApplicable = stats.filter((stat) => stat.meta && stat.applicableArtifacts === 0);
  if (neverApplicable.length > 0) {
    push(
      `Not exercised (no applicable artifact in the corpus): ${neverApplicable.map((stat) => `\`${stat.id}\``).join(', ')}.`,
      '',
    );
  }

  // Rule crashes
  push('## Rule crashes', '');
  if (crashes.length === 0) {
    push('None.', '');
  } else {
    push(
      'A crash on real input is a bug (in the rule, or in a parse service it calls). A rule that ' +
        'throws reports nothing for the whole repository, so its findings above are incomplete.',
      '',
      table(
        ['Rule', 'Error', 'Repositories'],
        ['---', '---', '---'],
        crashes.map((crash) => [
          `\`${crash.ruleId}\``,
          forMarkdown(crash.message),
          `${String(crash.repos.length)}: ${listRepos(
            crash.repos.map((repo) => `\`${repo}\``),
            5,
          )}`,
        ]),
      ),
      '',
    );
  }

  // Suspects
  const firing = stats
    .filter((stat) => stat.findings.length > 0)
    .sort(
      (a, b) =>
        b.repos / Math.max(1, b.applicableRepos) - a.repos / Math.max(1, a.applicableRepos) ||
        b.findings.length - a.findings.length ||
        compareStrings(a.id, b.id),
    );
  push(
    '## Top suspects for false positives',
    '',
    'For human review. Rules are ordered by the share of applicable repositories they fire on: a ' +
      'rule that fires on most well-maintained repositories is the first place to look for false ' +
      `positives. Up to ${String(SAMPLES_PER_RULE)} findings per rule, spread over different ` +
      'repositories, worst severity first. Each location links to the file at the pinned commit.',
    '',
  );
  if (firing.length === 0) push('_No findings._', '');
  for (const stat of firing) {
    push(
      `### \`${stat.id}\``,
      '',
      `${String(stat.findings.length)} findings in ${String(stat.paths)} files, ` +
        `${String(stat.repos)} of ${String(stat.applicableRepos)} applicable repositories.`,
      '',
      table(
        ['Repository', 'Location', 'Severity', 'Message'],
        ['---', '---', '---', '---'],
        samples(stat, SAMPLES_PER_RULE).map(({ scanned: item, finding }) => [
          `\`${repoLabel(item.entry)}\``,
          `[${code(`${finding.path}:${String(finding.range.start.line)}`)}](${blobUrl(item.entry, finding.path, finding.range.start.line)})`,
          finding.severity,
          forMarkdown(finding.message),
        ]),
      ),
      '',
    );
  }

  // Per repository
  push(
    '## Repositories',
    '',
    table(
      ['Repository', 'Artifacts', 'Score', 'Errors', 'Warnings', 'Infos', 'Notes'],
      ['---', '---:', '---:', '---:', '---:', '---:', '---'],
      scanned.map(({ entry, summary }) => {
        const notes: string[] = [];
        if (summary.incompleteListing) notes.push('incomplete tree listing (absent paths unknown)');
        if (summary.unresolvedSymlinks > 0) {
          notes.push(`${String(summary.unresolvedSymlinks)} unresolved symlinks`);
        }
        for (const [reason, count] of Object.entries(summary.skipped)) {
          notes.push(`${String(count)} skipped (${reason})`);
        }
        if (summary.ruleFailures.length > 0) {
          notes.push(`rule crash: ${summary.ruleFailures.map((id) => `\`${id}\``).join(', ')}`);
        }
        return [
          `[\`${repoLabel(entry)}\`](https://github.com/${entry.repo}/tree/${entry.sha})`,
          String(summary.artifacts),
          summary.score === null
            ? '-'
            : `${String(summary.score)}${summary.capped ? ' (capped)' : ''}`,
          String(summary.findings.error),
          String(summary.findings.warn),
          String(summary.findings.info),
          notes.join('; '),
        ];
      }),
    ),
    '',
  );
  return out.join('\n');
}

/**
 * corpus/SUMMARY.md, the only committed output: aggregate statistics (docs/adr/0005-scoring.md
 * publishes no rankings of other people's repositories). It holds no repository names, paths,
 * commit SHAs, finding messages or per-repository rows.
 */
function renderSummary(
  repos: readonly RepoEntry[],
  scanned: readonly Scanned[],
  crashes: readonly Crash[],
): string {
  const stats = ruleStats(scanned);
  const reposWith = (stat: RuleStats, severity?: Severity): string =>
    String(
      new Set(
        stat.findings
          .filter(({ finding }) => severity === undefined || finding.severity === severity)
          .map(({ scanned: item }) => item.entry.repo),
      ).size,
    );
  const crashRepos = new Map<string, Set<string>>();
  for (const crash of crashes) {
    const set = crashRepos.get(crash.ruleId) ?? new Set<string>();
    for (const repo of crash.repos) set.add(repo);
    crashRepos.set(crash.ruleId, set);
  }
  return [
    '<!-- Generated by scripts/corpus/run.ts from the pinned corpus. Do not edit by hand. -->',
    '',
    '# Real-world corpus summary',
    '',
    `Aggregate results of ${TOOL_NAME} ${VERSION} (rule set ${RULESET_VERSION}, ` +
      `${String(builtinRules.length)} built-in rules) on the ${String(repos.length)} repositories ` +
      'pinned in [repos.json](repos.json), scanned as `--untrusted` with every platform targeted. ' +
      'Only aggregate statistics are published; see [README.md](README.md).',
    '',
    '## Overview',
    '',
    overviewTable(scanned, crashes),
    '',
    '## Artifacts by kind',
    '',
    artifactsByKindTable(scanned),
    '',
    '## Score distribution',
    '',
    ...scoreDistribution(scanned),
    '',
    '## Findings by rule',
    '',
    'Repository columns count repositories with at least one finding of that severity. ' +
      '"Applicable" counts repositories with a file of a kind the rule checks.',
    '',
    stats.length === 0
      ? '_No rules are registered in `builtinRules` yet._'
      : table(
          [
            'Rule',
            'Severity',
            'Errors',
            'Warnings',
            'Infos',
            'Repos with errors',
            'Repos with warnings',
            'Repos with infos',
            'Repos affected',
            'Applicable repos',
          ],
          ['---', '---', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:'],
          stats.map((stat) => [
            `\`${stat.id}\``,
            stat.meta?.severity ?? '-',
            String(stat.counts.error),
            String(stat.counts.warn),
            String(stat.counts.info),
            reposWith(stat, 'error'),
            reposWith(stat, 'warn'),
            reposWith(stat, 'info'),
            reposWith(stat),
            String(stat.applicableRepos),
          ]),
        ),
    '',
    '## Rule crashes',
    '',
    crashRepos.size === 0
      ? 'None.'
      : table(
          ['Rule', 'Repositories'],
          ['---', '---:'],
          [...crashRepos]
            .sort(([a], [b]) => compareStrings(a, b))
            .map(([ruleId, set]) => [`\`${ruleId}\``, String(set.size)]),
        ),
    '',
  ].join('\n');
}

/** Writes generated output in the repository's Prettier style, so regenerating it is stable. */
async function writeFormatted(file: string, content: string): Promise<void> {
  const options = await prettier.resolveConfig(file);
  await writeFile(file, await prettier.format(content, { ...options, filepath: file }));
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const repos = await loadRepos();
const only = new Set(values.only.map((name) => name.toLowerCase()));
const unknown = [...only].filter(
  (name) => !repos.some((entry) => entry.repo.toLowerCase() === name),
);
if (unknown.length > 0) throw new Error(`not in corpus/repos.json: ${unknown.join(', ')}`);
const selected =
  only.size === 0 ? repos : repos.filter((entry) => only.has(entry.repo.toLowerCase()));

const scanned: Scanned[] = [];
const incomplete: string[] = [];
for (const entry of selected) {
  const loaded = await loadSnapshot(entry);
  if ('problem' in loaded) {
    incomplete.push(`${repoLabel(entry)}: ${loaded.problem}`);
    continue;
  }
  const result = scanSnapshot(loaded.snapshot, { rules: builtinRules, trustDirectives: false });
  scanned.push({ entry, result, summary: summarize(entry, result, loaded.truncated) });
}

if (incomplete.length > 0) {
  log(
    `The cache is incomplete; run \`npx tsx scripts/corpus/fetch.ts\` first:\n${incomplete.map((line) => `- ${line}`).join('\n')}`,
  );
  process.exit(2);
}

const crashes = groupCrashes(scanned);

if (only.size > 0) {
  for (const { entry, result, summary } of scanned) {
    process.stdout.write(
      `${repoLabel(entry)}: ${String(summary.artifacts)} artifacts, score ${String(summary.score)}\n`,
    );
    for (const finding of result.findings) {
      process.stdout.write(
        `  ${forTerminal(finding.path)}:${String(finding.range.start.line)}:${String(finding.range.start.column)}  ` +
          `${finding.severity}  ${finding.ruleId}  ${forTerminal(finding.message)}\n`,
      );
    }
  }
} else {
  const results = {
    tool: { name: TOOL_NAME, version: VERSION },
    ruleset: RULESET_VERSION,
    rules: builtinRules.map((rule) => rule.meta.id),
    repos: scanned.map(({ summary }) => summary),
  };
  await writeFormatted(
    path.join(CORPUS_DIR, 'results.json'),
    forJsonOutput(JSON.stringify(results, null, 2)),
  );
  await writeFormatted(path.join(CORPUS_DIR, 'REPORT.md'), renderReport(repos, scanned, crashes));
  await writeFormatted(path.join(CORPUS_DIR, 'SUMMARY.md'), renderSummary(repos, scanned, crashes));
  const totals = zero();
  for (const { summary } of scanned) {
    for (const severity of ['error', 'warn', 'info'] as const)
      totals[severity] += summary.findings[severity];
  }
  process.stdout.write(
    `${String(scanned.length)} repositories, ` +
      `${String(scanned.reduce((sum, item) => sum + item.summary.artifacts, 0))} artifacts, ` +
      `${String(totals.error)} errors, ${String(totals.warn)} warnings, ${String(totals.info)} infos. ` +
      'Wrote corpus/SUMMARY.md (committed) and corpus/results.json, corpus/REPORT.md (local).\n',
  );
}

if (crashes.length > 0) {
  log(
    `\nRules crashed on real input:\n` +
      crashes
        .map(
          (crash) =>
            `- ${crash.ruleId}: ${forTerminal(crash.message)} ` +
            `(${String(crash.repos.length)} repositories: ${listRepos(crash.repos, 5)})`,
        )
        .join('\n'),
  );
  process.exitCode = 1;
}
