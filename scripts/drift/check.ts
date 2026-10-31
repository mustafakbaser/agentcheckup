/**
 * Checks the sources cited by agentcheckup's rules and context loaders for changes.
 *
 *   pnpm drift:check [--format text|json] [--report <file>] [--only <url>]...
 *   pnpm drift:update [--only <url>]...
 *   pnpm drift:diff <url>
 *
 * Fetches every URL in the built-in rules' `meta.sources` and in src/platforms/sources.ts (the
 * sources load plans and the inventory cite by key), normalizes and hashes the content, and
 * compares the hashes with scripts/drift/baseline.json. Exit code 0: nothing changed.
 * 1: a source changed, moved, is new, or could not be fetched. 2: usage error or unreadable
 * baseline.
 *
 * `--update` writes the current hashes to the baseline instead. Use it after re-reading the
 * changed sources and updating the rules or their `checked` dates; this script never edits
 * rules. `--only` limits the check or the update to the given URLs, so an update accepts only
 * the sources you re-read. Set GITHUB_TOKEN to read github.com files through the REST API.
 *
 * Both keep the normalized text of every source they fetch in .drift-cache/ (gitignored, see
 * cache.ts). `--diff <url>` fetches one source and prints the unified diff from the cached text
 * with the baseline's hash, or the newest other cached text, to the current one.
 *
 * See docs/maintainers/source-drift.md.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { DIRECTIVE_RULES } from '../../src/core/directive-rules.js';
import { SOURCES } from '../../src/platforms/sources.js';
import { forTerminal } from '../../src/report/sanitize.js';
import { builtinRules } from '../../src/rules/index.js';
import {
  type Baseline,
  compareWithBaseline,
  needsAttention,
  parseBaseline,
  serializeBaseline,
  updateBaseline,
} from './baseline.js';
import { cachedText, cachedVersions, cacheText } from './cache.js';
import { formatTextDiff } from './diff.js';
import { DEFAULT_FETCH_OPTIONS, hashSources, type Outcome } from './fetch.js';
import { formatJson, formatText } from './report.js';
import { buildSourceIndex, type SourceIndex, splitOwnSources } from './sources.js';

const BASELINE_FILE = fileURLToPath(new URL('baseline.json', import.meta.url));
const CACHE = fileURLToPath(new URL('../../.drift-cache/', import.meta.url));
const CONCURRENCY = 6;

const USAGE = `Usage:
  pnpm drift:check [--format text|json] [--report <file>] [--only <url>]...
  pnpm drift:update [--only <url>]...
  pnpm drift:diff <url>

Options:
  --format <text|json>  Output format on stdout (default: text)
  --report <file>       Also write the JSON report to <file>
  --only <url>          Check or update only this cited URL; repeatable
  --update              Write the current hashes to scripts/drift/baseline.json
  --diff <url>          Print what changed in the text of one cited URL, from the cached
                        text with the baseline's hash to the current text
  --help                Show this help
`;

function stderr(message: string): void {
  process.stderr.write(`${forTerminal(message, { multiline: true })}\n`);
}

function usageError(message: string): number {
  stderr(`${message}\n\n${USAGE}`);
  return 2;
}

async function readBaseline(): Promise<Baseline> {
  let text: string;
  try {
    text = await readFile(BASELINE_FILE, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Map();
    throw error;
  }
  return parseBaseline(text);
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.tmp-${String(process.pid)}`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, file);
}

/**
 * Keeps the text of every fetched source in .drift-cache/. A cache that cannot be written costs
 * the diffs, not the check.
 */
async function cacheOutcomes(outcomes: ReadonlyMap<string, Outcome>): Promise<void> {
  try {
    for (const [url, outcome] of outcomes) {
      if (outcome.ok) await cacheText(CACHE, url, outcome.text);
    }
  } catch (error) {
    stderr(
      `Cannot write ${CACHE}: ${error instanceof Error ? error.message : String(error)}. Continuing without it.`,
    );
  }
}

function short(hash: string): string {
  return hash.slice(0, 12);
}

