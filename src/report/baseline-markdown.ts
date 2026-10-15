/**
 * The pull request summary of a scan with `--baseline`: security-relevant changes that need
 * review (gate hits), new and resolved findings, and the change in session-start context per
 * agent. Part of the Markdown report (markdown.ts), which gives it a character budget so the
 * whole comment stays under GitHub's limit.
 *
 * Gate hit summaries, ids, paths and the baseline's ruleset come from repositories or from a
 * baseline file: all of it goes through `forMarkdown`.
 */
import type { BaselineDiff, GateHit, PlanDelta } from '../core/baseline-types.js';
import type { ScanResult } from '../core/engine.js';
import { formatInteger } from '../core/format.js';
import { stripPathBase } from '../core/rebase.js';
import type { LimitUsage } from '../platforms/load/types.js';
import { AGENT_NAMES } from './context-view.js';
import { gateRows, newRuleFindings } from './gate.js';
import { toJsonBaseline, toJsonContext, toJsonInventory } from './json.js';
import { cappedRows, escaped, omittedNote, paragraphs } from './markdown-common.js';
import { plural } from './text.js';

const MAX_CHANGES = 50;
const MAX_DELTAS = 10;
const MAX_PATH_LENGTH = 200;
const MAX_TEXT_LENGTH = 300;

const UNIT_NAMES: Readonly<Record<LimitUsage['unit'], string | undefined>> = {
  bytes: 'byte',
  chars: 'character',
  lines: 'line',
  hops: 'hop',
  levels: 'level',
  directories: 'directory',
  'context-fraction': undefined,
};

/** Escapes repository text for an output format, cut to `max` code points. */
export type Clean = (value: string, max: number) => string;

interface Location {
  readonly file: string;
  readonly name?: string;
}

/** Where each inventory item is declared, by id, with the name a reviewer looks for. */
function locations(result: ScanResult): Map<string, Location> {
  const map = new Map<string, Location>();
  const inventory = toJsonInventory(result.inventory);
  for (const item of inventory.mcpServers) map.set(item.id, { file: item.file, name: item.name });
  for (const item of inventory.hooks) map.set(item.id, { file: item.file, name: item.event });
  for (const item of [...inventory.permissions, ...inventory.env]) {
    map.set(item.id, { file: item.file });
  }
  return map;
}

/** `<kind>:<file>#<name>` read back when the inventory does not have the item. */
function locationFromId(hit: GateHit): Location {
  const rest = hit.id.slice(hit.id.indexOf(':') + 1);
  const hash = rest.indexOf('#');
  if (hash < 0) return { file: rest };
  const file = rest.slice(0, hash);
  const isServer = hit.class === 'mcp' || hit.class === 'mcp-unpinned';
  return isServer ? { file, name: rest.slice(hash + 1) } : { file };
}

function whereCell(hit: GateHit, result: ScanResult, known: Map<string, Location>): string {
  if (hit.class === 'unicode') {
    const finding = result.findings.find((entry) => entry.fingerprint === hit.id);
    return finding === undefined
      ? escaped(hit.id, MAX_PATH_LENGTH)
      : `${escaped(finding.path, MAX_PATH_LENGTH)}:${finding.range.start.line}`;
  }
  const location = known.get(hit.id) ?? locationFromId(hit);
  const file = escaped(location.file, MAX_PATH_LENGTH);
  return location.name === undefined
    ? file
    : `${file} › ${escaped(location.name, MAX_TEXT_LENGTH)}`;
}

function changesTable(result: ScanResult, diff: BaselineDiff, maxCharacters: number): string[] {
  if (diff.gate.classes.length === 0) return [];
  const changes = gateRows(diff);
  if (changes.length === 0) return ['**No security-relevant changes need review.**'];
  const known = locations(result);
  const { rows } = cappedRows(
    changes,
    (change) => {
      const label = change.emphasis ? `**${change.label}**` : change.label;
      const detail = escaped(change.hit.summary, MAX_TEXT_LENGTH);
      return `| ${label} | ${whereCell(change.hit, result, known)} | ${detail} |`;
    },
    MAX_CHANGES,
    maxCharacters,
  );
  const lines = [
    `**Needs review: ${plural(changes.length, 'security-relevant change')}**`,
    '',
    '| Change | Where | Detail |',
    '| :----- | :---- | :----- |',
    ...rows,
  ];
  const note = omittedNote(rows.length, changes.length, 'change');
  if (note.length > 0) lines.push('', ...note);
  return lines;
}

function findingsLine(result: ScanResult, diff: BaselineDiff): string {
  const marked = result.findings.filter((finding) => finding.baseline !== undefined);
  const fresh = marked.filter((finding) => finding.baseline === 'new' && !finding.suppressed);
  const count = (severity: string): number =>
    fresh.filter((finding) => finding.severity === severity).length;
  const parts = [
    count('error') > 0 ? plural(count('error'), 'new error') : '',
    count('warn') > 0 ? plural(count('warn'), 'new warning') : '',
    count('info') > 0 ? plural(count('info'), 'new info', 'new infos') : '',
  ].filter((part) => part !== '');
  if (parts.length === 0) {
    // Without per-finding marks, the diff's count is all there is.
    parts.push(
      marked.length === 0 && diff.findings.new > 0
        ? plural(diff.findings.new, 'new finding')
        : 'no new findings',
    );
  }
  parts.push(`${formatInteger(diff.findings.resolved.length)} resolved`);
  let line = `Findings: ${parts.join(', ')}.`;
  if (!diff.against.sameRuleset) {
    line +=
      ` The baseline was written with ruleset ${escaped(diff.against.ruleset, MAX_TEXT_LENGTH)},` +
      ' so findings from rules it did not run count as new.';
    const fromNewRules = newRuleFindings(result);
    if (fromNewRules > 0) {
      line += ` ${plural(fromNewRules, 'new finding comes', 'new findings come')} from rules added since then, marked "new rule".`;
    }
  }
  return line;
}

