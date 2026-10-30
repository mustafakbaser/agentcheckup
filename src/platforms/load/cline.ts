/**
 * What Cline loads for a workspace, from docs/platforms.md ("Cline") and the Cline source read at
 * a42df8c, with the extension's cline-rules.ts at 41e75ef (rule toggles in frontmatter, nested
 * rule files). The plan treats `cwd` as the workspace folder opened in VS Code: Cline reads project
 * configuration from that folder only, so files outside it do not appear and files in deeper
 * folders are left to a session opened there (`below-start-dir`).
 *
 * At session start, in the order of the SDK's rule search paths (SOURCES.clinePathsSource):
 * 1. The workspace's AGENTS.md. Cline reads no other AGENTS.md: a nested one is `not-read`.
 * 2. Rule files directly in `.clinerules/`, then in `.cline/rules/`, except the `workflows/`,
 *    `hooks/` and `skills/` folders of `.clinerules` (`clinePlace`, shared with the classifier).
 *    Files in subfolders are `not-read`: the SDK reads only the folder itself, and the extension
 *    says nested files never reach the model. A rule without `paths` applies always, and so does
 *    one whose frontmatter does not parse: the docs say Cline fails open, while the SDK drops such
 *    a rule, so that case is unverified. A rule with `paths` loads on path; `paths: []` never
 *    applies (`never-active`).
 * 3. `.cursorrules` and `.windsurfrules`. The SDK also reads a legacy single-file `.clinerules`.
 * 4. The skills listing: a SKILL.md in `.clinerules/skills`, `.cline/skills`, `.claude/skills` or
 *    `.agents/skills`, in the root or in one folder of it (src/platforms/skills.ts). The body
 *    loads when the model uses the skill.
 *
 * Workflows in `.clinerules/workflows/` and `.cline/workflows/` run as commands (`manual`). The
 * SDK drops a rule, workflow or skill without a body or with a `disabled` or `enabled` that is not
 * a boolean, and a workflow or skill whose frontmatter does not parse or has another field of the
 * wrong type (src/platforms/cline-skills.ts, shared with the skill rules and instr/empty-file,
 * whose findings the skips cite). It does not load one whose frontmatter turns it off
 * (`disabled`, `clineDisabled`): the extension writes the Rules panel's toggle there. Hook
 * scripts in
 * `.clinerules/hooks/` and `.cline/hooks/`, and JavaScript or TypeScript plugins in
 * `.cline/plugins/`, have no documented file format: the plan lists them as incomplete. Cline
 * reads no MCP server file from the repository.
 *
 * Cline reads `.markdown` and `.txt` rules and the extensionless `.clinerules` file, which the
 * scan does not read: they are listed as `unread:`.
 *
 * Startup positions follow the source order above; within a step, files are in path order,
 * which the source does not fix (it lists directories in file-system order).
 */
import { compareStrings } from '../../core/compare.js';
import type { ResolvedConfig } from '../../core/config.js';
import { codePointLength, tokensOf, utf8ByteLength } from '../../core/measure.js';
import { dirnamePosix } from '../../core/paths.js';
import type { Artifact, ArtifactKind } from '../../core/types.js';
import type { FrontmatterResult } from '../../parse/types.js';
import { classify } from '../classify.js';
import {
  clineActivation,
  clineDisabled,
  clineFlagTypeError,
  type ClineRuleMode,
  clinePlace,
  isClineRuleFile,
} from '../cline-rules.js';
import { clineBody, clineBodyBlank, CLINE_SKIP_RULE, clineRead } from '../cline-skills.js';
import { EMPTY_FILE_KINDS } from '../kinds.js';
import { isBundledSkill } from '../location.js';
import { basename, inPayloadFolder } from '../paths.js';
import { SKILL_ROOTS, skillLocation } from '../skills.js';
import { isBlank } from './codex-text.js';
import type {
  Assumption,
  Certainty,
  HiddenScope,
  LimitUsage,
  LoadEntry,
  LoadPlan,
  LoadTrigger,
  OutOfScope,
  Size,
  SkippedLoad,
  SourceKey,
} from './types.js';
import { TRIGGER_RANK } from './types.js';
import type { LoadView } from './view.js';

