/**
 * What Cline loads for a workspace, from docs/platforms.md ("Cline") and the Cline source read at
 * the released versions: the VS Code extension v4.1.26, which since 4.1.0 is built on the SDK, the
 * CLI v3.0.74 and the SDK v0.2.0 (src/platforms/sources.ts). The plan models the VS Code
 * extension (`cline.surface`) and treats `cwd` as the workspace folder opened in VS Code: Cline
 * reads project configuration from that folder only, so files outside it do not appear and files
 * in deeper folders are left to a session opened there (`below-start-dir`). Where the
 * documentation and the released source disagree, the plan follows the source and says so in an
 * assumption.
 *
 * Rules. The SDK reads, in this order (SOURCES.clinePathsSource): the workspace's AGENTS.md, the
 * files directly in `.clinerules/` (or a legacy `.clinerules` file), the files directly in
 * `.cline/rules/`, and the `rules.md` of each managed plugin folder of `.cline/`
 * (`clinePlace`, shared with the classifier). Each rule is named by its frontmatter `name`, else
 * its file name without the extension, and the workspace's AGENTS.md is "Workspace AGENTS.md". A
 * later rule replaces an earlier one with the same name in any letter case
 * (SOURCES.clineConfigWatcherSource): the earlier file is `shadowed-by-preferred`. Which of two
 * such files in the same folder wins depends on the order the file system lists them, so that
 * case is unverified. The system prompt then gets every rule that is not disabled, sorted by name
 * (SOURCES.clineRuleSelectionSource); startup positions follow that order, comparing names
 * without regard to letter case, as `localeCompare` does for names of letters and digits.
 *
 * The documentation says a rule with `paths` applies only to files its globs match and
 * `paths: []` to none, and that a rule whose YAML does not parse loads whole. The released code
 * reads neither: a rule with `paths` loads at startup (`cline.rule_paths`), and the SDK drops a
 * rule whose frontmatter does not parse, has no body, or has a `name`, `disabled` or `enabled` of
 * the wrong type (src/platforms/cline-skills.ts, shared with the skill rules). A rule whose
 * frontmatter turns it off (`disabled`, `clineDisabled`) still replaces an earlier one with its
 * name. Files in subfolders of a rules folder are `not-read`. `.cursorrules` and `.windsurfrules`,
 * which the documentation lists, are `not-read`: no released code reads them.
 *
 * Skills: a SKILL.md in `.clinerules/skills`, `.cline/skills`, `.claude/skills` or
 * `.agents/skills`, in the root or in one folder of it (src/platforms/skills.ts), and in the
 * `skills/` folder of a managed plugin. The listing is in the prompt at startup, after the rules;
 * the body loads when the model uses the skill.
 *
 * Workflows in `.clinerules/workflows/`, `.cline/workflows/` and the `workflows/` folder of a
 * managed plugin run as commands (`manual`). The SDK drops one without a body, whose frontmatter
 * does not parse, or with a field of the wrong type, and does not load one whose frontmatter
 * turns it off. A managed plugin folder counts only when it holds a `managed.json`, and Cline also
 * skips one whose manifest is not a JSON object or list, which the scan cannot tell: its files are
 * unverified.
 *
 * Hooks (src/platforms/cline-hooks.ts, shared with the security inventory): the extension runs
 * `.clinerules/hooks/<Event>` (macOS and Linux, when executable) and `<Event>.ps1` (Windows) for
 * six events. A hook file only the CLI runs, in `.cline/hooks/` or with another name, or one for
 * an event the extension does not run, is `not-read`. JavaScript or TypeScript plugins in
 * `.cline/plugins/` are not analyzed: the plan lists them as incomplete. Cline reads no MCP server
 * file from the repository.
 *
 * Cline reads `.markdown` and `.txt` rules and the extensionless `.clinerules` file, which the
 * scan does not read: they are listed as `unread:`.
 */
