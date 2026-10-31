/**
 * Turns a drift report into GitHub issues: one per changed source, one per moved source, and one
 * listing the unreachable sources. Used by .github/workflows/source-drift.yml through sync-issues.ts.
 *
 * Re-runs never duplicate an issue. Each issue body carries a marker comment, and existing issues
 * are found among the open issues with the `source-drift` label. Only people with triage access
 * can add labels, so nobody else can open an issue that suppresses or hijacks a report.
 *
 * `gh` is injected: tests pass a fake, the workflow passes the real CLI.
 */
import { compareStrings } from '../../src/core/compare.js';
import { ruleDocsUrl } from '../../src/core/meta.js';
import { forMarkdown } from '../../src/report/sanitize.js';
import type { ChangedSource, DriftReport, MovedSource, UnreachableSource } from './baseline.js';
import { sha256 } from './normalize.js';
import { gitHubHistoryUrl, parseGitHubBlobUrl } from './resolve.js';

export const LABEL = 'source-drift';
const LABEL_COLOR = 'd93f0b';
const LABEL_DESCRIPTION = 'A source cited by a rule changed, moved or cannot be fetched';
const MARKER = 'agentcheckup-source-drift';
/** GitHub accepts up to 65,536 characters in an issue body. */
const MAX_BODY = 60_000;

/** Runs `gh` with these arguments and returns its standard output. */
export type RunGh = (args: readonly string[]) => Promise<string>;

export interface IssueContext {
  /** Link to the workflow run, when known. */
  readonly runUrl?: string | undefined;
}

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