function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end--;
  return path.slice(0, end);
}

function signed(value: number): string {
  return value > 0 ? `+${formatInteger(value)}` : formatInteger(value);
}

/** Units of the current plans' limits, keyed by agent, cwd, key and subject. */
function limitUnits(result: ScanResult): Map<string, LimitUsage['unit']> {
  const units = new Map<string, LimitUsage['unit']>();
  if (result.context === undefined) return units;
  for (const plan of toJsonContext(result.context).plans) {
    for (const limit of plan.limits) {
      units.set([plan.agent, plan.cwd, limit.key, limit.subject].join('\n'), limit.unit);
    }
  }
  return units;
}

function limitChanges(
  delta: PlanDelta,
  units: Map<string, LimitUsage['unit']>,
  clean: Clean,
): string[] {
  const changes: string[] = [];
  for (const limit of delta.limits) {
    const { before, after } = limit;
    if (limit.limit === null || after === null) continue;
    const over = after > limit.limit;
    const wasOver = before !== null && before > limit.limit;
    if (over === wasOver) continue;
    const unit = units.get([delta.agent, delta.cwd, limit.key, limit.subject].join('\n'));
    // A group's label (`AGENTS.md chain`), else the file's path, else the limit's key.
    const what =
      limit.label !== undefined
        ? clean(limit.label, MAX_TEXT_LENGTH)
        : limit.subject !== ''
          ? clean(limit.subject, MAX_PATH_LENGTH)
          : clean(limit.key, MAX_TEXT_LENGTH);
    const unitName = unit === undefined ? undefined : UNIT_NAMES[unit];
    const bound =
      unitName === undefined
        ? `the limit of ${formatInteger(limit.limit)}`
        : `the ${formatInteger(limit.limit)}-${unitName} limit`;
    const from = before === null ? '' : `${formatInteger(before)} → `;
    const amount = `${from}${formatInteger(after)}${unit === undefined ? '' : ` ${unit}`}`;
    changes.push(`${what} ${amount}, ${over ? 'now over' : 'back under'} ${bound}`);
  }
  return changes;
}

/**
 * The change in session-start context, one part per plan present in both reports (at most
 * MAX_DELTAS): tokens before and after, and limits crossed, plus how many plans were left out.
 * Undefined when no plan is in both. `clean` escapes repository text for the output format, so
 * the terminal renderer (baseline-text.ts) shares this.
 */
export function contextDeltas(
  result: ScanResult,
  diff: BaselineDiff,
  clean: Clean,
): { readonly parts: readonly string[]; readonly hidden: number } | undefined {
  if (diff.context.length === 0) return undefined;
  const units = limitUnits(result);
  const base = stripTrailingSlashes(result.pathBase ?? '');
  const parts = diff.context.slice(0, MAX_DELTAS).map((delta) => {
    // After a rebase the root plan's cwd is pathBase; other plans show their rebased path.
    const root = delta.cwd === '' || delta.cwd === base;
    const where = root ? '' : ` (${clean(delta.cwd, MAX_PATH_LENGTH)})`;
    const name = `${AGENT_NAMES[delta.agent]}${where}`;
    const { before, after } = delta.startupTokens;
    const tokens =
      before === after
        ? `${name} unchanged`
        : `${name} ≈${formatInteger(before)} → ≈${formatInteger(after)} tokens (${signed(after - before)})`;
    return [tokens, ...limitChanges(delta, units, clean)].join(', ');
  });
  return { parts, hidden: Math.max(0, diff.context.length - MAX_DELTAS) };
}

function contextLine(result: ScanResult, diff: BaselineDiff): string | undefined {
  const deltas = contextDeltas(result, diff, escaped);
  if (deltas === undefined) return undefined;
  const more = deltas.hidden > 0 ? ` · and ${plural(deltas.hidden, 'more plan')}` : '';
  return `Session-start context: ${deltas.parts.join(' · ')}${more}`;
}

/**
 * The baseline section of the Markdown report, or no lines when the scan has no baseline. The
 * table of changes stops at `maxCharacters`.
 */
export function baselineSummary(result: ScanResult, maxCharacters: number): string[] {
  if (result.baseline === undefined) return [];
  const diff = toJsonBaseline(result.baseline);
  const blocks: string[][] = [['### Agent configuration changes']];
  const changes = changesTable(result, diff, maxCharacters);
  if (changes.length > 0) blocks.push(changes);
  const context = contextLine(result, diff);
  blocks.push(
    paragraphs([findingsLine(result, diff), ...(context === undefined ? [] : [context])]),
  );
  return blocks.flatMap((block, index) => (index === 0 ? block : ['', ...block]));
}

/** Character budget for the table of changes in {@link formatBaselineMarkdown}. */
const MAX_STANDALONE_CHARACTERS = 50_000;

/**
 * The baseline section on its own, for output without a findings table, such as
 * `agentcheckup context --format markdown`. Paths are relative to the scanned directory, as in
 * the context output it follows (see contextView). Ends with a newline; empty without a
 * baseline.
 */
export function formatBaselineMarkdown(result: ScanResult): string {
  const lines = baselineSummary(stripPathBase(result), MAX_STANDALONE_CHARACTERS);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
