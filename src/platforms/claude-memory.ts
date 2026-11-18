/**
 * `claudeMdExcludes`: memory files Claude Code skips because a settings file names them by path
 * or glob (SOURCES.claudeMemory, "Exclude specific CLAUDE.md files"; SOURCES.claudeSettingsReference,
 * `claudeMdExcludes`). Shared by the Claude Code load plan, instr/agents-md-ignored-by-claude and
 * instr/claude-md-too-long, so a file the plan skips as excluded is not judged as loaded. Pure.
 *
 * - "The `claudeMdExcludes` setting lets you skip specific files by path or glob pattern."
 * - "Patterns are matched against absolute file paths using glob syntax. You can configure
 *   `claudeMdExcludes` at any settings layer: user, project, local, or managed policy. Arrays
 *   merge across layers."
 * - It applies to CLAUDE.md and CLAUDE.local.md files and `.claude/rules/` files ("This example
 *   excludes a top-level CLAUDE.md and a rules directory"), and to AGENTS.md: "Inside each
 *   `AGENTS.md`: ... `claudeMdExcludes` patterns apply".
 * - "To exclude a rules file you reach through a symlink ... A pattern that matches either path
 *   excludes the file."
 *
 * The repository shows the project and local layers only; user and managed settings may exclude
 * more. agentcheckup does not know the absolute path of the scan root, so a pattern that names it,
 * such as `/home/user/monorepo/CLAUDE.md`, only may match (./glob.ts).
 */
import type { JsonPath } from '../parse/json-access.js';
import { type GlobMatch, matchAbsoluteGlob } from './glob.js';
import type { LoadView } from './load/view.js';
import { claudeProjectSettings, settingAt } from './root-settings.js';

/** Most patterns evaluated; with more, every memory file may be excluded. */
const MAX_PATTERNS = 256;

const KEY: JsonPath = ['claudeMdExcludes'];

/** The parts of a view the exclusions read. */
export type ExclusionView = Pick<LoadView, 'snapshot' | 'index' | 'json'>;

/** The patterns of `claudeMdExcludes`, merged over the project settings a session reads. */
export interface ClaudeMdExcludes {
  readonly patterns: readonly string[];
  /** True when a settings file holds more patterns than agentcheckup evaluates. */
  readonly truncated: boolean;
}

/**
 * `claudeMdExcludes` from the Claude Code project settings a session started in `cwd` reads
 * ({@link claudeProjectSettings}), arrays merged. Values that are not strings are ignored.
 */
export function claudeMdExcludes(view: ExclusionView, cwd: string): ClaudeMdExcludes {
  const patterns: string[] = [];
  for (const doc of claudeProjectSettings(view, cwd)) {
    const value = settingAt(doc, KEY);
    if (!Array.isArray(value)) continue;
    for (const item of value) if (typeof item === 'string' && item !== '') patterns.push(item);
  }
  return {
    patterns: patterns.slice(0, MAX_PATTERNS),
    truncated: patterns.length > MAX_PATTERNS,
  };
}

/**
 * Whether `excludes` exclude a memory file Claude Code reaches at any of `paths` (its path and,
 * for a rule, its link target): `match` when a pattern matches whatever directory the repository
 * is checked out in, `maybe` when that depends on the directory or on syntax agentcheckup does
 * not evaluate, `no` otherwise.
 */
export function claudeMdExcluded(excludes: ClaudeMdExcludes, paths: readonly string[]): GlobMatch {
  let result: GlobMatch = excludes.truncated ? 'maybe' : 'no';
  for (const pattern of excludes.patterns) {
    for (const path of paths) {
      const match = matchAbsoluteGlob(pattern, path);
      if (match === 'match') return 'match';
      if (match === 'maybe') result = 'maybe';
    }
  }
  return result;
}

/**
 * The exclusions of every working directory, read once per directory: `(paths, cwd)` tells how
 * the settings of a session started in `cwd` exclude a file reached at `paths`.
 */
export function claudeExclusions(
  view: ExclusionView,
): (paths: readonly string[], cwd: string) => GlobMatch {
  const byCwd = new Map<string, ClaudeMdExcludes>();
  return (paths, cwd) => {
    let excludes = byCwd.get(cwd);
    if (excludes === undefined) {
      excludes = claudeMdExcludes(view, cwd);
      byCwd.set(cwd, excludes);
    }
    return excludes.patterns.length === 0 && !excludes.truncated
      ? 'no'
      : claudeMdExcluded(excludes, paths);
  };
}

/** Splits a comma-separated `paths` string, keeping commas inside `{...}` braces. */
function splitPatterns(value: string): string[] {
  const patterns: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= value.length; i++) {
    const char = value.charAt(i);
    if (char === '{') depth++;
    else if (char === '}' && depth > 0) depth--;
    else if (i === value.length || (char === ',' && depth === 0)) {
      const pattern = value.slice(start, i).trim();
      if (pattern !== '') patterns.push(pattern);
      start = i + 1;
    }
  }
  return patterns;
}

/**
 * The globs of a `paths` frontmatter value as Claude Code reads it in a rule or a skill: "a
 * YAML list or a comma-separated string" (SOURCES.claudeMemory); a skill's `paths` "Uses the same
 * glob format as path-specific rules" (SOURCES.claudeSkills). Empty for any other value, and for
 * a list that holds anything but strings.
 */
export function claudePathPatterns(value: unknown): string[] {
  if (typeof value === 'string') return splitPatterns(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.filter((item: string) => item.trim() !== '');
  }
  return [];
}
