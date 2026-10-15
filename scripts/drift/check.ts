/**
 * Checks the sources cited by agentcheckup's rules and context loaders for changes.
 *
 *   pnpm drift:check [--format text|json] [--report <file>] [--only <url>]...
 *   pnpm drift:update [--only <url>]...
 *
 * Fetches every URL in the built-in rules' `meta.sources` and in src/platforms/sources.ts (the
 * sources load plans and the inventory cite by key), normalizes and hashes the content, and
 * compares the hashes with scripts/drift/baseline.json. Exit code 0: nothing changed.
 * 1: a source changed, is new, or could not be fetched. 2: usage error or unreadable baseline.
 *
 * `--update` writes the current hashes to the baseline instead. Use it after re-reading the
 * changed sources and updating the rules or their `checked` dates; this script never edits
 * rules. `--only` limits the check or the update to the given URLs, so an update accepts only
 * the sources you re-read. Set GITHUB_TOKEN to read github.com files through the REST API.
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
import { DEFAULT_FETCH_OPTIONS, hashSources, type Outcome } from './fetch.js';
import { formatJson, formatText } from './report.js';
import { buildSourceIndex, type SourceIndex, splitOwnSources } from './sources.js';

const BASELINE_FILE = fileURLToPath(new URL('baseline.json', import.meta.url));
const CONCURRENCY = 6;

const USAGE = `Usage:
  pnpm drift:check [--format text|json] [--report <file>] [--only <url>]...
  pnpm drift:update [--only <url>]...

Options:
  --format <text|json>  Output format on stdout (default: text)
  --report <file>       Also write the JSON report to <file>
  --only <url>          Check or update only this cited URL; repeatable
  --update              Write the current hashes to scripts/drift/baseline.json
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

  const index = buildSourceIndex(
    [...builtinRules.map((rule) => rule.meta), ...DIRECTIVE_RULES],
    SOURCES,
  );
  const { watched, own } = splitOwnSources(index);
  let selected: SourceIndex = watched;
  if (values.only.length > 0) {
    const subset = new Map<string, readonly string[]>();
    for (const url of values.only) {
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

  stderr(`Fetching ${selected.size} cited URL${selected.size === 1 ? '' : 's'}...`);
  const outcomes = await hashSources([...selected.keys()], {
    ...DEFAULT_FETCH_OPTIONS,
    fetch: (url, init) => fetch(url, init),
    sleep: (milliseconds) => sleep(milliseconds),
    token: process.env['GITHUB_TOKEN'],
    concurrency: CONCURRENCY,
  });
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