import { compareStrings } from '../../core/compare.js';
import type { ResolvedConfig } from '../../core/config.js';
import { codePointLength, tokensOf, utf8ByteLength } from '../../core/measure.js';
import { dirnamePosix } from '../../core/paths.js';
import type { Artifact, ArtifactKind, Snapshot } from '../../core/types.js';
import { classify } from '../classify.js';
import { clineHookFile } from '../cline-hooks.js';
import {
  CLINE_MANAGED_MANIFEST,
  clineDisabled,
  type ClinePlace,
  clinePlace,
  clineRuleHasPaths,
  isClineRuleFile,
} from '../cline-rules.js';
import { clineBody, CLINE_SKIP_RULE, clineRead } from '../cline-skills.js';
import { clineHookInventoryId } from '../inventory-ids.js';
import { EMPTY_FILE_KINDS } from '../kinds.js';
import { isBundledSkill } from '../location.js';
import { basename, inPayloadFolder } from '../paths.js';
import { SKILL_ROOTS, skillLocation } from '../skills.js';
import type {
  Assumption,
  Certainty,
  HiddenScope,
  LimitUsage,
  LoadEntry,
  LoadPlan,
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
  // The VS Code extension. The CLI reads rules, workflows and skills through the same SDK code,
  // but runs other hook files: also those in `.cline/hooks/`, in any letter case and with an
  // extension, and also for TaskResume, TaskError and SessionShutdown.
  {
    key: 'cline.surface',
    value: 'vscode',
    origin: 'default',
    evidence: [
      'clinePathsSource',
      'clineRulesSource',
      'clineVscodeHooksSource',
      'clineHookFileSource',
    ],
  },
  {
    key: 'cline.version',
    value: '4.1.26',
    origin: 'default',
    evidence: ['clineRuleSelectionSource'],
  },
];

/** Stated when a rule sets `paths`: the documentation scopes it, the released code does not. */
const RULE_PATHS: Assumption = {
  key: 'cline.rule_paths',
  value: 'ignored',
  origin: 'default',
  evidence: ['clineRuleSelectionSource', 'clineRules'],
};