export interface ClineLoadOptions {
  /** The workspace folder opened in VS Code, relative to the scan root. `''` is the root. */
  readonly cwd: string;
  readonly config: ResolvedConfig;
  /** Not used: Cline documents no limit that depends on the context window. */
  readonly contextWindow?: number;
}

/** A skill `description` longer than this is against the docs; nothing is dropped. */
export const CLINE_SKILL_DESCRIPTION_CHARS = 1024;

const ASSUMPTIONS: readonly Assumption[] = [
  // The Rules panel writes each toggle into the rule's frontmatter, which the plan reads. Toggles
  // that older versions kept in extension state are not in the repository.
  {
    key: 'cline.ruleToggles',
    value: 'frontmatter',
    origin: 'default',
    evidence: ['clineRulesSource', 'clineRules'],
  },
  // The VS Code extension; the CLI and the SDK read the same project folders.
  {
    key: 'cline.surface',
    value: 'vscode',
    origin: 'default',
    evidence: ['clinePathsSource', 'clineRulesSource'],
  },
];

const HIDDEN: readonly HiddenScope[] = [
  {
    scope: 'user',
    locations: [
      '~/.agents/AGENTS.md',
      '~/.cline/rules',
      '~/Cline/Rules',
      '~/Documents/Cline/Rules',
    ],
    roles: ['instructions', 'rule'],
  },
  { scope: 'user', locations: ['~/.agents/skills', '~/.cline/skills'], roles: ['skill'] },
  {
    scope: 'user',
    locations: ['~/.cline/workflows', '~/Documents/Cline/Workflows'],
    roles: ['command'],
  },
  {
    scope: 'user',
    locations: [
      '~/.cline/hooks',
      '~/.cline/plugins',
      '~/Documents/Cline/Hooks',
      '~/Documents/Cline/Plugins',
    ],
    roles: ['hook'],
  },
  {
    scope: 'user',
    locations: ['~/.cline/data/settings/cline_mcp_settings.json'],
    roles: ['mcp-server'],
  },
];

const RULES = {
  emptyFile: 'instr/empty-file',
  filenameCase: 'instr/filename-case',
} as const;

const TRIGGER_FOR_MODE: Readonly<Record<Exclude<ClineRuleMode, 'never'>, LoadTrigger>> = {
  always: 'startup',
  paths: 'on-path',
  unknown: 'unknown',
};

/** Startup groups in source order (see the module comment). */
const GROUP = {
  agentsMd: 0,
  clinerules: 1,
  clineRules: 2,
  cursorrules: 3,
  windsurfrules: 4,
  skills: 5,
} as const;

/** Legacy single files of other agents that Cline reads at the workspace root. */
const LEGACY_FILES: Readonly<Record<string, { readonly group: number }>> = {
  '.cursorrules': { group: GROUP.cursorrules },
  '.windsurfrules': { group: GROUP.windsurfrules },
};

/** Skills roots Cline reads, as `<folder>/skills` (SKILL_ROOTS, shared with the skill rules). */
const SKILL_SEGMENTS: ReadonlySet<string> = new Set(
  SKILL_ROOTS.filter((root) => root.readers.some((reader) => reader.platform === 'cline')).map(
    (root) => root.segment,
  ),
);

const RULE_EVIDENCE: readonly SourceKey[] = ['clinePathsSource', 'clineRules'];
const LOADER_EVIDENCE: readonly SourceKey[] = ['clineInstructionLoaderSource'];
/** The SDK reads the toggle, and the files of a rules folder, as the extension says. */
const TOGGLE_EVIDENCE: readonly SourceKey[] = ['clineInstructionLoaderSource', 'clineRulesSource'];

function sizeOf(bytes: number, chars: number): Size {
  return { bytes, chars, tokens: tokensOf(chars) };
}

function textSize(text: string): Size {
  return sizeOf(utf8ByteLength(text), codePointLength(text));
}