/** `--diff <url>`: the change in one source's text, from the cache to the current text. */
async function diffSource(url: string, baseline: Baseline): Promise<number> {
  const outcome = (
    await hashSources([url], {
      ...DEFAULT_FETCH_OPTIONS,
      fetch: (target, init) => fetch(target, init),
      sleep: (milliseconds) => sleep(milliseconds),
      token: process.env['GITHUB_TOKEN'],
      concurrency: 1,
    })
  ).get(url) ?? { ok: false, reason: 'not fetched' };
  if (!outcome.ok) {
    stderr(`Cannot fetch ${url}: ${outcome.reason}`);
    return 1;
  }
  await cacheOutcomes(new Map([[url, outcome]]));
  if (outcome.location !== undefined) stderr(`${url} redirects to ${outcome.location}.`);

  const recorded = baseline.get(url);
  if (recorded === outcome.hash) {
    process.stdout.write(`${forTerminal(url)} has the baseline's hash; nothing changed.\n`);
    return 0;
  }
  let previous: { hash: string; label: string; text: string } | undefined;
  const baselineText = recorded === undefined ? undefined : await cachedText(CACHE, url, recorded);
  if (recorded !== undefined && baselineText !== undefined) {
    previous = { hash: recorded, label: 'baseline', text: baselineText };
  } else {
    const other = (await cachedVersions(CACHE, url)).find(
      (version) => version.hash !== outcome.hash,
    );
    const text = other === undefined ? undefined : await cachedText(CACHE, url, other.hash);
    if (other !== undefined && text !== undefined) {
      const date = new Date(other.cachedAt).toISOString().slice(0, 10);
      previous = { hash: other.hash, label: `cached on ${date}`, text };
      stderr(
        recorded === undefined
          ? `${url} is not in the baseline. Showing the change since the text cached on ${date}.`
          : `The text with the baseline's hash ${short(recorded)} is not cached here. Showing the change since the text cached on ${date}.`,
      );
    }
  }
  if (previous === undefined) {
    stderr(
      `No earlier text of ${url} is cached here. The cache keeps each version that drift:check or drift:update fetched on this machine; run one of them before a source changes to diff it later.`,
    );
    return 1;
  }
  process.stdout.write(
    formatTextDiff(previous.text, outcome.text, {
      from: `${url} (${previous.label} ${short(previous.hash)})`,
      to: `${url} (now ${short(outcome.hash)})`,
    }),
  );
  return 0;
}

function reasonOf(outcomes: ReadonlyMap<string, Outcome>, url: string): string {
  const outcome = outcomes.get(url);
  return outcome === undefined || outcome.ok ? 'not fetched' : outcome.reason;
}

async function main(args: readonly string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        format: { type: 'string', default: 'text' },
        report: { type: 'string' },
        only: { type: 'string', multiple: true, default: [] },
        update: { type: 'boolean', default: false },
        diff: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.format !== 'text' && values.format !== 'json') {
    return usageError(`--format must be text or json, not ${values.format}`);
  }
  if (values.update && (values.report !== undefined || values.format !== 'text')) {
    return usageError('--update cannot be combined with --format or --report');
  }
  if (
    values.diff !== undefined &&
    (values.update ||
      values.report !== undefined ||
      values.format !== 'text' ||
      values.only.length > 0)
  ) {
    return usageError('--diff cannot be combined with --update, --format, --report or --only');
  }

  const index = buildSourceIndex(
    [...builtinRules.map((rule) => rule.meta), ...DIRECTIVE_RULES],
    SOURCES,
  );
  const { watched, own } = splitOwnSources(index);
  let selected: SourceIndex = watched;
  const only = values.diff === undefined ? values.only : [values.diff];
  if (only.length > 0) {
    const subset = new Map<string, readonly string[]>();
    for (const url of only) {
      const rules = watched.get(url);
      if (rules === undefined) {
        return usageError(
          own.has(url)
            ? `${url} is in this repository and is not checked`
            : `no rule or context loader cites ${url}`,
        );
      }
      subset.set(url, rules);
    }
    selected = subset;
  }

  let baseline: Baseline;
  try {
    baseline = await readBaseline();
  } catch (error) {
    stderr(
      `Cannot read ${BASELINE_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  if (values.diff !== undefined) return diffSource(values.diff, baseline);

  stderr(`Fetching ${selected.size} cited URL${selected.size === 1 ? '' : 's'}...`);
  const outcomes = await hashSources([...selected.keys()], {
    ...DEFAULT_FETCH_OPTIONS,
    fetch: (url, init) => fetch(url, init),
    sleep: (milliseconds) => sleep(milliseconds),
    token: process.env['GITHUB_TOKEN'],
    concurrency: CONCURRENCY,
  });
  await cacheOutcomes(outcomes);
  const input = {
    watched: selected,
    own,
    outcomes,
    baseline,
    complete: values.only.length === 0,
  };

  if (values.update) {
    const result = updateBaseline(input);
    await writeAtomic(BASELINE_FILE, serializeBaseline(result.baseline));
    const lines = [
      `Updated scripts/drift/baseline.json: ${result.updated.length} changed, ${result.removed.length} removed.`,
      ...result.updated.map((url) => `  updated: ${url}`),
      ...result.removed.map((url) => `  removed: ${url}`),
      ...result.kept.map(
        (url) => `  kept the previous hash, unreachable: ${url} (${reasonOf(outcomes, url)})`,
      ),
      ...result.missing.map((url) => `  no hash, unreachable: ${url} (${reasonOf(outcomes, url)})`),
    ];
    // One sanitized line each: a reason from the network cannot start a new line.
    process.stdout.write(`${lines.map((line) => forTerminal(line)).join('\n')}\n`);
    return result.kept.length > 0 || result.missing.length > 0 ? 1 : 0;
  }

  const report = compareWithBaseline(input);
  if (values.report !== undefined) await writeFile(values.report, formatJson(report), 'utf8');
  process.stdout.write(values.format === 'json' ? formatJson(report) : formatText(report));
  return needsAttention(report) ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