/** Stated when the plan lists a hook: what the extension needs to run it. */
const HOOK_ASSUMPTIONS: readonly Assumption[] = [
  {
    key: 'cline.hooks_enabled',
    value: true,
    origin: 'default',
    evidence: ['clineVscodeHooksSource'],
  },
  {
    key: 'cline.hook_file_executable',
    value: true,
    origin: 'assumed',
    evidence: ['clineVscodeHooksSource'],
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

/** Startup groups in prompt order: the rules section, then the skills listing. */
const GROUP = { rules: 0, skills: 1 } as const;

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
const SHADOW_EVIDENCE: readonly SourceKey[] = ['clineConfigWatcherSource', 'clinePathsSource'];
const HOOK_EVIDENCE: readonly SourceKey[] = [
  'clineVscodeHooksSource',
  'clineVscodeHookEventsSource',
];

/** The rule name of the workspace's AGENTS.md (`resolveRuleFallbackName`). */
const WORKSPACE_AGENTS_MD = 'Workspace AGENTS.md';

/**
 * Where a rule comes from, in the SDK's search order: a later source replaces an earlier rule
 * with the same name.
 */
const RULE_SOURCE = { agentsMd: 0, clinerules: 1, clineRules: 2, managed: 3 } as const;

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

/** The file name without its last extension, as the SDK names a workflow or rule. */
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

const CANDIDATES = new WeakMap<Snapshot, readonly string[]>();

/**
 * The files of the scan, read or not, that the loop over unread files in `loadCline` may act on,
 * in its order: those named AGENTS.md, SKILL.md or `.clinerules`, and those with `.cline` anywhere
 * in their path, in any letter case (`clinePlace` needs a `.cline` or `.clinerules` folder). Found
 * once per scan for the plans of every working directory.
 */
function clineCandidates(snapshot: Snapshot): readonly string[] {
  const cached = CANDIDATES.get(snapshot);
  if (cached !== undefined) return cached;
  const files = new Set<string>(snapshot.ignoredFiles);
  for (const path of snapshot.paths) if (!path.endsWith('/')) files.add(path);
  for (const entry of snapshot.skipped) files.add(entry.path);
  const candidates: string[] = [];
  for (const path of files) {
    const name = basename(path);
    if (
      name === 'AGENTS.md' ||
      name === 'SKILL.md' ||
      name === '.clinerules' ||
      path.toLowerCase().includes('.cline')
    ) {
      candidates.push(path);
    }
  }
  CANDIDATES.set(snapshot, candidates);
  return candidates;
}

/** A rule file that Cline parses, before rules with the same name replace each other. */
interface RuleCandidate {
  readonly entry: Omit<LoadEntry, 'trigger'>;
  /** The rule's name, as the prompt shows it. */
  readonly name: string;
  /** {@link RULE_SOURCE} of its folder. */
  readonly source: number;
  readonly disabled: boolean;
}

/** The load plan of Cline for the workspace `options.cwd`. Pure and deterministic. */
export function loadCline(view: LoadView, options: ClineLoadOptions): LoadPlan {
  const { cwd } = options;
  const prefix = cwd === '' ? '' : `${cwd}/`;
  const inWorkspace = (path: string): boolean => path.startsWith(prefix);
  const local = (path: string): string => path.slice(prefix.length);
  const { snapshot } = view;

  const entries: LoadEntry[] = [];
  /**
   * Startup group and sort key of each startup entry, by id: a rule's name without regard to
   * letter case, then as written; a skill's path.
   */
  const order = new Map<
    string,
    { readonly group: number; readonly key: string; readonly tie: string }
  >();
  const skipped: SkippedLoad[] = [];
  const outOfScope: OutOfScope[] = [];
  const limits: LimitUsage[] = [];
  const incomplete = new Set<string>();
  const rules: RuleCandidate[] = [];
  /** What the plan must state: a rule sets `paths`, or a hook file runs. */
  const stated = { rulePaths: false, hooks: false };

  const skip = (
    item: Omit<SkippedLoad, 'id' | 'certainty' | 'evidence'>,
    certainty: Certainty,
    evidence: readonly SourceKey[],
  ): void => {
    skipped.push({ id: `${item.role}:${item.path}`, ...item, certainty, evidence });
  };

  const startup = (
    entry: Omit<LoadEntry, 'trigger'>,
    group: number,
    key: string,
    tie = '',
  ): void => {
    entries.push({ ...entry, trigger: 'startup' });
    order.set(entry.id, { group, key, tie });
  };

  /** False for a file of a managed plugin folder that holds no `managed.json`. */
  const active = (place: ClinePlace): boolean =>
    place.plugin === undefined ||
    snapshot.paths.has(`${prefix}${place.plugin}/${CLINE_MANAGED_MANIFEST}`);

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

  // ------------------------------------------------------------------------------------------
  // Rules: AGENTS.md and rule files
  // ------------------------------------------------------------------------------------------

  /**
   * A rule file as the SDK parses it (`parseRuleConfigFromMarkdown`): dropped, or a candidate for
   * the rules section under its name.
   */
  const ruleFile = (
    role: 'instructions' | 'rule',
    path: string,
    artifact: Artifact,
    where: {
      readonly source: number;
      readonly fallback: string;
      readonly certainty: Certainty;
      readonly evidence: readonly SourceKey[];
    },
  ): void => {
    const frontmatter = view.frontmatter(artifact);
    const whole = receivedSize(artifact, artifact.decoded.text);
    const read = clineRead(artifact.decoded.text, frontmatter, 'rule');
    const certainty: Certainty = where.certainty === 'unverified' ? 'unverified' : 'source-code';
    if (read.kind === 'unchecked') {
      incomplete.add(`unparsed:${path}`);
      return;
    }
    if (read.kind === 'skipped' && read.reason === 'no-body') {
      blankSkip(role, path, artifact, certainty, LOADER_EVIDENCE);
      return;
    }
    if (read.kind === 'skipped') {
      // No rule judges a rule's frontmatter.
      skip({ role, path, code: 'invalid-frontmatter', size: whole }, certainty, LOADER_EVIDENCE);
      return;
    }
    const name = textField(read.fields, 'name') ?? where.fallback.trim();
    if (name === '') {
      // The SDK throws on a rule without a name, which only a blank file name gives.
      skip({ role, path, code: 'not-read', size: whole }, certainty, LOADER_EVIDENCE);
      return;
    }
    const scoped = clineRuleHasPaths(frontmatter);
    if (scoped) stated.rulePaths = true;
    rules.push({
      entry: {
        id: `${role}:${path}`,
        role,
        path,
        realPath: artifact.realPath,
        size: receivedSize(artifact, clineBody(artifact.decoded.text, frontmatter)),
        // The documentation scopes a rule with `paths`; the released code loads it always.
        certainty: scoped && where.certainty === 'documented' ? 'source-code' : where.certainty,
        evidence: scoped ? [...where.evidence, 'clineRuleSelectionSource'] : where.evidence,
      },
      name,
      source: where.source,
      disabled: clineDisabled(frontmatter),
    });
  };

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
    ruleFile('instructions', path, artifact, {
      source: RULE_SOURCE.agentsMd,
      fallback: WORKSPACE_AGENTS_MD,
      certainty: 'documented',
      evidence: ['clinePathsSource', 'clineRules'],
    });
  };

  /**
   * Folders between the workspace-relative path `where` and its rules or workflows folder, which
   * is `.clinerules`, `.cline/rules` or `<folder>/workflows`: 0 for a file directly in it. A
   * managed plugin's files are always directly in theirs (clinePlace).
   */
  const depthIn = (where: string, place: ClinePlace): number => {
    if (place.plugin !== undefined) return 0;
    const clinerules = place.role === 'rule' && place.folder.toLowerCase() === '.clinerules';
    return where.split('/').length - (clinerules ? 2 : 3);
  };

  const rule = (path: string, artifact: Artifact, place: ClinePlace): void => {
    const where = local(path);
    if (depthIn(where, place) > 0) {
      // Nested files never reach the model.
      const whole = receivedSize(artifact, artifact.decoded.text);
      skip({ role: 'rule', path, code: 'not-read', size: whole }, 'source-code', TOGGLE_EVIDENCE);
      return;
    }
    const managed = place.plugin !== undefined;
    const clinerules = !managed && place.folder.toLowerCase() === '.clinerules';
    ruleFile('rule', path, artifact, {
      source: managed
        ? RULE_SOURCE.managed
        : clinerules
          ? RULE_SOURCE.clinerules
          : RULE_SOURCE.clineRules,
      fallback: stem(basename(path)),
      certainty: managed ? 'unverified' : 'documented',
      evidence: managed
        ? LOADER_EVIDENCE
        : clinerules
          ? [...RULE_EVIDENCE, 'clineRulesSource']
          : RULE_EVIDENCE,
    });
  };

  /**
   * The rules section: of the rules with one name, in any letter case, the last in search order
   * wins; then every one that is not disabled, sorted by name.
   */
  const ruleSection = (): void => {
    const byId = new Map<string, RuleCandidate[]>();
    for (const candidate of rules) {
      const id = candidate.name.toLowerCase();
      const list = byId.get(id) ?? [];
      list.push(candidate);
      byId.set(id, list);
    }
    for (const list of byId.values()) {
      list.sort((a, b) => a.source - b.source || compareStrings(a.entry.path, b.entry.path));
      const winner = list[list.length - 1];
      if (winner === undefined) continue;
      // Two of them from one source: the order the file system lists a folder in, or the order of
      // plugin folders (`localeCompare`), decides, which the plan cannot know.
      const tied = list.some((other) => other !== winner && other.source === winner.source);
      for (const other of list) {
        if (other === winner) continue;
        skip(
          {
            role: other.entry.role,
            path: other.entry.path,
            code: 'shadowed-by-preferred',
            ...(other.entry.size === undefined ? {} : { size: other.entry.size }),
          },
          other.source === winner.source ? 'unverified' : 'source-code',
          SHADOW_EVIDENCE,
        );
      }
      const certainty: Certainty = tied ? 'unverified' : winner.entry.certainty;
      if (winner.disabled) {
        skip(
          {
            role: winner.entry.role,
            path: winner.entry.path,
            code: 'disabled',
            ...(winner.entry.size === undefined ? {} : { size: winner.entry.size }),
          },
          tied ? 'unverified' : 'source-code',
          TOGGLE_EVIDENCE,
        );
        continue;
      }
      startup({ ...winner.entry, certainty }, GROUP.rules, winner.name.toLowerCase(), winner.name);
    }
  };

  // ------------------------------------------------------------------------------------------
  // Workflows
  // ------------------------------------------------------------------------------------------

  const workflow = (path: string, artifact: Artifact, place: ClinePlace): void => {
    const where = local(path);
    const nested = depthIn(where, place) > 0;
    const certainty: Certainty =
      nested || place.plugin !== undefined ? 'unverified' : 'source-code';
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
    if (dirnamePosix(local(path)) !== '') {
      outOfScope.push({ path, because: 'below-start-dir' });
      return;
    }
    // The documentation lists them; the released extension and CLI never open them.
    skip(
      {
        role: 'instructions',
        path,
        code: 'not-read',
        size: receivedSize(artifact, artifact.decoded.text),
      },
      'source-code',
      ['clinePathsSource', 'clineRules'],
    );
  };

  // ------------------------------------------------------------------------------------------
  // Skills
  // ------------------------------------------------------------------------------------------

  /** A SKILL.md Cline lists, or drops for its content. `managed` for one of a managed plugin. */
  const listSkill = (
    path: string,
    artifact: Artifact,
    managed: boolean,
    certaintyOf: (description: string | undefined) => Certainty,
  ): void => {
    const base = { id: `skill:${path}`, role: 'skill', path } as const;
    const whole = receivedSize(artifact, artifact.decoded.text);
    const parsed = clineRead(artifact.decoded.text, view.frontmatter(artifact), 'skill');
    const certain: Certainty = managed ? 'unverified' : 'source-code';
    if (parsed.kind === 'unchecked') {
      incomplete.add(`unparsed:${path}`);
      return;
    }
    if (parsed.kind === 'skipped' && parsed.reason === 'no-body') {
      blankSkip('skill', path, artifact, certain, LOADER_EVIDENCE);
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
        certain,
        LOADER_EVIDENCE,
      );
      return;
    }
    if (clineDisabled(view.frontmatter(artifact))) {
      // A disabled skill is left out of the listing, and using it is an error.
      skip({ ...base, code: 'disabled', size: whole }, certain, TOGGLE_EVIDENCE);
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
    startup(
      {
        ...base,
        realPath: artifact.realPath,
        name,
        size: textSize(listing),
        deferred: textSize(body),
        certainty: certaintyOf(description),
        evidence: ['clinePathsSource', 'clineSkills'],
      },
      GROUP.skills,
      path,
    );
  };

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
    // Cline reads `<root>/SKILL.md` and `<root>/<folder>/SKILL.md`, by that exact name, both
    // when the root has a SKILL.md of its own.
    if (!location.platforms.has('cline') || basename(path) !== 'SKILL.md') {
      if (isBundledSkill(view.snapshot, artifact.path) || inPayloadFolder(artifact.path)) {
        outOfScope.push({ path, because: 'payload-folder' });
      } else {
        const whole = receivedSize(artifact, artifact.decoded.text);
        skip(
          { role: 'skill', path, code: 'not-read', size: whole },
          'source-code',
          LOADER_EVIDENCE,
        );
      }
      return;
    }
    // `.cline/skills` and the `<name>/SKILL.md` layout are documented, the other roots are in
    // the source; the docs require a description, the SDK lists a skill without one.
    listSkill(path, artifact, false, (description) =>
      description === undefined
        ? 'unverified'
        : segment === '.cline/skills' && location.relative.includes('/')
          ? 'documented'
          : 'source-code',
    );
  };

  /**
   * A SKILL.md in the `skills/` folder of a managed plugin: Cline reads `skills/SKILL.md` and
   * `skills/<folder>/SKILL.md` (`discoverSkillFiles`). Unverified, as every file of a managed
   * plugin is.
   */
  const managedSkill = (path: string, artifact: Artifact, place: ClinePlace): void => {
    const below = local(path)
      .slice((place.plugin ?? '').length + '/skills/'.length)
      .split('/');
    if (below.length > 2 || below[below.length - 1] !== 'SKILL.md') return;
    listSkill(path, artifact, true, () => 'unverified');
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
    const found = clinePlace(where);
    const place = found !== undefined && active(found) ? found : undefined;
    // A file in a rules or workflows folder is a rule or workflow, whatever its name.
    if (
      place !== undefined &&
      (place.role === 'rule' || place.role === 'workflow') &&
      isClineRuleFile(basename(where))
    ) {
      if (place.root !== '') {
        outOfScope.push({ path, because: 'below-start-dir' });
      } else if (place.role === 'rule') {
        rule(path, artifact, place);
      } else {
        workflow(path, artifact, place);
      }
      return;
    }
    if (place?.role === 'skill' && place.plugin !== undefined) {
      if (place.root !== '') outOfScope.push({ path, because: 'below-start-dir' });
      else if (kind === 'skill') managedSkill(path, artifact, place);
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
  ruleSection();

  // ------------------------------------------------------------------------------------------
  // Hook files, files Cline would read that agentcheckup did not, and plugins it cannot analyze
  // ------------------------------------------------------------------------------------------

  const wouldRead = (path: string, where: string): boolean => {
    if (where === 'AGENTS.md' || where === '.clinerules') return true;
    const found = clinePlace(where);
    const place = found !== undefined && active(found) ? found : undefined;
    if (place?.root === '' && (place.role === 'rule' || place.role === 'workflow')) {
      // Cline never reads a rule file in a subfolder.
      const nested = place.role === 'rule' && depthIn(where, place) > 0;
      return !nested && isClineRuleFile(basename(where));
    }
    if (basename(where) !== 'SKILL.md') return false;
    if (place?.root === '' && place.role === 'skill' && place.plugin !== undefined) return true;
    const location = skillLocation(path);
    return (
      location?.platforms.has('cline') === true && dirnamePosix(dirnamePosix(location.root)) === cwd
    );
  };

  /** A hook file: the extension runs it, or it is one only the CLI runs. */
  const hookFile = (path: string, where: string): boolean => {
    const hook = clineHookFile(where);
    if (hook === undefined) return false;
    const base = { role: 'hook', path, name: hook.event } as const;
    if (hook.vscode === undefined || !hook.vscodeEvent) {
      skip(
        { ...base, code: 'not-read' },
        'source-code',
        hook.vscode === undefined ? ['clineVscodeHooksSource'] : ['clineVscodeHookEventsSource'],
      );
      return true;
    }
    stated.hooks = true;
    // The inventory lists a hook file it read, under the path in the hooks folder.
    const file = snapshot.files.find((candidate) => candidate.path === path);
    entries.push({
      id: `hook:${path}#${hook.event}`,
      role: 'hook',
      trigger: 'startup',
      path,
      realPath: file?.symlinkTarget ?? path,
      name: hook.event,
      ...(file === undefined ? {} : { inventoryId: clineHookInventoryId(path, hook.event) }),
      certainty: 'source-code',
      evidence: HOOK_EVIDENCE,
    });
    return true;
  };

  for (const path of clineCandidates(snapshot)) {
    if (!inWorkspace(path)) continue;
    const where = local(path);
    const place = clinePlace(where);
    if (place?.root === '' && place.role === 'hook') {
      hookFile(path, where);
      continue;
    }
    // Plugin modules have no documented format to analyze.
    if (place?.root === '' && place.role === 'plugin' && isPluginModule(where)) {
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

  const NO_KEY = { group: 0, key: '', tie: '' } as const;
  const startupOrder = entries
    .filter((entry) => order.has(entry.id))
    .sort((a, b) => {
      const x = order.get(a.id) ?? NO_KEY;
      const y = order.get(b.id) ?? NO_KEY;
      return (
        x.group - y.group ||
        compareStrings(x.key, y.key) ||
        compareStrings(x.tie, y.tie) ||
        compareStrings(a.path, b.path) ||
        compareStrings(a.id, b.id)
      );
    });
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

  const assumptions = [
    ...ASSUMPTIONS,
    ...(stated.rulePaths ? [RULE_PATHS] : []),
    ...(stated.hooks ? HOOK_ASSUMPTIONS : []),
  ];
  return {
    agent: 'cline',
    cwd,
    entries: placed,
    skipped: skipped.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.id, b.id)),
    outOfScope: outOfScope.sort(
      (a, b) => compareStrings(a.path, b.path) || compareStrings(a.because, b.because),
    ),
    assumptions: assumptions.sort((a, b) => compareStrings(a.key, b.key)),
    hidden: HIDDEN,
    limits: limits.sort(
      (a, b) => compareStrings(a.key, b.key) || compareStrings(a.subject, b.subject),
    ),
    totals: { startup: totalOf(startupSizes), onDemand: totalOf(onDemandSizes) },
    incomplete: [...incomplete].sort(compareStrings),
  };
}
