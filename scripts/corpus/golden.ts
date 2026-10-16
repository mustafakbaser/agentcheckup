/**
 * corpus/golden.json: every finding on every corpus repository in a canonical, sorted form, so a
 * refactor that must not change behavior can be checked against the whole corpus
 * (`run.ts --write-golden` before, `run.ts --check-golden` after). A deliberate change of the
 * fingerprint scheme is checked with `--check-golden --ignore-fingerprints`: every other field
 * must stay the same.
 *
 * The file is gitignored like results.json (docs/adr/0005-scoring.md: no per-repository results
 * are published). It holds rule ids, paths, ranges, severities and fingerprints, and a hash of
 * each message instead of the message itself.
 */
import { createHash } from 'node:crypto';

import { compareStrings } from '../../src/core/compare.js';
import type { ScanResult } from '../../src/core/engine.js';
import type { Range, Severity } from '../../src/core/types.js';
import { forJsonOutput, forTerminal } from '../../src/report/sanitize.js';
import { compareRepos, type RepoEntry } from './common.js';

export const GOLDEN_FORMAT = 1;

export interface GoldenFinding {
  readonly ruleId: string;
  readonly path: string;
  readonly range: Range;
  readonly severity: Severity;
  readonly fingerprint: string;
  /** First 16 hex digits of the SHA-256 of the message. */
  readonly messageHash: string;
  /** Present only on suppressed findings (none in `--untrusted` scans without a config). */
  readonly suppressed?: true;
}

export interface GoldenRepo {
  readonly repo: string;
  readonly sha: string;
  readonly findings: readonly GoldenFinding[];
}

export interface Golden {
  readonly format: typeof GOLDEN_FORMAT;
  readonly repos: readonly GoldenRepo[];
}

export function messageHash(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex').slice(0, 16);
}

function compareFindings(a: GoldenFinding, b: GoldenFinding): number {
  return (
    compareStrings(a.ruleId, b.ruleId) ||
    compareStrings(a.path, b.path) ||
    a.range.start.line - b.range.start.line ||
    a.range.start.column - b.range.start.column ||
    a.range.end.line - b.range.end.line ||
    a.range.end.column - b.range.end.column ||
    compareStrings(a.severity, b.severity) ||
    compareStrings(a.fingerprint, b.fingerprint) ||
    compareStrings(a.messageHash, b.messageHash) ||
    Number(a.suppressed === true) - Number(b.suppressed === true)
  );
}

function compareGoldenRepos(a: GoldenRepo, b: GoldenRepo): number {
  return compareRepos(a.repo, b.repo) || compareStrings(a.sha, b.sha);
}

/** The canonical golden entry of one scanned repository. */
export function goldenRepo(entry: RepoEntry, result: Pick<ScanResult, 'findings'>): GoldenRepo {
  const findings = result.findings.map((finding): GoldenFinding => ({
    ruleId: finding.ruleId,
    path: finding.path,
    range: {
      start: { line: finding.range.start.line, column: finding.range.start.column },
      end: { line: finding.range.end.line, column: finding.range.end.column },
    },
    severity: finding.severity,
    fingerprint: finding.fingerprint,
    messageHash: messageHash(finding.message),
    ...(finding.suppressed ? { suppressed: true as const } : {}),
  }));
  return { repo: entry.repo, sha: entry.sha, findings: findings.sort(compareFindings) };
}

export function makeGolden(repos: readonly GoldenRepo[]): Golden {
  return { format: GOLDEN_FORMAT, repos: [...repos].sort(compareGoldenRepos) };
}

/** One finding per line, so the file diffs well; paths are escaped like results.json. */
export function serializeGolden(golden: Golden): string {
  const repos = golden.repos.map((repo) => {
    const findings = repo.findings.map((finding) => `        ${JSON.stringify(finding)}`);
    return [
      '    {',
      `      "repo": ${JSON.stringify(repo.repo)},`,
      `      "sha": ${JSON.stringify(repo.sha)},`,
      findings.length === 0 ? '      "findings": []' : '      "findings": [',
      ...(findings.length === 0 ? [] : [findings.join(',\n'), '      ]']),
      '    }',
    ].join('\n');
  });
  return forJsonOutput(
    `{\n  "format": ${String(golden.format)},\n  "repos": [\n${repos.join(',\n')}\n  ]\n}\n`,
  );
}