/** Characters that are safe in a Markdown link target and inside an HTML comment. */
const SAFE_URL = /^https:\/\/[\w.~:/?#[\]@!$&*+,;=%-]+$/;
const SAFE_RULE_ID = /^[a-z\d]+(?:-[a-z\d]+)*\/[a-z\d]+(?:-[a-z\d]+)*$/;
const HEX = /^[\da-f]{64}$/;

function isSafeUrl(url: string): boolean {
  return SAFE_URL.test(url) && !url.includes('--') && URL.canParse(url);
}

/** A link whose text and target cannot inject Markdown or HTML. */
function link(text: string, url: string): string {
  return isSafeUrl(url) ? `[${forMarkdown(text)}](${url})` : forMarkdown(text);
}

function ruleLink(id: string): string {
  return SAFE_RULE_ID.test(id) ? `[\`${id}\`](${ruleDocsUrl(id)})` : forMarkdown(id);
}

function ruleCode(id: string): string {
  return SAFE_RULE_ID.test(id) ? `\`${id}\`` : forMarkdown(id);
}

function hashCode(hash: string): string {
  return HEX.test(hash) ? `\`${hash}\`` : forMarkdown(hash);
}

/** Identifies the issue for a URL. Unusual URLs are identified by their hash. */
function urlKey(url: string): string {
  return isSafeUrl(url) ? `url=${url}` : `url-sha256=${sha256(url)}`;
}

function changedMarkerPrefix(url: string): string {
  return `<!-- ${MARKER} ${urlKey(url)} hash=`;
}

/** A moved source's marker ends with the SHA-256 of its new location, which may be any URL. */
function movedMarkerPrefix(url: string): string {
  return `<!-- ${MARKER} moved ${urlKey(url)} to-sha256=`;
}

const UNREACHABLE_MARKER_PREFIX = `<!-- ${MARKER} unreachable set=`;

/** The value after `prefix` up to ` -->` on the same line, if the body has the marker. */
function markerValue(body: string, prefix: string): string | undefined {
  const start = body.indexOf(prefix);
  if (start < 0) return undefined;
  const from = start + prefix.length;
  const end = body.indexOf(' -->', from);
  const value = end < 0 ? undefined : body.slice(from, end);
  return value === undefined || value.includes('\n') ? undefined : value;
}

function runLine(context: IssueContext): string[] {
  const url = context.runUrl;
  return url === undefined || !isSafeUrl(url) ? [] : [`- Found by: [workflow run](${url})`];
}

const WHAT_TO_DO_CHANGED = (url: string): string[] => [
  '## What to do',
  '',
  '1. Re-read the source and compare it with what each rule above says: its message, rationale and tests. For "context loaders", compare it with the load plans in `src/platforms/load` and the inventory in `src/inventory` that cite it from `src/platforms/sources.ts`.',
  "2. If the behavior changed, update the rule and its tests, then run `pnpm docs:generate`. If it did not, bump the `checked` date of this source in the rule's metadata.",
  `3. In the same pull request, run \`pnpm drift:update --only ${isSafeUrl(url) ? url : '<url>'}\` and commit \`scripts/drift/baseline.json\`.`,
  '4. Reference this issue in the pull request so that merging it closes the issue.',
];

export function changedIssueTitle(url: string): string {
  return `Source changed: ${url}`;
}

export function changedIssueBody(source: ChangedSource, context: IssueContext = {}): string {
  const blob = parseGitHubBlobUrl(source.url);
  const previous =
    source.previous === null
      ? 'none, the URL is not in the baseline yet'
      : hashCode(source.previous);
  return [
    `${changedMarkerPrefix(source.url)}${HEX.test(source.current) ? source.current : 'invalid'} -->`,
    'A source cited by agentcheckup rules or context loaders changed since its hash was recorded in `scripts/drift/baseline.json`.',
    '',
    `- Source: ${link(source.url, source.url)}`,
    ...(blob === undefined ? [] : [`- Commit history: ${link('commits', gitHubHistoryUrl(blob))}`]),
    `- Baseline hash: ${previous}`,
    `- Current hash: ${hashCode(source.current)}`,
    ...runLine(context),
    '',
    '## Used by',
    '',
    ...source.rules.map((id) => `- ${ruleLink(id)}`),
    '',
    ...WHAT_TO_DO_CHANGED(source.url),
    '',
    'The Source drift workflow opened this issue. It comments here if the source changes again before the baseline is updated.',
    '',
  ].join('\n');
}

export function movedIssueTitle(url: string): string {
  return `Source moved: ${url}`;
}

function contentLine(source: MovedSource): string {
  if (source.previous === null) return 'not in the baseline yet';
  if (source.previous === source.current) return 'unchanged since the baseline';
  return `changed since the baseline (${hashCode(source.previous)}, now ${hashCode(source.current)})`;
}

export function movedIssueBody(source: MovedSource, context: IssueContext = {}): string {
  return [
    `${movedMarkerPrefix(source.url)}${sha256(source.location)} -->`,
    'A source cited by agentcheckup rules or context loaders redirects to another URL. The Source drift workflow follows redirects, so it reports the move instead of a change of content.',
    '',
    `- Source: ${link(source.url, source.url)}`,
    `- Now at: ${link(source.location, source.location)}`,
    `- Content: ${contentLine(source)}`,
    ...runLine(context),
    '',
    '## Used by',
    '',
    ...source.rules.map((id) => `- ${ruleLink(id)}`),
    '',
    '## What to do',
    '',
    '1. Open the new location and check that it is the same document, and that it still says what each rule above relies on. A redirect to a general page, a login or another product usually means the cited content is gone.',
    '2. Replace the URL in the `meta.sources` of each rule above, or in `src/platforms/sources.ts` for "context loaders", and bump its `checked` date. If the content changed, update the rules and their tests as for a changed source.',
    '3. In the same pull request, run `pnpm drift:update --only <new url>` and commit `scripts/drift/baseline.json`. A later `pnpm drift:update` drops the old URL.',
    '4. Reference this issue in the pull request so that merging it closes the issue.',
    '',
    'The Source drift workflow opened this issue. It comments here if the source moves again before the URL is updated.',
    '',
  ].join('\n');
}

export const UNREACHABLE_TITLE = 'Cited sources cannot be fetched';

function unreachableSetHash(sources: readonly UnreachableSource[]): string {
  return sha256(
    sources
      .map((source) => source.url)
      .sort(compareStrings)
      .join('\n'),
  );
}

export function unreachableIssueBody(
  sources: readonly UnreachableSource[],
  context: IssueContext = {},
): string {
  const head = [
    `${UNREACHABLE_MARKER_PREFIX}${unreachableSetHash(sources)} -->`,
    'The Source drift workflow could not fetch these cited sources. Timeouts, network errors and server errors get up to three attempts.',
    ...(runLine(context).length > 0 ? ['', ...runLine(context)] : []),
    '',
    '| Source | Reason | Rules |',
    '| --- | --- | --- |',
  ];
  const tail = [
    '',
    '## What to do',
    '',
    '- A temporary outage needs nothing. The next run updates this issue and closes it when every source can be fetched again.',
    "- If a page moved or was removed, find its new location, re-read it, and update the URL in the rules' sources. Then run `pnpm drift:update --only <new url>` and commit `scripts/drift/baseline.json` in the same pull request.",
    '',
  ];
  const rows: string[] = [];
  let size = head.join('\n').length + tail.join('\n').length;
  for (const [index, source] of sources.entries()) {
    const row = `| ${link(source.url, source.url)} | ${forMarkdown(source.reason)} | ${source.rules.map(ruleCode).join(', ')} |`;
    if (size + row.length + 200 > MAX_BODY) {
      rows.push('', `${sources.length - index} more not shown.`);
      break;
    }
    rows.push(row);
    size += row.length + 1;
  }
  return [...head, ...rows, ...tail].join('\n');
}

function sourceCount(count: number): string {
  return `${count} unreachable source${count === 1 ? '' : 's'}`;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, '\n').trim();
}

function parseIssues(json: string): Issue[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) throw new Error('gh issue list did not return an array');
  return raw.map((item: unknown) => {
    const { number, title, body } = (item ?? {}) as Record<string, unknown>;
    if (typeof number !== 'number' || typeof title !== 'string' || typeof body !== 'string') {
      throw new Error('gh issue list returned an unexpected issue');
    }
    return { number, title, body };
  });
}

