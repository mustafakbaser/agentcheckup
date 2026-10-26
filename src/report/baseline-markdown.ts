/**
 * The pull request summary of a scan with `--baseline`: changes that need review (gate hits:
 * security-relevant changes and, with `--gate models`, model changes), new and resolved
 * findings, and a table of session-start context per agent before and after the change. Part of
 * the Markdown report (markdown.ts), which gives it a character budget so the whole comment stays
 * under GitHub's limit. What the change makes each
 * agent miss is the Markdown report's impact table (markdown.ts), which lists only the skips the
 * change adds when the comparison has plan deltas.
 *
 * Gate hit summaries, ids, paths, limit labels and the baseline's ruleset come from repositories
 * or from a baseline file: all of it goes through `forMarkdown`.
 */
import type { BaselineDiff, GateHit, PlanDelta } from '../core/baseline-types.js';
import { compareStrings } from '../core/compare.js';
import type { ScanResult } from '../core/engine.js';
import { formatInteger } from '../core/format.js';
import { stripPathBase } from '../core/rebase.js';
import type { LimitUsage, LoadEntry, LoadPlan } from '../platforms/load/types.js';
import { AGENT_NAMES } from './context-view.js';
import { gateChangeCount, gateRows, newRuleFindings, noGateChanges } from './gate.js';
import { toJsonBaseline, toJsonContext, toJsonInventory } from './json.js';
import { cappedRows, escaped, omittedNote } from './markdown-common.js';
import { plural } from './text.js';

const MAX_CHANGES = 50;
const MAX_DELTAS = 10;
const MAX_PATH_LENGTH = 200;
const MAX_TEXT_LENGTH = 300;
/** Directories and limit names in the context table are cut here, so rows stay readable. */
const MAX_CELL_LENGTH = 80;
/** Limits per row of the context table before `and N more`. */
const MAX_LIMITS = 3;

const UNIT_NAMES: Readonly<Record<LimitUsage['unit'], string | undefined>> = {
  bytes: 'byte',
  chars: 'character',
  lines: 'line',
  hops: 'hop',
  levels: 'level',
  directories: 'directory',
  'context-fraction': undefined,
};

/** Units after an amount: `33,010 of 32,768 bytes`. */
const UNIT_PLURALS: Readonly<Record<LimitUsage['unit'], string | undefined>> = {
  bytes: 'bytes',
  chars: 'characters',
  lines: 'lines',
  hops: 'hops',
  levels: 'levels',
  directories: 'directories',
  'context-fraction': undefined,
};

/**
 * Roles whose startup entries are not files the agent reads into the prompt: MCP servers and
 * hooks start a process, and a skill adds only its line in the skills listing.
 */
const NOT_FILES: ReadonlySet<string> = new Set(['mcp-server', 'hook', 'skill']);

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
  for (const item of result.agents?.definitions ?? []) {
    map.set(item.id, { file: item.file, ...(item.name === undefined ? {} : { name: item.name }) });
  }
  for (const item of result.agents?.settings ?? [])
    map.set(item.id, { file: item.file, name: item.key });
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
  if (changes.length === 0) return [`**${noGateChanges(diff.gate.classes)}.**`];
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
    `**Needs review: ${gateChangeCount(changes)}**`,
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
 * The change in session-start context for the terminal summary (baseline-text.ts), one plan per
 * part (at most MAX_DELTAS plans): `changed` holds the plans whose tokens or limits changed, with
 * tokens before and after and the limits crossed; `unchanged` names the others, so nine agents
 * whose context did not move take one line. `hidden` counts the plans left out. Undefined when
 * no plan is in both reports. `clean` escapes repository text for the output format. The
 * Markdown summary shows the same comparison as a table (contextTable).
 */
export function contextDeltas(
  result: ScanResult,
  diff: BaselineDiff,
  clean: Clean,
):
  | {
      readonly changed: readonly string[];
      readonly unchanged: readonly string[];
      readonly hidden: number;
    }
  | undefined {
  if (diff.context.length === 0) return undefined;
  const units = limitUnits(result);
  const base = stripTrailingSlashes(result.pathBase ?? '');
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const delta of diff.context.slice(0, MAX_DELTAS)) {
    // After a rebase the root plan's cwd is pathBase; other plans show their rebased path.
    const root = delta.cwd === '' || delta.cwd === base;
    const where = root ? '' : ` (${clean(delta.cwd, MAX_PATH_LENGTH)})`;
    const name = `${AGENT_NAMES[delta.agent]}${where}`;
    const { before, after } = delta.startupTokens;
    const limits = limitChanges(delta, units, clean);
    if (before === after && limits.length === 0) {
      unchanged.push(name);
      continue;
    }
    const tokens =
      before === after
        ? `${name} unchanged`
        : `${name} ≈${formatInteger(before)} → ≈${formatInteger(after)} tokens (${signed(after - before)})`;
    changed.push([tokens, ...limits].join(', '));
  }
  return { changed, unchanged, hidden: Math.max(0, diff.context.length - MAX_DELTAS) };
}

