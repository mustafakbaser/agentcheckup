/**
 * Frontmatter repairs shared by cursor/rule-frontmatter and cursor/md-file-ignored: the fields
 * Cursor reads, the names other tools use for them, and the edits that turn a field into the form
 * Cursor documents. See src/platforms/cursor-rules.ts for how the fields decide when a rule
 * applies.
 */
import type { Artifact, FileChange } from '../../core/types.js';
import { yamlRenameKey, yamlReplaceValue, yamlSetScalar } from '../../fix/edits.js';
import type { FrontmatterResult } from '../../parse/types.js';
import { joinPatterns } from './fixes.js';

type ValidFrontmatter = Extract<FrontmatterResult, { kind: 'valid' }>;

export const KNOWN_FIELDS: ReadonlySet<string> = new Set(['description', 'globs', 'alwaysApply']);

/** Fields other tools use for the same purpose, and common misspellings. */
export const SUGGESTIONS: Readonly<Record<string, string>> = {
  glob: 'globs',
  paths: 'globs',
  applyTo: 'globs',
  always_apply: 'alwaysApply',
  alwaysapply: 'alwaysApply',
  'always-apply': 'alwaysApply',
};

/** Scoping fields of other tools that a fix renames to `globs`: Claude Code's and Copilot's. */
export const GLOB_ALIASES: readonly string[] = ['paths', 'applyTo'];

/** How Cursor's documentation separates glob patterns: `"src/**\/*.ts, test/**\/*.ts"`. */
export const GLOB_SEPARATOR = ', ';

const GLOBS_EXAMPLE = 'globs: "src/**/*.ts, test/**/*.ts"';

/** A field that counts as set for activation, as `cursorActivation` decides. */
export function isSet(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

/** A YAML list whose items are all strings. */
export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** An edit, or the manual step that replaces it. */
export type Repair =
  | { readonly ok: true; readonly change: FileChange }
  | { readonly ok: false; readonly guidance: string };

const manual = (guidance: string): Repair => ({ ok: false, guidance });

/** Writes `alwaysApply: "true"` as the boolean `true`. */
export function alwaysApplyBoolean(artifact: Artifact, frontmatter: ValidFrontmatter): Repair {
  const value = frontmatter.data.values['alwaysApply'];
  const instead = 'write "alwaysApply: true" or "alwaysApply: false" without quotes';
  if (value !== 'true') return manual(instead);
  const change = yamlSetScalar(artifact, frontmatter, 'alwaysApply', true);
  return change === undefined ? manual(instead) : { ok: true, change };
}

/** Joins a `globs` YAML list into one comma-separated string. */
export function globsString(artifact: Artifact, frontmatter: ValidFrontmatter): Repair {
  const joined = joinPatterns(frontmatter.data.values['globs'], GLOB_SEPARATOR);
  const change =
    joined === undefined
      ? undefined
      : yamlReplaceValue(artifact, frontmatter, 'globs', joined, { style: 'double' });
  if (change === undefined) {
    return manual(
      `write the patterns as one comma-separated string by hand, such as ${GLOBS_EXAMPLE}; expand a pattern with a comma, such as "src/{a,b}/**", into one pattern per alternative`,
    );
  }
  return { ok: true, change };
}

/**
 * Renames `paths` or `applyTo` to `globs`, joining a list into one string. Manual when the
 * frontmatter has `globs` or both aliases already, or the value is not patterns.
 */
export function globsFromAlias(
  artifact: Artifact,
  frontmatter: ValidFrontmatter,
  key: string,
): Repair {
  const { values } = frontmatter.data;
  if (Object.hasOwn(values, 'globs')) {
    return manual(`move the patterns of "${key}" into "globs" by hand and remove "${key}"`);
  }
  if (GLOB_ALIASES.filter((alias) => Object.hasOwn(values, alias)).length > 1) {
    return manual('merge "paths" and "applyTo" into one "globs" field by hand');
  }
  const value = values[key];
  let change: FileChange | undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    change = yamlRenameKey(artifact, frontmatter, key, 'globs');
  } else {
    const joined = joinPatterns(value, GLOB_SEPARATOR);
    change =
      joined === undefined
        ? undefined
        : yamlReplaceValue(artifact, frontmatter, key, joined, {
            renameTo: 'globs',
            style: 'double',
          });
  }
  if (change === undefined) {
    return manual(
      `replace "${key}" with one comma-separated "globs" string, such as ${GLOBS_EXAMPLE}`,
    );
  }
  return { ok: true, change };
}