async function ensureLabel(gh: RunGh): Promise<string[]> {
  const labels: unknown = JSON.parse(
    await gh(['label', 'list', '--limit', '1000', '--json', 'name']),
  );
  const exists =
    Array.isArray(labels) &&
    labels.some((label: unknown) => (label as { name?: unknown } | null)?.name === LABEL);
  if (exists) return [];
  await gh(['label', 'create', LABEL, '--color', LABEL_COLOR, '--description', LABEL_DESCRIPTION]);
  return [`created label ${LABEL}`];
}

async function syncChanged(
  gh: RunGh,
  source: ChangedSource,
  open: readonly Issue[],
  context: IssueContext,
): Promise<string> {
  const prefix = changedMarkerPrefix(source.url);
  const existing = open.find((issue) => issue.body.includes(prefix));
  const body = changedIssueBody(source, context);
  if (existing === undefined) {
    await gh([
      'issue',
      'create',
      '--title',
      changedIssueTitle(source.url),
      '--body',
      body,
      '--label',
      LABEL,
    ]);
    return `opened an issue for ${source.url}`;
  }
  const number = String(existing.number);
  const reported = markerValue(existing.body, prefix);
  if (reported === source.current) return `#${number} already reports ${source.url}`;
  await gh(['issue', 'edit', number, '--body', body]);
  const was = reported !== undefined && HEX.test(reported) ? ` (it was \`${reported}\`)` : '';
  await gh([
    'issue',
    'comment',
    number,
    '--body',
    `The source changed again. Its current hash is ${hashCode(source.current)}${was}. The description is updated.`,
  ]);
  return `updated #${number} for ${source.url}`;
}

async function syncMoved(
  gh: RunGh,
  source: MovedSource,
  open: readonly Issue[],
  context: IssueContext,
): Promise<string> {
  const prefix = movedMarkerPrefix(source.url);
  const existing = open.find((issue) => issue.body.includes(prefix));
  const body = movedIssueBody(source, context);
  if (existing === undefined) {
    await gh([
      'issue',
      'create',
      '--title',
      movedIssueTitle(source.url),
      '--body',
      body,
      '--label',
      LABEL,
    ]);
    return `opened an issue for ${source.url}, which moved`;
  }
  const number = String(existing.number);
  if (markerValue(existing.body, prefix) === sha256(source.location)) {
    return `#${number} already reports that ${source.url} moved`;
  }
  await gh(['issue', 'edit', number, '--body', body]);
  await gh([
    'issue',
    'comment',
    number,
    '--body',
    'The source redirects to another location now. The description is updated.',
  ]);
  return `updated #${number} for ${source.url}, which moved again`;
}

async function syncUnreachable(
  gh: RunGh,
  sources: readonly UnreachableSource[],
  open: readonly Issue[],
  context: IssueContext,
): Promise<string | undefined> {
  const existing = open.find((issue) => issue.body.includes(UNREACHABLE_MARKER_PREFIX));
  if (sources.length === 0) {
    if (existing === undefined) return undefined;
    const run = context.runUrl !== undefined && isSafeUrl(context.runUrl);
    await gh([
      'issue',
      'close',
      String(existing.number),
      '--comment',
      `Every cited source could be fetched${run ? ` in [this run](${context.runUrl ?? ''})` : ''}.`,
    ]);
    return `closed #${String(existing.number)}: every source can be fetched`;
  }
  const body = unreachableIssueBody(sources, context);
  if (existing === undefined) {
    await gh(['issue', 'create', '--title', UNREACHABLE_TITLE, '--body', body, '--label', LABEL]);
    return `opened an issue for ${sourceCount(sources.length)}`;
  }
  const number = String(existing.number);
  if (normalizeBody(existing.body) === normalizeBody(body)) {
    return `#${number} already lists the unreachable sources`;
  }
  await gh(['issue', 'edit', number, '--body', body]);
  const before = markerValue(existing.body, UNREACHABLE_MARKER_PREFIX);
  if (before !== unreachableSetHash(sources)) {
    await gh([
      'issue',
      'comment',
      number,
      '--body',
      `The list of sources that cannot be fetched changed. It has ${sourceCount(sources.length)} now.`,
    ]);
  }
  return `updated #${number} for ${sourceCount(sources.length)}`;
}

/** Opens, updates or closes issues to match the report. Returns what it did, for the log. */
export async function syncIssues(
  report: DriftReport,
  gh: RunGh,
  context: IssueContext = {},
): Promise<string[]> {
  const log = await ensureLabel(gh);
  const open = parseIssues(
    await gh([
      'issue',
      'list',
      '--label',
      LABEL,
      '--state',
      'open',
      '--limit',
      '1000',
      '--json',
      'number,title,body',
    ]),
  );
  for (const source of report.changed) log.push(await syncChanged(gh, source, open, context));
  for (const source of report.moved) log.push(await syncMoved(gh, source, open, context));
  const unreachable = await syncUnreachable(gh, report.unreachable, open, context);
  if (unreachable !== undefined) log.push(unreachable);
  return log;
}
