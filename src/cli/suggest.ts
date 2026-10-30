/**
 * `agentcheckup fix [path] --untrusted --format suggestions --diff <file>`: review comments with
 * suggested changes for the safe fixes of a pull request, which the GitHub Action posts
 * (src/report/suggestions-json.ts, schemas/suggestions.schema.json).
 *
 * `[path]` is the pull request's head and `<file>` its unified diff, with paths relative to
 * `[path]`. Both are untrusted, so the command:
 * - needs `--untrusted` and never writes: `--write` and `-i` are usage errors;
 * - reads the diff with the bounded input reader, at most {@link MAX_DIFF_BYTES};
 * - runs one verified round of safe fixes, never those of mcp/literal-secret.
 *
 * Exits 0 with the JSON whatever it suggests, 2 for invalid arguments or a diff it cannot read,
 * and 3 when a rule crashed, without output: a crashed scan cannot verify a fix.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createParseCache } from '../core/parse-cache.js';
import { fixRounds, type FixSelection } from '../fix/index.js';
import { readTextInput } from '../io/read-file.js';
import { checkRoot, walk } from '../io/walk.js';
import { forTerminal } from '../report/sanitize.js';
import { formatSuggestionsJson } from '../report/suggestions-json.js';
import { MAX_DIFF_BYTES, MAX_DIFF_HUNKS, parseUnifiedDiff } from '../report/unified-diff.js';
import { type FixCommandOptions, UsageError } from './args.js';
import {
  allRuleMeta,
  checkOutput,
  emit,
  EXIT,
  type ExitCode,
  type Io,
  loadConfig,
  scanOptionsFor,
} from './common.js';

/** The `--diff` file, or a UsageError for options `--format suggestions` does not allow. */
function diffFileOf(options: FixCommandOptions): string {
  if (options.format !== 'suggestions') {
    throw new UsageError('--diff works only with --format suggestions.');
  }
  if (options.write || options.interactive) {
    throw new UsageError(
      `--format suggestions only prints suggestions, so it cannot be combined with ${options.write ? '--write' : '-i'}.`,
    );
  }
  if (options.diff === undefined) {
    throw new UsageError(
      '--format suggestions needs --diff <file>: the unified diff of the pull request.',
    );
  }
  if (!options.untrusted) {
    throw new UsageError(
      '--format suggestions needs --untrusted: the pull request is untrusted input.',
    );
  }
  return options.diff;
}

/** `--rule` as a set, or a UsageError naming the ids no rule has. */
function ruleIdsOf(ids: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (ids === undefined) return undefined;
  const known = new Set(allRuleMeta().map((meta) => meta.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    const names = unknown.map((id) => `"${id}"`).join(', ');
    throw new UsageError(
      `--rule: unknown rule ${names}. Run "agentcheckup rules" to list the rules.`,
    );
  }
  return new Set(ids);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function suggest(options: FixCommandOptions, io: Io): Promise<ExitCode> {
  const diffFile = diffFileOf(options);
  const ruleIds = ruleIdsOf(options.rules);
  // The diff first: a file that cannot be read fails before the scan.
  const text = await readTextInput(resolve(io.cwd, diffFile), {
    label: 'Diff file',
    maxBytes: MAX_DIFF_BYTES,
    invalidUtf8: 'replace',
  });
  const diff = parseUnifiedDiff(text);
  if (diff.truncated) {
    io.stderr(
      `Warning: the diff has more than ${MAX_DIFF_HUNKS} hunks; changes in the rest are not suggested.\n`,
    );
  }

  const directory = await checkRoot(resolve(io.cwd, options.path));
  const root = directory.path;
  const config = await loadConfig(options, root, io.cwd);
  const snapshot = await walk(root, { respectGitignore: true, scanIgnoredAgentConfig: true });
  await checkOutput(options, io, directory, snapshot);
  const selection: FixSelection = {
    classes: new Set(['safe']),
    ...(ruleIds === undefined ? {} : { ruleIds }),
    literalSecret: false,
  };
  const run = fixRounds(
    snapshot,
    { ...scanOptionsFor(options, config, options.targets), parseCache: createParseCache() },
    selection,
    1,
  );
  for (const warning of run.before.configWarnings) {
    io.stderr(`Warning: ${forTerminal(warning)}\n`);
  }
  if (run.before.ruleFailures.length > 0) {
    for (const failure of run.before.ruleFailures) {
      io.stderr(`Rule ${forTerminal(failure.ruleId)} crashed: ${forTerminal(failure.message)}\n`);
    }
    io.stderr('No suggestions were written: a scan with a crashed rule cannot verify them.\n');
    return EXIT.internal;
  }

  const report = formatSuggestionsJson({
    snapshot,
    run,
    ruleIds,
    diff,
    rules: allRuleMeta(),
    sha256,
  });
  await emit(report, options, io);
  return EXIT.ok;
}