export function parseGolden(text: string, file: string): Golden {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { format?: unknown }).format !== GOLDEN_FORMAT ||
    !Array.isArray((value as { repos?: unknown }).repos)
  ) {
    throw new Error(
      `${file} is not a golden file of format ${String(GOLDEN_FORMAT)}; write it again with --write-golden`,
    );
  }
  return value as Golden;
}

export function findingCount(golden: Golden): number {
  return golden.repos.reduce((sum, repo) => sum + repo.findings.length, 0);
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

export interface RuleDifference {
  readonly ruleId: string;
  /** In the golden file, not in the current scan. */
  readonly removed: readonly GoldenFinding[];
  /** In the current scan, not in the golden file. */
  readonly added: readonly GoldenFinding[];
}

export interface RepoDifference {
  readonly label: string;
  /** Set when the repository is on only one side (re-pinned, added or removed). */
  readonly missing?: 'current' | 'golden';
  readonly rules: readonly RuleDifference[];
}

export interface CompareOptions {
  /**
   * False to compare every field except the fingerprint: `--check-golden --ignore-fingerprints`,
   * for a deliberate change of the fingerprint scheme. Default true.
   */
  readonly fingerprints?: boolean;
}

/** Identity of a finding, independent of key order in the file. */
function keyOf(finding: GoldenFinding, fingerprints = true): string {
  const { start, end } = finding.range;
  return JSON.stringify([
    finding.ruleId,
    finding.path,
    start.line,
    start.column,
    end.line,
    end.column,
    finding.severity,
    fingerprints ? finding.fingerprint : '',
    finding.messageHash,
    finding.suppressed === true,
  ]);
}

/** Findings of `from` that `other` lacks, counting duplicates. */
function minus(
  from: readonly GoldenFinding[],
  other: readonly GoldenFinding[],
  fingerprints = true,
): GoldenFinding[] {
  const counts = new Map<string, number>();
  for (const finding of other) {
    const key = keyOf(finding, fingerprints);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: GoldenFinding[] = [];
  for (const finding of from) {
    const key = keyOf(finding, fingerprints);
    const left = counts.get(key) ?? 0;
    if (left > 0) counts.set(key, left - 1);
    else out.push(finding);
  }
  return out;
}

function byRule(
  removed: readonly GoldenFinding[],
  added: readonly GoldenFinding[],
): RuleDifference[] {
  const ids = [...new Set([...removed, ...added].map((finding) => finding.ruleId))];
  return ids.sort(compareStrings).map((ruleId) => ({
    ruleId,
    removed: removed.filter((finding) => finding.ruleId === ruleId).sort(compareFindings),
    added: added.filter((finding) => finding.ruleId === ruleId).sort(compareFindings),
  }));
}

/**
 * Differences between the golden file and the current scan, by repository and rule. With `only`
 * (lower-cased `owner/name`), just those repositories are compared, so a scan of some
 * repositories (`--only`) is checked against their entries alone. Without it, a repository on
 * one side only is a difference too.
 */
export function compareGolden(
  saved: Golden,
  current: Golden,
  only?: ReadonlySet<string>,
  options: CompareOptions = {},
): RepoDifference[] {
  const fingerprints = options.fingerprints ?? true;
  const out: RepoDifference[] = [];
  for (const { label, before, after } of pairRepos(saved, current, only)) {
    const removed =
      before === undefined ? [] : minus(before.findings, after?.findings ?? [], fingerprints);
    const added =
      after === undefined ? [] : minus(after.findings, before?.findings ?? [], fingerprints);
    const missing = before === undefined ? 'golden' : after === undefined ? 'current' : undefined;
    if (removed.length === 0 && added.length === 0 && missing === undefined) continue;
    out.push({
      label,
      ...(missing === undefined ? {} : { missing }),
      rules: byRule(removed, added),
    });
  }
  return out;
}

/**
 * The repositories of both files by `repo@sha`, sorted; with `only` (lower-cased `owner/name`),
 * just those.
 */
function pairRepos(
  saved: Golden,
  current: Golden,
  only: ReadonlySet<string> | undefined,
): { label: string; before?: GoldenRepo; after?: GoldenRepo }[] {
  const labelOf = (repo: GoldenRepo): string => `${repo.repo}@${repo.sha}`;
  const inScope = (repo: GoldenRepo): boolean =>
    only === undefined || only.has(repo.repo.toLowerCase());
  const savedByLabel = new Map(saved.repos.filter(inScope).map((repo) => [labelOf(repo), repo]));
  const currentByLabel = new Map(
    current.repos.filter(inScope).map((repo) => [labelOf(repo), repo]),
  );
  const all = [...new Map([...savedByLabel, ...currentByLabel]).values()].sort(compareGoldenRepos);
  return all.map((repo) => {
    const label = labelOf(repo);
    const before = savedByLabel.get(label);
    const after = currentByLabel.get(label);
    return {
      label,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    };
  });
}

export interface FingerprintChange {
  readonly ruleId: string;
  /** Findings of the rule that match a golden finding on every field but the fingerprint. */
  readonly findings: number;
  /** How many of them have a fingerprint the golden finding did not have. */
  readonly changed: number;
}

/**
 * For a deliberate change of the fingerprint scheme: pairs current findings with golden findings
 * that agree on every other field, and counts, per rule, the paired findings whose fingerprint
 * changed. Within a group of findings that agree on every other field, fingerprints are compared
 * as a multiset. Findings without a partner are left to {@link compareGolden}.
 */
export function fingerprintChanges(
  saved: Golden,
  current: Golden,
  only?: ReadonlySet<string>,
): FingerprintChange[] {
  const byRule = new Map<string, { findings: number; changed: number }>();
  for (const { before, after } of pairRepos(saved, current, only)) {
    if (before === undefined || after === undefined) continue;
    const groups = new Map<string, { saved: string[]; current: GoldenFinding[] }>();
    const group = (finding: GoldenFinding) => {
      const key = keyOf(finding, false);
      let entry = groups.get(key);
      if (entry === undefined) {
        entry = { saved: [], current: [] };
        groups.set(key, entry);
      }
      return entry;
    };
    for (const finding of before.findings) group(finding).saved.push(finding.fingerprint);
    for (const finding of after.findings) group(finding).current.push(finding);
    for (const { saved: fingerprints, current: findings } of groups.values()) {
      const left = new Map<string, number>();
      for (const fingerprint of fingerprints)
        left.set(fingerprint, (left.get(fingerprint) ?? 0) + 1);
      const paired = Math.min(fingerprints.length, findings.length);
      let unmatched = 0;
      for (const finding of findings) {
        const count = left.get(finding.fingerprint) ?? 0;
        if (count > 0) left.set(finding.fingerprint, count - 1);
        else unmatched++;
      }
      const ruleId = findings[0]?.ruleId;
      if (ruleId === undefined || paired === 0) continue;
      const tally = byRule.get(ruleId) ?? { findings: 0, changed: 0 };
      tally.findings += paired;
      // Unpaired current findings are additions, which compareGolden reports.
      tally.changed += Math.min(unmatched, paired);
      byRule.set(ruleId, tally);
    }
  }
  return [...byRule]
    .map(([ruleId, tally]) => ({ ruleId, ...tally }))
    .sort((a, b) => compareStrings(a.ruleId, b.ruleId));
}

function location(finding: GoldenFinding): string {
  const { start, end } = finding.range;
  return `${forTerminal(finding.path)}:${String(start.line)}:${String(start.column)}-${String(end.line)}:${String(end.column)}`;
}

/**
 * Human-readable differences. `messages` maps a message hash to the current message text, so
 * added findings show what they say; removed ones only have their hash.
 */
export function renderDifferences(
  differences: readonly RepoDifference[],
  messages: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [];
  for (const repo of differences) {
    const note =
      repo.missing === 'golden'
        ? ' (not in golden.json)'
        : repo.missing === 'current'
          ? ' (in golden.json, not scanned)'
          : '';
    lines.push(`${repo.label}${note}`);
    for (const rule of repo.rules) {
      lines.push(
        `  ${rule.ruleId}: ${String(rule.removed.length)} removed, ${String(rule.added.length)} added`,
      );
      for (const finding of rule.removed) {
        lines.push(
          `    - ${finding.severity} ${location(finding)} ${finding.fingerprint} message ${finding.messageHash}`,
        );
      }
      for (const finding of rule.added) {
        const text = messages.get(finding.messageHash);
        lines.push(
          `    + ${finding.severity} ${location(finding)} ${finding.fingerprint} message ${finding.messageHash}` +
            (text === undefined ? '' : `\n        ${forTerminal(text)}`),
        );
      }
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