// ---------------------------------------------------------------------------------------------
// Session-start context table
// ---------------------------------------------------------------------------------------------

/** A map key for two strings: a plan's agent and directory, or a limit's key and subject. */
function pairKey(first: string, second: string): string {
  return `${first}\u0000${second}`;
}

/** The current scan's plans by agent and directory, in the same path space as the deltas. */
function plansByKey(result: ScanResult): Map<string, LoadPlan> {
  const plans = new Map<string, LoadPlan>();
  for (const plan of result.context?.plans ?? []) {
    const key = pairKey(plan.agent, plan.cwd);
    if (!plans.has(key)) plans.set(key, plan);
  }
  return plans;
}

function isStartupFile(entry: Pick<LoadEntry, 'role' | 'trigger'>): boolean {
  return entry.trigger === 'startup' && !NOT_FILES.has(entry.role);
}

/** The role of a plan entry id, `<role>:<path>…`. */
function roleOf(id: string): string {
  const colon = id.indexOf(':');
  return colon < 0 ? '' : id.slice(0, colon);
}

interface FileCounts {
  readonly before?: number;
  readonly after?: number;
}

/**
 * Files the agent reads into the prompt at session start, after the change from the current
 * plan, before it from the plan's entry changes: a startup file that is neither new nor moved
 * to startup was there before. The comparison does not keep the baseline's entries, so the count
 * before is left out when a removed entry, or one whose trigger changed away from startup, may
 * have been a startup file. Both are left out without the current plan.
 */
function fileCounts(delta: PlanDelta, plan: LoadPlan | undefined): FileCounts {
  if (plan === undefined) return {};
  const startup = new Set(plan.entries.filter(isStartupFile).map((entry) => entry.id));
  const added = new Set(delta.entries.added);
  const moved = delta.entries.changed
    .filter((change) => change.fields.includes('trigger'))
    .map((change) => change.id);
  const movedSet = new Set(moved);
  const unknown = [...delta.entries.removed, ...moved.filter((id) => !startup.has(id))].some(
    (id) => !NOT_FILES.has(roleOf(id)),
  );
  if (unknown) return { after: startup.size };
  let before = 0;
  for (const id of startup) if (!added.has(id) && !movedSet.has(id)) before++;
  return { before, after: startup.size };
}

function filesText(count: number): string {
  return `${formatInteger(count)} ${count === 1 ? 'file' : 'files'}`;
}

/** `≈1,977 tokens, 3 files`, or only the tokens when the file count is not known. */
function sizeCell(tokens: number, files: number | undefined): string {
  const text = `≈${formatInteger(tokens)} tokens`;
  return files === undefined ? text : `${text}, ${filesText(files)}`;
}

/** `≈+720 tokens, +1 file`; `unchanged` when nothing that can be told changed. */
function changeCell(tokens: PlanDelta['startupTokens'], files: FileCounts): string {
  const parts: string[] = [];
  if (tokens.after !== tokens.before) parts.push(`≈${signed(tokens.after - tokens.before)} tokens`);
  if (files.before !== undefined && files.after !== undefined && files.after !== files.before) {
    const change = files.after - files.before;
    parts.push(`${signed(change)} ${Math.abs(change) === 1 ? 'file' : 'files'}`);
  }
  if (parts.length > 0) return parts.join(', ');
  // Same tokens, but the files before cannot be told: do not claim that nothing changed.
  return files.before === undefined && files.after !== undefined ? '≈0 tokens' : 'unchanged';
}

interface LimitItem {
  readonly key: string;
  readonly subject: string;
  readonly label?: string;
  readonly used: number;
  readonly limit: number;
  readonly unit?: LimitUsage['unit'];
  /** Set when the change took the usage over the limit or back under it. */
  readonly crossed?: 'over' | 'under';
}

/**
 * The limits to show for a plan: every limit the change crossed, then the current plan's limits
 * on a group of files (the AGENTS.md chain, the skills listing), which bound what the agent puts
 * in the prompt at session start, the fullest first. Limits on one file are left to the
 * findings unless crossed.
 */
function limitItems(delta: PlanDelta, plan: LoadPlan | undefined): LimitItem[] {
  const usages = new Map<string, LimitUsage>();
  for (const usage of plan?.limits ?? []) {
    const key = pairKey(usage.key, usage.subject);
    if (!usages.has(key)) usages.set(key, usage);
  }
  const crossed: LimitItem[] = [];
  for (const limit of delta.limits) {
    const { before, after } = limit;
    if (limit.limit === null || after === null) continue;
    const over = after > limit.limit;
    if (over === (before !== null && before > limit.limit)) continue;
    const unit = usages.get(pairKey(limit.key, limit.subject))?.unit;
    crossed.push({
      key: limit.key,
      subject: limit.subject,
      ...(limit.label === undefined ? {} : { label: limit.label }),
      used: after,
      limit: limit.limit,
      ...(unit === undefined ? {} : { unit }),
      crossed: over ? 'over' : 'under',
    });
  }
  const shown = new Set(crossed.map((item) => pairKey(item.key, item.subject)));
  const groups: LimitItem[] = [];
  for (const [key, usage] of usages) {
    if (shown.has(key) || usage.label === undefined) continue;
    if (usage.limit === null || usage.limit <= 0 || usage.used <= 0) continue;
    groups.push({
      key: usage.key,
      subject: usage.subject,
      label: usage.label,
      used: usage.used,
      limit: usage.limit,
      unit: usage.unit,
    });
  }
  const order = (a: LimitItem, b: LimitItem): number =>
    compareStrings(a.key, b.key) || compareStrings(a.subject, b.subject);
  // Groups closest to their limit first; integer cross products compare the shares exactly.
  const fullest = (a: LimitItem, b: LimitItem): number =>
    b.used * a.limit - a.used * b.limit || order(a, b);
  return [...crossed.sort(order), ...groups.sort(fullest)];
}

