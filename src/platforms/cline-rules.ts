/**
 * Cline's project layout, and when a file turns itself off, shared by the classifier, the engine,
 * the security inventory, the skill rules and the Cline load plans.
 *
 * Cline reads project configuration from `.cline/` (`rules/`, `workflows/`, `skills/`, `hooks/`,
 * `agents/`, `plugins/`) and from the legacy `.clinerules/`, whose files are rules except those
 * in its `workflows/`, `hooks/` and `skills/` folders (SOURCES.clineConfig,
 * SOURCES.clineRulesSource: `CLINERULES_EXCLUDED_SUBDIRECTORIES`). Any other folder of `.cline/`
 * that holds a `managed.json` is a managed plugin: Cline reads its `rules.md` as a rule, the files
 * of its `workflows/` folder as workflows and the skills of its `skills/` folder
 * (`discoverManagedPluginRoots`, SOURCES.clineInstructionLoaderSource). A rule applies in every
 * request: Cline's documentation describes rules scoped by `paths`, but the released extension and
 * CLI never read the field (SOURCES.clineRuleSelectionSource). A rule, workflow or skill whose
 * frontmatter turns it off is not loaded ({@link clineDisabled}).
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
 *
 * In a managed plugin folder `.cline/<name>/`, `rules.md` is a `rule`, a file directly in
 * `workflows/` a `workflow` and a file in `skills/` a `skill`, with `plugin` set.
 */
export type ClineRole = 'rule' | 'workflow' | 'hook' | 'skill' | 'agent' | 'plugin';

export interface ClinePlace {
  readonly role: ClineRole;
  /** The directory that holds the configuration folder ('' for the scan root). */
  readonly root: string;
  /** `.clinerules` or `.cline`, as written in the path. */
  readonly folder: string;
  /**
   * For a file of a managed plugin: the plugin folder, `<root>/.cline/<name>`. Cline reads the
   * file only when the folder holds a `managed.json` ({@link clinePlaceIn}).
   */
  readonly plugin?: string;
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

/** The file that makes a folder of `.cline/` a managed plugin. */
export const CLINE_MANAGED_MANIFEST = 'managed.json';

/**
 * The role of a file in the managed plugin folder `.cline/<name>/`, from the segments below that
 * folder, or undefined when Cline does not read it there. The SDK joins these names as written,
 * so they are compared exactly: `rules.md`, files directly in `workflows/`, and `skills/`.
 */
function managedRole(below: readonly string[]): ClineRole | undefined {
  const [first] = below;
  if (below.length === 1 && first === 'rules.md') return 'rule';
  if (below.length === 2 && first === 'workflows') return 'workflow';
  if (below.length >= 2 && first === 'skills') return 'skill';
  return undefined;
}

/**
 * What the file at `path` (root-relative POSIX) is to Cline, or undefined outside its folders.
 * The configuration folder is the last `.clinerules` or `.cline` directory on the path. Folder
 * names are compared without regard to letter case, as the classifier compares them, except the
 * names inside a managed plugin folder. A managed plugin's file counts here whether or not the
 * folder holds a `managed.json`; {@link clinePlaceIn} checks that.
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
    const root = segments.slice(0, i).join('/');
    const written = segments[i] ?? folder;
    if (folder === '.clinerules') {
      const role =
        sub !== undefined && Object.hasOwn(CLINERULES_ROLES, sub) ? CLINERULES_ROLES[sub] : 'rule';
      return { role: role ?? 'rule', root, folder: written };
    }
    if (sub === undefined) return undefined;
    if (Object.hasOwn(CLINE_ROLES, sub)) {
      const role = CLINE_ROLES[sub];
      return role === undefined ? undefined : { role, root, folder: written };
    }
    const role = managedRole(segments.slice(i + 2));
    if (role === undefined) return undefined;
    return { role, root, folder: written, plugin: segments.slice(0, i + 2).join('/') };
  }
  return undefined;
}

/**
 * {@link clinePlace}, for a scan whose paths are `paths`: undefined for a file of a managed
 * plugin folder that holds no `managed.json`. Cline also skips a folder whose `managed.json` is
 * not a JSON object or list, which the scan cannot tell: it does not read the manifest.
 */
export function clinePlaceIn(paths: ReadonlySet<string>, path: string): ClinePlace | undefined {
  const place = clinePlace(path);
  if (place?.plugin === undefined) return place;
  return paths.has(`${place.plugin}/${CLINE_MANAGED_MANIFEST}`) ? place : undefined;
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
 * AGENTS.md. `paths` are the scan's paths, which say whether a managed plugin folder holds its
 * `managed.json`.
 */
export function isClineRuleOrWorkflow(paths: ReadonlySet<string>, path: string): boolean {
  const place = clinePlaceIn(paths, path);
  return (
    place !== undefined &&
    (place.role === 'rule' || place.role === 'workflow') &&
    isClineRuleFile(path.slice(path.lastIndexOf('/') + 1))
  );
}

/**
 * True when a rule's frontmatter sets `paths`. Cline's documentation says such a rule applies
 * only to the files its globs match, and `paths: []` never; the released extension and CLI do not
 * read the field and put the rule in every request (SOURCES.clineRuleSelectionSource), which the
 * Cline plan follows and states.
 */
export function clineRuleHasPaths(frontmatter: FrontmatterResult): boolean {
  if (frontmatter.kind !== 'valid') return false;
  const value = frontmatter.data.values['paths'];
  return value !== undefined && value !== null;
}

/** A toggle field of the wrong type, which makes the SDK drop the file. */
export type ClineFlagField = 'disabled' | 'enabled';

/**
 * The toggle field whose value makes the SDK throw, and drop the rule, workflow or skill:
 * `disabled` when it is set and not a boolean, else `enabled` when it is set and not a boolean.
 * The SDK reads `enabled` only when `disabled` is not set (`parseBooleanField(data.disabled) ??
 * ...`, SOURCES.clineInstructionLoaderSource). Null counts as not set.
 */
export function clineFlagTypeError(
  fields: Readonly<Record<string, unknown>>,
): ClineFlagField | undefined {
  const disabled = fields['disabled'];
  if (disabled !== undefined && disabled !== null) {
    return typeof disabled === 'boolean' ? undefined : 'disabled';
  }
  const enabled = fields['enabled'];
  return enabled === undefined || enabled === null || typeof enabled === 'boolean'
    ? undefined
    : 'enabled';
}

/**
 * True when the frontmatter turns the rule, workflow or skill off, so Cline does not load it: a
 * boolean `disabled` wins, and `enabled: false` counts only when `disabled` is not set. The SDK
 * reads the flag from the file (SOURCES.clineInstructionLoaderSource), and the extension writes a
 * rule's toggle in the Rules panel there (SOURCES.clineRulesSource). Frontmatter that does not
 * parse, or that is a list or a scalar, has no flags. A flag of the wrong type is
 * {@link clineFlagTypeError}'s case, not this one.
 */
export function clineDisabled(frontmatter: FrontmatterResult): boolean {
  if (frontmatter.kind !== 'valid') return false;
  const { values } = frontmatter.data;
  const disabled = values['disabled'];
  if (disabled !== undefined && disabled !== null) return disabled === true;
  return values['enabled'] === false;
}
