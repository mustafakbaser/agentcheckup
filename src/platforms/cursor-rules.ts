/**
 * How Cursor decides when a project rule in `.cursor/rules` applies, shared by the cursor/* rules
 * and the Cursor load plan. Source: https://cursor.com/docs/rules (rule anatomy table).
 *
 * | alwaysApply | description | globs   | Cursor                                      |
 * | ----------- | ----------- | ------- | ------------------------------------------- |
 * | true        | any         | any     | always included                             |
 * | false       | any         | set     | attached when a matching file is in context |
 * | false       | set         | not set | included when the agent finds it relevant   |
 * | false       | not set     | not set | included only when @-mentioned              |
 */
import type { FrontmatterResult } from '../parse/types.js';
import { basename } from './paths.js';

/** The docs recommend keeping each rule under this many lines. Advice only; nothing is cut. */
export const CURSOR_RULE_LINE_ADVICE = 500;

/**
 * - `always`, `globs`, `description`, `manual`: the four documented modes.
 * - `unknown`: the frontmatter block is not valid YAML (or not YAML at all). Cursor does not
 *   document how it reads such a block; its own editor writes unquoted globs such as
 *   `globs: *.ts`, which YAML rejects, so the mode cannot be told.
 */
export type CursorRuleMode = 'always' | 'globs' | 'description' | 'manual' | 'unknown';

export interface CursorActivation {
  readonly mode: CursorRuleMode;
  /** The frontmatter sets `alwaysApply`, with any value. An explicit `false` keeps a rule manual on purpose. */
  readonly alwaysApplySet: boolean;
  /** Glob patterns from `globs`: a comma-separated string split at commas, or list items. */
  readonly globs: readonly string[];
  /**
   * False when the mode depends on a form the docs do not describe: frontmatter that does not
   * parse, a non-boolean `alwaysApply`, `globs` that is not a string, or a `description` that is
   * not text.
   */
  readonly documented: boolean;
}

/** A field that counts as set for activation: non-blank text, a non-empty list, any other value. */
function isSet(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

/**
 * Patterns in a comma-separated string or a list of strings, trimmed, without empty items.
 * Undefined for any other value.
 */
export function globList(value: unknown): string[] | undefined {
  const items =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? value
        : undefined;
  return items?.map((item) => item.trim()).filter((item) => item !== '');
}

const UNKNOWN: CursorActivation = {
  mode: 'unknown',
  alwaysApplySet: false,
  globs: [],
  documented: false,
};

/** When Cursor applies a `.mdc` rule, from its parsed frontmatter. */
export function cursorActivation(frontmatter: FrontmatterResult): CursorActivation {
  if (frontmatter.kind === 'absent') {
    return { mode: 'manual', alwaysApplySet: false, globs: [], documented: true };
  }
  if (frontmatter.kind !== 'valid') return UNKNOWN;
  const { values } = frontmatter.data;
  const alwaysApply = values['alwaysApply'];
  const description = values['description'];
  const globs = values['globs'];
  const documented =
    (alwaysApply === undefined || alwaysApply === null || typeof alwaysApply === 'boolean') &&
    (description === undefined || description === null || typeof description === 'string') &&
    (globs === undefined || globs === null || typeof globs === 'string');
  const mode: CursorRuleMode =
    alwaysApply === true
      ? 'always'
      : isSet(globs)
        ? 'globs'
        : isSet(description)
          ? 'description'
          : 'manual';
  return {
    mode,
    alwaysApplySet: Object.hasOwn(values, 'alwaysApply'),
    globs: globList(globs) ?? [],
    documented,
  };
}

/**
 * True for a README in `.cursor/rules`. It documents the rules; Cursor does not load it and
 * cursor/md-file-ignored does not report it.
 */
export function isRulesReadme(path: string): boolean {
  return basename(path).toLowerCase() === 'readme.md';
}