/**
 * `101%`, rounded, except that rounding never hides which side of the limit a usage is on: over
 * it reads at least 101%, under it at most 99%, and a small usage reads `under 1%`.
 */
function shareText(used: number, limit: number): string {
  const percent = Math.round((used * 100) / limit);
  if (used > limit) return `${formatInteger(Math.max(101, percent))}%`;
  if (used < limit && percent >= 100) return '99%';
  if (used > 0 && percent < 1) return 'under 1%';
  return `${formatInteger(percent)}%`;
}

/** `AGENTS.md chain 33,010 of 32,768 bytes (101%), now over`, in bold when over the limit. */
function limitText(item: LimitItem): string {
  // A group's label (`AGENTS.md chain`), else the file's path, else the limit's key.
  const what = escaped(
    item.label ?? (item.subject === '' ? item.key : item.subject),
    MAX_CELL_LENGTH,
  );
  const unit = item.unit === undefined ? undefined : UNIT_PLURALS[item.unit];
  const amount = `${formatInteger(item.used)} of ${formatInteger(item.limit)}`;
  const share = item.limit > 0 ? ` (${shareText(item.used, item.limit)})` : '';
  const crossed =
    item.crossed === undefined ? '' : item.crossed === 'over' ? ', now over' : ', back under';
  const text = `${what} ${amount}${unit === undefined ? '' : ` ${unit}`}${share}${crossed}`;
  return item.used > item.limit ? `**${text}**` : text;
}

function limitsCell(delta: PlanDelta, plan: LoadPlan | undefined): string {
  const items = limitItems(delta, plan);
  if (items.length === 0) return '—';
  const texts = items.slice(0, MAX_LIMITS).map(limitText);
  if (items.length > MAX_LIMITS) texts.push(`and ${formatInteger(items.length - MAX_LIMITS)} more`);
  return texts.join(' · ');
}

function contextRow(delta: PlanDelta, plan: LoadPlan | undefined, base: string): string {
  // After a rebase the root plan's cwd is pathBase; other plans show their rebased path.
  const root = delta.cwd === '' || delta.cwd === base;
  const where = root ? '' : ` (${escaped(delta.cwd, MAX_CELL_LENGTH)})`;
  const files = fileCounts(delta, plan);
  const { before, after } = delta.startupTokens;
  const cells = [
    `${AGENT_NAMES[delta.agent]}${where}`,
    sizeCell(before, files.before),
    sizeCell(after, files.after),
    changeCell(delta.startupTokens, files),
    limitsCell(delta, plan),
  ];
  return `| ${cells.join(' | ')} |`;
}

/**
 * Session-start context per plan present in both reports, in canonical plan order: estimated
 * tokens and files before and after the change, the signed change, and how much of each limit
 * on session-start context the plan uses. At most MAX_DELTAS rows and `maxCharacters`. No lines
 * when no plan is in both reports.
 */
function contextTable(result: ScanResult, diff: BaselineDiff, maxCharacters: number): string[] {
  if (diff.context.length === 0) return [];
  const plans = plansByKey(result);
  const base = stripTrailingSlashes(result.pathBase ?? '');
  const { rows } = cappedRows(
    diff.context,
    (delta) => contextRow(delta, plans.get(pairKey(delta.agent, delta.cwd)), base),
    MAX_DELTAS,
    maxCharacters,
  );
  const note = omittedNote(rows.length, diff.context.length, 'plan');
  return [
    '**Session-start context**',
    '',
    '| Agent | Before | After | Change | Limits |',
    '| :---- | -----: | ----: | -----: | :----- |',
    ...rows,
    ...(note.length > 0 ? ['', ...note] : []),
  ];
}

/**
 * The baseline section of the Markdown report, or no lines when the scan has no baseline. The
 * table of changes and the table of session-start context each stop at `maxCharacters`.
 */
export function baselineSummary(result: ScanResult, maxCharacters: number): string[] {
  if (result.baseline === undefined) return [];
  const diff = toJsonBaseline(result.baseline);
  const blocks: string[][] = [['### Agent configuration changes']];
  const changes = changesTable(result, diff, maxCharacters);
  if (changes.length > 0) blocks.push(changes);
  blocks.push([findingsLine(result, diff)]);
  const context = contextTable(result, diff, maxCharacters);
  if (context.length > 0) blocks.push(context);
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