function totalOf(sizes: readonly Size[]): Size {
  return sizeOf(
    sizes.reduce((sum, size) => sum + size.bytes, 0),
    sizes.reduce((sum, size) => sum + size.chars, 0),
  );
}

/** A file's size on disk, and the characters of what Cline receives from it. */
function receivedSize(artifact: Artifact, text: string): Size {
  return sizeOf(artifact.file.bytes.length, codePointLength(text));
}

/** A field as trimmed text, or undefined when it is absent or empty. */
function textField(fields: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = fields[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The file name without its last extension, as the SDK names a workflow. */
function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * True when an unlisted directory (trailing `/`, relative to the workspace) may hold files Cline
 * reads: `.clinerules` and `.cline` and anything below them, and `.claude` and `.agents` with
 * their `skills` folders. Dependency folders of plugins do not count: Cline skips them.
 */
function mayHoldConfig(local: string): boolean {
  const segments = local.split('/');
  if (segments.includes('node_modules')) return false;
  const [first, second] = segments;
  if (first === '.clinerules' || first === '.cline') return true;
  return (first === '.claude' || first === '.agents') && (second === '' || second === 'skills');
}

/** True for a plugin module the SDK would import: a `.js` or `.ts` file outside dot-folders. */
function isPluginModule(local: string): boolean {
  const segments = local.split('/').slice(2);
  if (segments.some((segment) => segment.startsWith('.') || segment === 'node_modules')) {
    return false;
  }
  return local.endsWith('.js') || local.endsWith('.ts');
}

/** The load plan of Cline for the workspace `options.cwd`. Pure and deterministic. */
export function loadCline(view: LoadView, options: ClineLoadOptions): LoadPlan {
  const { cwd } = options;
  const prefix = cwd === '' ? '' : `${cwd}/`;
  const inWorkspace = (path: string): boolean => path.startsWith(prefix);
  const local = (path: string): string => path.slice(prefix.length);

  const entries: LoadEntry[] = [];
  /** Startup group of each startup entry, by id. */
  const groups = new Map<string, number>();
  const skipped: SkippedLoad[] = [];
  const outOfScope: OutOfScope[] = [];
  const limits: LimitUsage[] = [];
  const incomplete = new Set<string>();

  const skip = (
    item: Omit<SkippedLoad, 'id' | 'certainty' | 'evidence'>,
    certainty: Certainty,
    evidence: readonly SourceKey[],
  ): void => {
    skipped.push({ id: `${item.role}:${item.path}`, ...item, certainty, evidence });
  };

  const startup = (entry: Omit<LoadEntry, 'trigger'>, group: number): void => {
    entries.push({ ...entry, trigger: 'startup' });
    groups.set(entry.id, group);
  };

  /**
   * A file Cline drops because it gets nothing from it: instr/empty-file reports it when it
   * judges the file's kind, as it judges every kind but a skill.
   */
  const blankSkip = (
    role: 'instructions' | 'rule' | 'command' | 'skill',
    path: string,
    artifact: Artifact,
    certainty: Certainty,
    evidence: readonly SourceKey[],
  ): void => {
    const reported = EMPTY_FILE_KINDS.has(artifact.kind);
    skip(
      {
        role,
        path,
        code: 'blank-file',
        ...(reported ? { ruleId: RULES.emptyFile } : {}),
        size: receivedSize(artifact, artifact.decoded.text),
      },
      certainty,
      evidence,
    );
  };

  /** True when Cline gets nothing from the file: blank, or blank after its frontmatter. */
  const isEmpty = (artifact: Artifact, frontmatter: FrontmatterResult): boolean =>
    clineBodyBlank(artifact.decoded.text, frontmatter);

  // ------------------------------------------------------------------------------------------
  // AGENTS.md
  // ------------------------------------------------------------------------------------------

  const agentsMd = (path: string, artifact: Artifact, caseMismatch: boolean): void => {
    const where = local(path);
    if (dirnamePosix(where) !== '') {
      // The SDK looks for AGENTS.md in the workspace folder only; the docs mention no other.
      skip(
        {
          role: 'instructions',
          path,
          code: 'not-read',
          size: receivedSize(artifact, artifact.decoded.text),
        },
        'source-code',
        ['clinePathsSource'],
      );
      return;
    }
    if (caseMismatch) {
      // The SDK opens `<workspace>/AGENTS.md`: case-sensitive file systems miss another spelling.
      const reported = artifact.kind === 'agents-md' && artifact.caseMismatch !== undefined;
      skip(
        {
          role: 'instructions',
          path,
          code: 'case-mismatch',
          ...(reported ? { ruleId: RULES.filenameCase } : {}),
          size: receivedSize(artifact, artifact.decoded.text),
        },
        'source-code',
        ['clinePathsSource'],
      );
      return;
    }
    const frontmatter = view.frontmatter(artifact);
    if (isEmpty(artifact, frontmatter)) {
      blankSkip('instructions', path, artifact, 'source-code', LOADER_EVIDENCE);
      return;
    }
    startup(
      {
        id: `instructions:${path}`,
        role: 'instructions',
        path,
        realPath: artifact.realPath,
        size: receivedSize(artifact, clineBody(artifact.decoded.text, frontmatter)),
        certainty: 'documented',
        evidence: ['clinePathsSource', 'clineRules'],
      },
      GROUP.agentsMd,
    );
  };

  // ------------------------------------------------------------------------------------------
  // Rules and workflows
  // ------------------------------------------------------------------------------------------

  /**
   * Folders between the workspace-relative path `where` and its rules or workflows folder, which
   * is `.clinerules`, `.cline/rules` or `<folder>/workflows`: 0 for a file directly in it.
   */
  const depthIn = (where: string, folder: string, role: 'rule' | 'workflow'): number =>
    where.split('/').length - (role === 'rule' && folder.toLowerCase() === '.clinerules' ? 2 : 3);

  const rule = (path: string, artifact: Artifact, folder: string): void => {
    const where = local(path);
    const whole = receivedSize(artifact, artifact.decoded.text);
    if (depthIn(where, folder, 'rule') > 0) {
      // Nested files never reach the model.
      skip({ role: 'rule', path, code: 'not-read', size: whole }, 'source-code', TOGGLE_EVIDENCE);
      return;
    }
    const clinerules = folder.toLowerCase() === '.clinerules';
    const evidence: readonly SourceKey[] = clinerules
      ? [...RULE_EVIDENCE, 'clineRulesSource']
      : RULE_EVIDENCE;
    const frontmatter = view.frontmatter(artifact);
    if (isEmpty(artifact, frontmatter)) {
      blankSkip('rule', path, artifact, 'source-code', LOADER_EVIDENCE);
      return;
    }
    const received = clineBody(artifact.decoded.text, frontmatter);
    if (frontmatter.kind === 'valid' && clineFlagTypeError(frontmatter.data.values) !== undefined) {
      // No rule judges a rule's frontmatter.
      skip(
        { role: 'rule', path, code: 'invalid-frontmatter', size: whole },
        'source-code',
        LOADER_EVIDENCE,
      );
      return;
    }
    if (clineDisabled(frontmatter)) {
      skip(
        { role: 'rule', path, code: 'disabled', size: receivedSize(artifact, received) },
        'source-code',
        TOGGLE_EVIDENCE,
      );
      return;
    }
    const activation = clineActivation(frontmatter);
    const certainty: Certainty = activation.documented ? 'documented' : 'unverified';
    if (activation.mode === 'never') {
      skip(
        { role: 'rule', path, code: 'never-active', size: receivedSize(artifact, received) },
        certainty,
        ['clineRules'],
      );
      return;
    }
    const trigger = TRIGGER_FOR_MODE[activation.mode];
    const entry: Omit<LoadEntry, 'trigger'> = {
      id: `rule:${path}`,
      role: 'rule',
      path,
      realPath: artifact.realPath,
      ...(trigger === 'on-path' ? { patterns: activation.paths } : {}),
      size: receivedSize(artifact, received),
      certainty,
      evidence,
    };
    if (trigger === 'startup') {
      startup(entry, clinerules ? GROUP.clinerules : GROUP.clineRules);
    } else {
      entries.push({ ...entry, trigger });
    }
  };

  const workflow = (path: string, artifact: Artifact, folder: string): void => {
    const where = local(path);
    const nested = depthIn(where, folder, 'workflow') > 0;
    const certainty: Certainty = nested ? 'unverified' : 'source-code';
    const parsed = clineRead(artifact.decoded.text, view.frontmatter(artifact), 'workflow');
    if (parsed.kind === 'unchecked') {
      incomplete.add(`unparsed:${path}`);
      return;
    }
    if (parsed.kind === 'skipped' && parsed.reason === 'no-body') {
      blankSkip('command', path, artifact, certainty, LOADER_EVIDENCE);
      return;
    }
    if (parsed.kind === 'skipped') {
      // No rule judges a workflow's frontmatter.
      skip(
        {
          role: 'command',
          path,
          code: 'invalid-frontmatter',
          size: receivedSize(artifact, artifact.decoded.text),
        },
        certainty,
        LOADER_EVIDENCE,
      );
      return;
    }
    if (clineDisabled(view.frontmatter(artifact))) {
      skip(
        { role: 'command', path, code: 'disabled', size: receivedSize(artifact, parsed.body) },
        certainty,
        TOGGLE_EVIDENCE,
      );
      return;
    }
    entries.push({
      id: `command:${path}`,
      role: 'command',
      trigger: 'manual',
      path,
      realPath: artifact.realPath,
      // Without `name`, the SDK names a workflow after its file.
      name: textField(parsed.fields, 'name') ?? stem(basename(path)),
      size: receivedSize(artifact, parsed.body),
      certainty,
      evidence: ['clineInstructionLoaderSource', 'clinePathsSource'],
    });
  };

  // ------------------------------------------------------------------------------------------
  // .cursorrules and .windsurfrules
  // ------------------------------------------------------------------------------------------

  const legacy = (path: string, artifact: Artifact): void => {
    const where = local(path);
    if (dirnamePosix(where) !== '') {
      outOfScope.push({ path, because: 'below-start-dir' });
      return;
    }
    const file = Object.hasOwn(LEGACY_FILES, where) ? LEGACY_FILES[where] : undefined;
    if (file === undefined) {
      // Another letter case: the extension opens the exact name.
      skip(
        {
          role: 'instructions',
          path,
          code: 'not-read',
          size: receivedSize(artifact, artifact.decoded.text),
        },
        'unverified',
        ['clineRules'],
      );
      return;
    }
    if (isBlank(artifact.decoded.text)) {
      // How the extension treats a blank file of another agent is not documented.
      blankSkip('instructions', path, artifact, 'unverified', ['clineRules']);
      return;
    }
    startup(
      {
        id: `instructions:${path}`,
        role: 'instructions',
        path,
        realPath: artifact.realPath,
        size: receivedSize(artifact, artifact.decoded.text),
        certainty: 'documented',
        evidence: ['clineRules'],
      },
      file.group,
    );
  };

  // ------------------------------------------------------------------------------------------
  // Skills
  // ------------------------------------------------------------------------------------------

  const skill = (path: string, artifact: Artifact, caseMismatch: boolean): void => {
    const location = skillLocation(path, caseMismatch);
    if (location === undefined) return;
    const owner = dirnamePosix(dirnamePosix(location.root));
    const segment = location.root.slice(owner === '' ? 0 : owner.length + 1);
    if (!SKILL_SEGMENTS.has(segment) || !inWorkspace(location.root)) return;
    if (owner !== cwd) {
      outOfScope.push({ path, because: 'below-start-dir' });
      return;
    }
    const base = { id: `skill:${path}`, role: 'skill', path } as const;
    const whole = receivedSize(artifact, artifact.decoded.text);
    // Cline reads `<root>/SKILL.md` and `<root>/<folder>/SKILL.md`, by that exact name, both
    // when the root has a SKILL.md of its own.
    if (!location.platforms.has('cline') || basename(path) !== 'SKILL.md') {
      if (isBundledSkill(view.snapshot, artifact.path) || inPayloadFolder(artifact.path)) {
        outOfScope.push({ path, because: 'payload-folder' });
      } else {
        skip({ ...base, code: 'not-read', size: whole }, 'source-code', LOADER_EVIDENCE);
      }
      return;
    }
    const parsed = clineRead(artifact.decoded.text, view.frontmatter(artifact), 'skill');
    if (parsed.kind === 'unchecked') {
      incomplete.add(`unparsed:${path}`);
      return;
    }
    if (parsed.kind === 'skipped' && parsed.reason === 'no-body') {
      blankSkip('skill', path, artifact, 'source-code', LOADER_EVIDENCE);
      return;
    }
    if (parsed.kind === 'skipped') {
      // The skill rules leave alone a skill bundled in another one or in a template or example
      // folder, so no rule reports why Cline drops it.
      const judged =
        !isBundledSkill(view.snapshot, artifact.path) && !inPayloadFolder(artifact.path);
      const ruleId = judged ? CLINE_SKIP_RULE[parsed.reason] : undefined;
      skip(
        {
          ...base,
          code: 'invalid-frontmatter',
          ...(ruleId === undefined ? {} : { ruleId }),
          size: whole,
        },
        'source-code',
        LOADER_EVIDENCE,
      );
      return;
    }
    if (clineDisabled(view.frontmatter(artifact))) {
      // A disabled skill is left out of the listing, and using it is an error.
      skip({ ...base, code: 'disabled', size: whole }, 'source-code', TOGGLE_EVIDENCE);
      return;
    }
    const { body, fields } = parsed;
    // Without `name`, the SDK names the skill after its folder.
    const name = textField(fields, 'name') ?? basename(dirnamePosix(path));
    const description = textField(fields, 'description');
    // The listing: name and description. The exact text Cline shows the model is not documented.
    const listing = description === undefined ? name : `${name}\n${description}`;
    if (description !== undefined) {
      limits.push({
        key: 'cline.skill_description',
        unit: 'chars',
        limit: CLINE_SKILL_DESCRIPTION_CHARS,
        used: codePointLength(description),
        subject: path,
        effect: 'advice',
        evidence: ['clineSkills'],
      });
    }
    // `.cline/skills` and the `<name>/SKILL.md` layout are documented, the other roots are in
    // the source; the docs require a description, the SDK lists a skill without one.
    const documented =
      segment === '.cline/skills' && location.relative.includes('/') && description !== undefined;
    startup(
      {
        ...base,
        realPath: artifact.realPath,
        name,
        size: textSize(listing),
        deferred: textSize(body),
        certainty: documented
          ? 'documented'
          : description === undefined
            ? 'unverified'
            : 'source-code',
        evidence: ['clinePathsSource', 'clineSkills'],
      },
      GROUP.skills,
    );
  };

  // ------------------------------------------------------------------------------------------
  // Dispatch over every path that reaches an artifact
  // ------------------------------------------------------------------------------------------

  /** `kind` is the classification of `path`, undefined for an alias the classifier skips. */
  const visit = (
    path: string,
    artifact: Artifact,
    kind: ArtifactKind | undefined,
    caseMismatch: boolean,
  ): void => {
    const where = local(path);
    const place = clinePlace(where);
    // A file in a rules or workflows folder is a rule or workflow, whatever its name.
    if (
      place !== undefined &&
      (place.role === 'rule' || place.role === 'workflow') &&
      isClineRuleFile(basename(where))
    ) {
      if (place.root !== '') {
        outOfScope.push({ path, because: 'below-start-dir' });
      } else if (place.role === 'rule') {
        rule(path, artifact, place.folder);
      } else {
        workflow(path, artifact, place.folder);
      }
      return;
    }
    if (kind === 'agents-md') agentsMd(path, artifact, caseMismatch);
    else if (kind === 'cursor-legacy-rules' || kind === 'windsurf-legacy-rules')
      legacy(path, artifact);
    else if (kind === 'skill') skill(path, artifact, caseMismatch);
  };

  for (const artifact of view.artifacts) {
    if (inWorkspace(artifact.path)) {
      visit(artifact.path, artifact, artifact.kind, artifact.caseMismatch !== undefined);
    }
    for (const alias of artifact.aliases) {
      if (!inWorkspace(alias)) continue;
      // An alias is what Cline sees at that path, so its own name decides its role.
      const classification = classify(alias);
      visit(alias, artifact, classification?.kind, classification?.caseMismatch !== undefined);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Files Cline would read that agentcheckup did not, and hooks it cannot analyze
  // ------------------------------------------------------------------------------------------

  const wouldRead = (path: string, where: string): boolean => {
    if (where === 'AGENTS.md' || where === '.clinerules' || Object.hasOwn(LEGACY_FILES, where)) {
      return true;
    }
    const place = clinePlace(where);
    if (place?.root === '' && (place.role === 'rule' || place.role === 'workflow')) {
      // Cline never reads a rule file in a subfolder.
      const nested = place.role === 'rule' && depthIn(where, place.folder, 'rule') > 0;
      return !nested && isClineRuleFile(basename(where));
    }
    if (basename(where) !== 'SKILL.md') return false;
    const location = skillLocation(path);
    return (
      location?.platforms.has('cline') === true && dirnamePosix(dirnamePosix(location.root)) === cwd
    );
  };

  const { snapshot } = view;
  const files = new Set<string>(snapshot.ignoredFiles);
  for (const path of snapshot.paths) if (!path.endsWith('/')) files.add(path);
  for (const entry of snapshot.skipped) files.add(entry.path);
  for (const path of files) {
    if (!inWorkspace(path)) continue;
    const where = local(path);
    const place = clinePlace(where);
    // Hook scripts and plugin modules have no documented format to analyze.
    if (
      place?.root === '' &&
      (place.role === 'hook' || (place.role === 'plugin' && isPluginModule(where)))
    ) {
      incomplete.add(`unparsed:${path}`);
      continue;
    }
    if (!view.index.has(path) && wouldRead(path, where)) incomplete.add(`unread:${path}`);
  }
  for (const directory of snapshot.opaqueDirectories) {
    if (inWorkspace(directory) && mayHoldConfig(local(directory))) {
      incomplete.add(`unread:${directory}`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Assembly
  // ------------------------------------------------------------------------------------------

  const startupOrder = entries
    .filter((entry) => entry.trigger === 'startup')
    .sort(
      (a, b) =>
        (groups.get(a.id) ?? 0) - (groups.get(b.id) ?? 0) ||
        compareStrings(a.path, b.path) ||
        compareStrings(a.id, b.id),
    );
  const positions = new Map(startupOrder.map((entry, index) => [entry.id, index + 1]));
  const placed = entries
    .map((entry) => {
      const position = positions.get(entry.id);
      return position === undefined ? entry : { ...entry, position };
    })
    .sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
        TRIGGER_RANK[a.trigger] - TRIGGER_RANK[b.trigger] ||
        compareStrings(a.path, b.path) ||
        compareStrings(a.id, b.id),
    );

  const startupSizes = startupOrder.flatMap((entry) =>
    entry.size === undefined ? [] : [entry.size],
  );
  const onDemandSizes = placed.flatMap((entry) => {
    if (entry.trigger === 'startup') return entry.deferred === undefined ? [] : [entry.deferred];
    return entry.size === undefined ? [] : [entry.size];
  });

  return {
    agent: 'cline',
    cwd,
    entries: placed,
    skipped: skipped.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.id, b.id)),
    outOfScope: outOfScope.sort(
      (a, b) => compareStrings(a.path, b.path) || compareStrings(a.because, b.because),
    ),
    assumptions: [...ASSUMPTIONS].sort((a, b) => compareStrings(a.key, b.key)),
    hidden: HIDDEN,
    limits: limits.sort(
      (a, b) => compareStrings(a.key, b.key) || compareStrings(a.subject, b.subject),
    ),
    totals: { startup: totalOf(startupSizes), onDemand: totalOf(onDemandSizes) },
    incomplete: [...incomplete].sort(compareStrings),
  };
}
