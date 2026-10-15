/**
 * .gitignore matching without git.
 *
 * Never shell out to `git` (`git check-ignore`, `git ls-files`, ...): the scanned repository is
 * untrusted, and its `.git/config` can set `core.fsmonitor` (or filters, hooks paths, aliases) to
 * a command that git runs on ordinary read-only invocations. Running git inside a cloned repo is
 * arbitrary code execution. The `ignore` package implements git's matching in-process.
 *
 * Only `.gitignore` files inside the scanned tree are honored, not `.git/info/exclude` or the
 * user's global excludes file, so results are the same on every machine.
 */
import ignore from 'ignore';

/**
 * Larger .gitignore files are skipped (reported as `too-large`) and not applied. Every listed path
 * is tested against every rule of every .gitignore above it, so the cap bounds that cost: a 1 MiB
 * file (~50 000 rules) measured ~25 ms per path, minutes for a large tree.
 */
export const MAX_GITIGNORE_BYTES = 256 * 1024;

/**
 * Patterns with more `**` than this are dropped. The `ignore` package compiles each `**` into an
 * optional repeated group; several of them in a row are ambiguous, so matching backtracks
 * polynomially in the path depth with the globstar count as the exponent (measured: a pattern
 * with 12 globstars takes seconds on a 33-level path). A hostile repository could use that to hang
 * the scan. Real .gitignore files rarely use more than two. Dropping a pattern can only make the
 * walker read more files, never fewer.
 */
export const MAX_GLOBSTARS_PER_PATTERN = 3;

/**
 * Matching cost. Every listed entry is tested against every rule of every .gitignore above it, so
 * the cost of a walk is roughly entries x rules, and a rule with globstars costs more on deep paths
 * (measured on a 33-level path: ~140 ns plain, ~265 ns with one `**`, ~2.3 us with two, ~13.5 us
 * with three). Rules are weighed in units of about one plain rule, and three budgets bound the
 * matching work deterministically: 30 nested 256 KiB files once made a 15 MB repository take
 * minutes. Over budget, a .gitignore is simply not applied (reported in `skipped`), which can only
 * make the walker read more, never less.
 */
/** Weight of a pattern by its globstar count (0 to MAX_GLOBSTARS_PER_PATTERN; more are dropped). */
const GLOBSTAR_WEIGHTS: readonly number[] = [1, 2, 16, 96];

/** Total weight of the .gitignore rules applied to any one path (its whole ancestor chain). */
export const MAX_GITIGNORE_WEIGHT_PER_PATH = 20_000;

/** Total weight of the rules compiled during a walk: bounds memory and compile time. */
export const MAX_GITIGNORE_WEIGHT_TOTAL = 100_000;

/**
 * Total weight of the rule tests during a walk (sum over tested entries of their chain weight).
 * Large enough for 200 000 entries under 250 rules; past it, .gitignore stops being applied.
 */
export const MAX_GITIGNORE_MATCH_WORK = 50_000_000;

type Matcher = ReturnType<typeof ignore>;
type MatchResult = ReturnType<Matcher['test']>;

/** The usable patterns of one .gitignore file and their total weight. */
export interface GitignoreRules {
  readonly patterns: readonly string[];
  readonly weight: number;
  /** Patterns dropped for having more than MAX_GLOBSTARS_PER_PATTERN globstars. */
  readonly dropped: number;
}

/** The .gitignore rules of one directory, linked to those of its ancestors. */
export interface IgnoreLayer {
  /** Root-relative POSIX path of the directory holding the .gitignore (`''` for the root). */
  readonly base: string;
  readonly matcher: Matcher;
  readonly parent: IgnoreLayer | undefined;
  /** Weight of this layer's rules plus all its ancestors': the cost of testing one path. */
  readonly chainWeight: number;
}

/** Usable patterns: no blank lines or comments, and no patterns with too many globstars. */
export function parseGitignore(text: string): GitignoreRules {
  const patterns: string[] = [];
  let weight = 0;
  let dropped = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '' || line.startsWith('#')) continue;
    const ruleWeight = GLOBSTAR_WEIGHTS[countGlobstars(line)];
    if (ruleWeight === undefined) {
      dropped += 1;
      continue;
    }
    patterns.push(line);
    weight += ruleWeight;
  }
  return { patterns, weight, dropped };
}

/** The weight of testing one path against `layer` and its ancestors. */
export function chainWeight(layer: IgnoreLayer | undefined): number {
  return layer?.chainWeight ?? 0;
}

/**
 * Returns the layer list for a directory: `parent` with `rules` (its own .gitignore) on top, or
 * `parent` itself when there are no usable rules. Budgets are the caller's job.
 */
export function addGitignoreRules(
  parent: IgnoreLayer | undefined,
  base: string,
  rules: GitignoreRules,
): IgnoreLayer | undefined {
  // Case-sensitive like git's default (core.ignorecase=false), so the result does not depend on
  // the filesystem of the machine running the scan.
  const matcher = ignore({ ignorecase: false });
  let added = 0;
  for (const pattern of rules.patterns) {
    try {
      matcher.add(pattern);
      added += 1;
    } catch {
      // A pattern the library cannot compile matches nothing, as in git.
    }
  }
  if (added === 0) return parent;
  return { base, matcher, parent, chainWeight: chainWeight(parent) + rules.weight };
}

/** parseGitignore and addGitignoreRules in one step. */
export function addGitignore(
  parent: IgnoreLayer | undefined,
  base: string,
  text: string,
): IgnoreLayer | undefined {
  return addGitignoreRules(parent, base, parseGitignore(text));
}

/**
 * Git semantics: the deepest .gitignore with a matching pattern decides, and within one file the
 * last matching pattern wins (so `!pattern` can re-include). Callers never descend into an
 * ignored directory, which is why nothing below one can be re-included, as in git.
 */
export function isIgnored(
  layer: IgnoreLayer | undefined,
  relativePath: string,
  isDirectory: boolean,
): boolean {
  for (let current = layer; current !== undefined; current = current.parent) {
    const local = current.base === '' ? relativePath : relativePath.slice(current.base.length + 1);
    const result = testPath(current.matcher, isDirectory ? `${local}/` : local);
    if (result?.ignored === true) return true;
    if (result?.unignored === true) return false;
  }
  return false;
}

function testPath(matcher: Matcher, candidate: string): MatchResult | undefined {
  try {
    return matcher.test(candidate);
  } catch {
    // `ignore` rejects some path shapes. Treat them as not ignored: scanning one extra file is
    // harmless, aborting the walk is not.
    return undefined;
  }
}

function countGlobstars(pattern: string): number {
  let count = 0;
  for (let index = pattern.indexOf('**'); index !== -1; index = pattern.indexOf('**', index + 2)) {
    count += 1;
  }
  return count;
}
