/**
 * Cline's project layout and when it applies a rule, shared by the classifier, the security
 * inventory and the Cline load plans.
 *
 * Cline reads project configuration from `.cline/` (`rules/`, `workflows/`, `skills/`, `hooks/`,
 * `agents/`, `plugins/`) and from the legacy `.clinerules/`, whose files are rules except those
 * in its `workflows/`, `hooks/` and `skills/` folders (SOURCES.clineConfig,
 * SOURCES.clineRulesSource: `CLINERULES_EXCLUDED_SUBDIRECTORIES`). A rule applies always, or only
 * to the files its `paths` globs match (SOURCES.clineRules).
 */
import type { FrontmatterResult } from '../parse/types.js';

/**
 * What a file is to Cline, from where it sits:
 * - `rule`: a rule file in `.clinerules/` (outside its `workflows/`, `hooks/` and `skills/`
 *   folders) or in `.cline/rules/`.
 * - `workflow`: a workflow in `.clinerules/workflows/` or `.cline/workflows/`, run as a command.
 * - `hook`: a file in `.clinerules/hooks/` or `.cline/hooks/`.
 * - `skill`: a file in `.clinerules/skills/` or `.cline/skills/`.
 * - `agent`, `plugin`: a file in `.cline/agents/` or `.cline/plugins/`.
 */
export type ClineRole = 'rule' | 'workflow' | 'hook' | 'skill' | 'agent' | 'plugin';

export interface ClinePlace {
  readonly role: ClineRole;
  /** The directory that holds the configuration folder ('' for the scan root). */
  readonly root: string;
  /** `.clinerules` or `.cline`, as written in the path. */
  readonly folder: string;
}

/** Folders of `.clinerules` whose files are not rules. */
const CLINERULES_ROLES: Readonly<Record<string, ClineRole>> = {
  workflows: 'workflow',
  hooks: 'hook',
  skills: 'skill',
};

/** Folders of `.cline` and what their files are. */
const CLINE_ROLES: Readonly<Record<string, ClineRole>> = {
  rules: 'rule',
  workflows: 'workflow',
  hooks: 'hook',
  skills: 'skill',
  agents: 'agent',
  plugins: 'plugin',
};

/**
 * What the file at `path` (root-relative POSIX) is to Cline, or undefined outside its folders.
 * The configuration folder is the last `.clinerules` or `.cline` directory on the path. Folder
 * names are compared without regard to letter case, as the classifier compares them.
 */
export function clinePlace(path: string): ClinePlace | undefined {
  const segments = path.split('/');
  const lower = path.toLowerCase().split('/');
  // The last segment is the file name, not a folder.
  for (let i = lower.length - 2; i >= 0; i--) {
    const folder = lower[i];
    if (folder !== '.clinerules' && folder !== '.cline') continue;
    const next = lower[i + 1] ?? '';
    // A folder name only counts when there is a file below it.
    const sub = i + 2 < lower.length ? next : undefined;
    const role =
      folder === '.clinerules'
        ? sub !== undefined && Object.hasOwn(CLINERULES_ROLES, sub)
          ? CLINERULES_ROLES[sub]
          : 'rule'
        : sub !== undefined && Object.hasOwn(CLINE_ROLES, sub)
          ? CLINE_ROLES[sub]
          : undefined;
    if (role === undefined) return undefined;
    return { role, root: segments.slice(0, i).join('/'), folder: segments[i] ?? folder };
  }
  return undefined;
}

/** Extensions Cline reads as rule files (SOURCES.clineInstructionLoaderSource). */
export const CLINE_RULE_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.txt'];

/** True when Cline reads a file with this name as a rule, by its extension. */
export function isClineRuleFile(name: string): boolean {
  const lower = name.toLowerCase();
  return CLINE_RULE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * True when Cline reads the file at `path` as a rule or a workflow, whatever its name: a rule
 * file in a rules or workflows folder. `.clinerules/AGENTS.md` is a rule to Cline, not an
 * AGENTS.md.
 */
export function isClineRuleOrWorkflow(path: string): boolean {
  const place = clinePlace(path);
  return (
    place !== undefined &&
    (place.role === 'rule' || place.role === 'workflow') &&
    isClineRuleFile(path.slice(path.lastIndexOf('/') + 1))
  );
}

/**
 * When Cline applies a rule:
 * - `always`: in every request. A rule without frontmatter or without `paths`, and a rule whose
 *   frontmatter does not parse: Cline's documentation says it then fails open.
 * - `paths`: when a file the `paths` globs match is in the request.
 * - `never`: `paths: []` matches nothing, so the rule never applies.
 * - `unknown`: `paths` is neither a list of strings nor empty.
 */
export type ClineRuleMode = 'always' | 'paths' | 'never' | 'unknown';

export interface ClineActivation {
  readonly mode: ClineRuleMode;
  /** The `paths` globs, trimmed, without empty items. */
  readonly paths: readonly string[];
  /**
   * False when the mode rests on behavior that sources disagree on or do not show: frontmatter
   * that does not parse (the documentation says Cline fails open; its SDK throws), or `paths`
   * that is not a list of strings.
   */
  readonly documented: boolean;
}

/** When Cline applies a rule file, from its parsed frontmatter. */
export function clineActivation(frontmatter: FrontmatterResult): ClineActivation {
  if (frontmatter.kind === 'absent') return { mode: 'always', paths: [], documented: true };
  if (frontmatter.kind !== 'valid') return { mode: 'always', paths: [], documented: false };
  const value = frontmatter.data.values['paths'];
  if (value === undefined || value === null) return { mode: 'always', paths: [], documented: true };
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return { mode: 'unknown', paths: [], documented: false };
  }
  if (value.length === 0) return { mode: 'never', paths: [], documented: true };
  const paths = value.map((item) => item.trim()).filter((item) => item !== '');
  // Only blank globs: they match nothing, but no source says how Cline reads them.
  if (paths.length === 0) return { mode: 'never', paths, documented: false };
  return { mode: 'paths', paths, documented: true };
}
