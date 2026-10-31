/**
 * What Codex loads for a session started in one directory, mirrored from the Codex documentation
 * and source (docs/platforms.md, "Codex"):
 *
 * - Instructions: one file per directory from the project root (nearest `.git`) down to the
 *   working directory, `AGENTS.override.md` before `AGENTS.md`, within `project_doc_max_bytes`
 *   across the chain. {@link codexChain} models the choice and the budget; instr/codex-size-budget,
 *   instr/override-shadows-agents-md and instr/empty-file report the same files.
 * - Skills: every `SKILL.md` under `.agents/skills` in each directory from the working directory up
 *   to the project root, at any depth, listed with name, description and path at session start.
 *   The source also scans `.codex/skills` in project config folders; which folders count is
 *   unverified. The functions in src/platforms/codex-skills.ts decide whether Codex skips a skill,
 *   and the skill rules use the same functions.
 * - Hooks: `.codex/hooks.json` handlers and inline `[hooks]` in `.codex/config.toml` run after the
 *   user trusts them in `/hooks`; `features.hooks = false` turns them off.
 * - `.codex/config.toml`: one layer per directory of the chain, the closest winning
 *   (../codex-config.ts). Its MCP servers start with the session in a trusted project unless
 *   `enabled = false`; its `project_doc_max_bytes` and `project_doc_fallback_filenames` shape the
 *   AGENTS.md chain. A layer that is not valid TOML stops Codex at startup; the plan skips it.
 *
 * Pure: reads only the view, never the file system. Every list in the plan is sorted.
 */
import { compareStrings } from '../../core/compare.js';
import type { ResolvedConfig } from '../../core/config.js';
import { codePointLength, tokensOf, utf8ByteLength } from '../../core/measure.js';
import { dirnamePosix, normalizeRelative, pathStatus } from '../../core/paths.js';
import { positionAt } from '../../core/text.js';
import type { Artifact } from '../../core/types.js';
import { parseFrontmatter } from '../../parse/frontmatter.js';
import { issueKind, type ParsedJson } from '../../parse/json-access.js';
import type { FrontmatterData } from '../../parse/types.js';
import {
  CODEX_CONFIG_FILE,
  type CodexConfigLayer,
  codexHooksSetting,
  type CodexProjectConfig,
  codexServerEnabled,
  codexServerProblem,
} from '../codex-config.js';
import {
  bomHidesFrontmatter,
  codexFrontmatterClose,
  codexNameTooLong,
  codexRejectsDuplicate,
  codexRejectsMetadata,
  codexRepairedYaml,
  collapseWhitespace,
  descriptionState,
  frontmatterYaml,
  invalidCause,
  nameNotText,
} from '../codex-skills.js';
import {
  CODEX_EVENTS,
  CODEX_SOURCE_ONLY_EVENTS,
  codexMisplacedEvents,
  eventHandlers,
  hookEvents,
  type HookRoot,
} from '../hooks.js';
import { hookInventoryIds, mcpInventoryIds } from '../inventory-ids.js';
import { isBundledSkill } from '../location.js';
import { codexMcpServers } from '../mcp.js';
import { basename, inPayloadFolder, joinPath } from '../paths.js';
import { skillLocation } from '../skills.js';
import {
  agentsMdBeside,
  CODEX_DEFAULT_MAX_BYTES,
  CODEX_FILE_NAMES,
  type CodexChain,
  chainDirectories,
  codexMaxBytes,
  configuredCodexChain,
} from './codex-chain.js';
import { codexText, textOffsetAtByte } from './codex-text.js';
import type {
  Assumption,
  Certainty,
  HiddenScope,
  LimitUsage,
  LoadEntry,
  LoadPlan,
  OutOfScope,
  Size,
  SkipCode,
  SkippedLoad,
  SourceKey,
} from './types.js';
import { TRIGGER_RANK } from './types.js';
import type { LoadView } from './view.js';

export interface CodexLoadOptions {
  /** Working directory, relative to the scan root, normalized; `''` is the root. */
  readonly cwd: string;
  /** The scan's configuration. The `maxBytes` option of instr/codex-size-budget sets the budget. */
  readonly config: ResolvedConfig;
  /** The model's context window in tokens (`--context-window`), when known. */
  readonly contextWindow?: number;
}

/** Codex's skill discovery limits per root (codex-rs/ext/skills/src/loader/mod.rs). */
export const CODEX_SKILL_SCAN_DEPTH = 6;
export const CODEX_SKILL_SCAN_DIRECTORIES = 2000;
/** Size of the skill listing when Codex does not know the context window. */
export const CODEX_SKILL_LISTING_CHARS = 8000;
/** Share of the context window the skill listing may use, in percent. */
export const CODEX_SKILL_LISTING_PERCENT = 2;

/** Skills roots Codex scans in each directory, with how certain that is. */
const SKILL_ROOTS: readonly {
  readonly segment: string;
  readonly certainty: Certainty;
  readonly evidence: readonly SourceKey[];
}[] = [
  { segment: '.agents/skills', certainty: 'documented', evidence: ['codexSkills'] },
  // Project config layers add `<folder>/.codex/skills` (host_roots.rs); which directories count
  // as project config folders is not documented.
  { segment: '.codex/skills', certainty: 'unverified', evidence: ['codexSkillRoots'] },
];

const RULES = {
  sizeBudget: 'instr/codex-size-budget',
  overrideShadows: 'instr/override-shadows-agents-md',
  emptyFile: 'instr/empty-file',
  filenameCase: 'instr/filename-case',
  frontmatterMissing: 'skill/frontmatter-missing',
  frontmatterBom: 'skill/frontmatter-bom',
  frontmatterInvalid: 'skill/frontmatter-invalid',
  descriptionMissing: 'skill/description-missing',
  fieldType: 'skill/field-type',
  nameFormat: 'skill/name-format',
  invalidJson: 'json/invalid-syntax',
  unknownEvent: 'hooks/unknown-event',
  configInvalid: 'codex/config-invalid',
} as const;

const INSTRUCTION_EVIDENCE: readonly SourceKey[] = ['codexAgentsMd', 'codexAgentsMdSource'];
const CHAIN_SOURCE: readonly SourceKey[] = ['codexAgentsMdSource'];

const CERTAINTY_RANK: Readonly<Record<Certainty, number>> = {
  documented: 2,
  'source-code': 1,
  unverified: 0,
};

/** The less certain of two certainties. */
function weakest(a: Certainty, b: Certainty): Certainty {
  return CERTAINTY_RANK[a] <= CERTAINTY_RANK[b] ? a : b;
}

function sizeOf(bytes: number, text: string): Size {
  const chars = codePointLength(text);
  return { bytes, chars, tokens: tokensOf(chars) };
}

function sumSizes(sizes: readonly Size[]): Size {
  let bytes = 0;
  let chars = 0;
  for (const size of sizes) {
    bytes += size.bytes;
    chars += size.chars;
  }
  return { bytes, chars, tokens: tokensOf(chars) };
}

function sortedKeys(keys: readonly SourceKey[]): SourceKey[] {
  return [...new Set(keys)].sort(compareStrings);
}

/** True when `directory` is strictly below `cwd`. */
function isBelow(directory: string, cwd: string): boolean {
  return cwd === '' ? directory !== '' : directory.startsWith(`${cwd}/`);
}

/** The owner of a skills root or `.codex` file: `a/.agents/skills` -> `a`. */
function ownerOf(path: string): string {
  return dirnamePosix(dirnamePosix(path));
}

/** Collects the parts of a plan as the loader finds them. */
class PlanParts {
  readonly entries: LoadEntry[] = [];
  readonly skipped: SkippedLoad[] = [];
  readonly outOfScope: OutOfScope[] = [];
  readonly incomplete = new Set<string>();
  private position = 0;

  startup(entry: Omit<LoadEntry, 'trigger' | 'position'>): void {
    this.position += 1;
    const { id, role, ...rest } = entry;
    this.entries.push({ id, role, trigger: 'startup', position: this.position, ...rest });
  }

  skip(skip: SkippedLoad): void {
    this.skipped.push(skip);
  }
}

// ---------------------------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------------------------

/** What Codex would receive from a file it skips: the whole file, decoded as Codex does. */
function skippedSize(artifact: Artifact): Size {
  return sizeOf(artifact.file.bytes.length, codexText(artifact.file.bytes));
}

function addInstructions(view: LoadView, parts: PlanParts, chain: CodexChain): void {
  const skip = (
    path: string,
    code: SkipCode,
    ruleId: string,
    certainty: Certainty,
    size?: Size,
  ): void => {
    parts.skip({
      id: `instructions:${path}`,
      role: 'instructions',
      path,
      code,
      ruleId,
      ...(size === undefined ? {} : { size }),
      certainty,
      evidence: code === 'over-byte-budget' ? INSTRUCTION_EVIDENCE : CHAIN_SOURCE,
    });
  };

  for (const file of chain.files) {
    const { artifact, path } = file;
    const bytes = artifact.file.bytes;
    if (file.status === 'read' || (file.status === 'cut' && file.cutAt > 0)) {
      const received = file.status === 'cut' ? bytes.subarray(0, file.cutAt) : bytes;
      parts.startup({
        id: `instructions:${path}`,
        role: 'instructions',
        path,
        realPath: artifact.realPath,
        size: sizeOf(bytes.length, codexText(received)),
        ...(file.status === 'cut'
          ? {
              truncated: {
                atByte: file.cutAt,
                line: positionAt(artifact.decoded, textOffsetAtByte(artifact, file.cutAt)).line,
              },
            }
          : {}),
        certainty: 'documented',
        evidence: INSTRUCTION_EVIDENCE,
      });
    } else if (file.status === 'blank') {
      const override =
        basename(path) === 'AGENTS.override.md' &&
        agentsMdBeside(view.snapshot, path) !== undefined;
      if (override) skip(path, 'empty-override', RULES.overrideShadows, 'source-code');
      else skip(path, 'blank-file', RULES.emptyFile, 'source-code');
    } else {
      // Cut at byte 0, cut to only whitespace, or dropped after the cut: Codex reads none of it.
      skip(
        path,
        'over-byte-budget',
        RULES.sizeBudget,
        file.status === 'cut-blank' ? 'source-code' : 'documented',
        skippedSize(artifact),
      );
    }

    if (basename(path) === 'AGENTS.override.md') {
      const hidden = agentsMdBeside(view.snapshot, path);
      if (hidden !== undefined) {
        const shadowed = view.index.get(hidden);
        parts.skip({
          id: `instructions:${hidden}`,
          role: 'instructions',
          path: hidden,
          code: 'shadowed-by-override',
          ruleId: RULES.overrideShadows,
          ...(shadowed === undefined ? {} : { size: skippedSize(shadowed) }),
          certainty: 'documented',
          evidence: INSTRUCTION_EVIDENCE,
        });
      }
    }
  }

  // The first candidate that exists but was not read, or might exist, decides the directory. A
  // file with a project_doc_fallback_filenames name is not followed.
  const unknown = chain.unknownFile;
  if (unknown !== undefined) {
    parts.incomplete.add(`${unknown.fallback ? 'fallback' : 'unread'}:${unknown.path}`);
  }
}

/** Instruction files whose names match only case-insensitively, in the chain's directories. */
function addCaseMismatches(
  view: LoadView,
  parts: PlanParts,
  directories: ReadonlySet<string>,
): void {
  for (const artifact of view.artifacts) {
    if (artifact.caseMismatch === undefined) continue;
    if (artifact.kind !== 'agents-md' && artifact.kind !== 'agents-override-md') continue;
    if (!directories.has(dirnamePosix(artifact.path))) continue;
    parts.skip({
      id: `instructions:${artifact.path}`,
      role: 'instructions',
      path: artifact.path,
      code: 'case-mismatch',
      ruleId: RULES.filenameCase,
      size: skippedSize(artifact),
      certainty: 'source-code',
      evidence: CHAIN_SOURCE,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------------------------

interface SkillRootState {
  readonly path: string;
  readonly certainty: Certainty;
  readonly evidence: readonly SourceKey[];
  /** Directories the scan visits, the root included. */
  directories: number;
  /** Deepest `SKILL.md` directory, in levels below the root. */
  depth: number;
}

/** Each skills root among `roots` that contains `path` (a file, or a directory ending in `/`). */
function containingRoots(
  path: string,
  roots: ReadonlyMap<string, SkillRootState>,
): SkillRootState[] {
  const found: SkillRootState[] = [];
  for (const { segment } of SKILL_ROOTS) {
    const needle = `${segment}/`;
    for (let index = path.indexOf(needle); index !== -1; index = path.indexOf(needle, index + 1)) {
      if (index > 0 && path.charAt(index - 1) !== '/') continue;
      const root = roots.get(path.slice(0, index + segment.length));
      if (root !== undefined && path.length > index + needle.length) found.push(root);
    }
  }
  return found;
}

/** Skills roots in the chain's directories that exist, with their directory counts and depth. */
function scanSkillRoots(
  view: LoadView,
  parts: PlanParts,
  directories: readonly string[],
): Map<string, SkillRootState> {
  const { snapshot } = view;
  const roots = new Map<string, SkillRootState>();
  for (const directory of directories) {
    for (const { segment, certainty, evidence } of SKILL_ROOTS) {
      const path = joinPath(directory, segment);
      const status = pathStatus(snapshot, path);
      if (status === 'unknown' || snapshot.opaqueDirectories.has(`${path}/`)) {
        parts.incomplete.add(`unread:${path}/`);
        continue;
      }
      if (!snapshot.paths.has(`${path}/`)) continue;
      roots.set(path, { path, certainty, evidence, directories: 1, depth: 0 });
    }
  }
  if (roots.size === 0) return roots;

  const isSkillFile = (path: string): boolean => basename(path) === 'SKILL.md';
  for (const path of snapshot.paths) {
    for (const root of containingRoots(path, roots)) {
      if (path.endsWith('/')) {
        root.directories += 1;
        continue;
      }
      if (!isSkillFile(path)) continue;
      const depth = path.slice(root.path.length + 1).split('/').length - 1;
      root.depth = Math.max(root.depth, depth);
      if (!view.index.has(path)) parts.incomplete.add(`unread:${path}`);
    }
  }
  for (const path of snapshot.ignoredFiles) {
    if (isSkillFile(path) && containingRoots(path, roots).length > 0) {
      parts.incomplete.add(`unread:${path}`);
    }
  }
  for (const directory of snapshot.opaqueDirectories) {
    if (containingRoots(directory, roots).length > 0) parts.incomplete.add(`unread:${directory}`);
  }
  return roots;
}

type SkillVerdict =
  | {
      readonly kind: 'listed';
      readonly data: FrontmatterData | undefined;
      readonly certainty: Certainty;
      readonly evidence: readonly SourceKey[];
    }
  | {
      readonly kind: 'skipped';
      readonly code: SkipCode;
      readonly ruleId: string;
      readonly certainty: Certainty;
      readonly evidence: readonly SourceKey[];
    }
  | { readonly kind: 'unchecked' };

const PARSER: readonly SourceKey[] = ['codexSkillParser'];

function skippedFor(code: SkipCode, ruleId: string, certainty: Certainty = 'source-code') {
  return { kind: 'skipped', code, ruleId, certainty, evidence: PARSER } as const;
}

/** Why Codex skips a skill with this parsed frontmatter, if it does. */
function dataFailure(data: FrontmatterData): SkillVerdict | undefined {
  if (descriptionState(data) !== 'text') {
    return {
      ...skippedFor('no-description', RULES.descriptionMissing, 'documented'),
      evidence: ['codexSkillParser', 'codexSkills'],
    };
  }
  if (data.keys.includes('metadata') && codexRejectsMetadata(data.values['metadata'])) {
    return skippedFor('invalid-frontmatter', RULES.fieldType);
  }
  const name = data.values['name'];
  if (nameNotText(name) || (typeof name === 'string' && codexNameTooLong(name))) {
    return skippedFor('invalid-frontmatter', RULES.nameFormat);
  }
  return undefined;
}

/**
 * Whether Codex lists the skill, in the order Codex reads it: the frontmatter block, the byte
 * order mark, YAML parsing with one repair attempt, then the fields. Each step is the shared
 * function the reporting rule uses.
 */
function codexSkillVerdict(view: LoadView, artifact: Artifact): SkillVerdict {
  const result = view.frontmatter(artifact);
  const { decoded } = artifact;
  if (result.kind === 'absent' || result.kind === 'unclosed') {
    if (codexFrontmatterClose(decoded) === undefined) {
      return skippedFor('no-frontmatter', RULES.frontmatterMissing);
    }
    // An indented block: Codex trims the lines and finds it, but no rule parses it here.
    return { kind: 'listed', data: undefined, certainty: 'unverified', evidence: PARSER };
  }
  if (result.kind === 'unsupported') {
    return skippedFor('invalid-frontmatter', RULES.frontmatterInvalid);
  }
  if (bomHidesFrontmatter(decoded, result)) {
    return {
      ...skippedFor('bom', RULES.frontmatterBom),
      evidence: ['codexReadFileText', ...PARSER],
    };
  }
  if (result.kind === 'valid') {
    return (
      dataFailure(result.data) ?? {
        kind: 'listed',
        data: result.data,
        certainty: 'documented',
        evidence: [],
      }
    );
  }

  const cause = invalidCause(decoded.text, result);
  if (cause === undefined) {
    return { kind: 'listed', data: undefined, certainty: 'unverified', evidence: PARSER };
  }
  switch (cause.kind) {
    case 'limit':
      return { kind: 'unchecked' };
    case 'not-a-mapping':
      return skippedFor('invalid-frontmatter', RULES.frontmatterInvalid);
    case 'duplicate':
      if (codexRejectsDuplicate(cause.key)) {
        return skippedFor('invalid-frontmatter', RULES.frontmatterInvalid);
      }
      // serde ignores a repeated field it does not read; agentcheckup's parser kept no values.
      return { kind: 'listed', data: undefined, certainty: 'unverified', evidence: PARSER };
    case 'syntax': {
      const repaired = codexRepairedYaml(frontmatterYaml(decoded.text));
      if (repaired === undefined) {
        return skippedFor('invalid-frontmatter', RULES.frontmatterInvalid);
      }
      const reparsed = parseFrontmatter(`---\n${repaired}\n---\n`);
      const data = reparsed.kind === 'valid' ? reparsed.data : undefined;
      // No rule judges the fields of repaired YAML, so a field Codex rejects is not claimed.
      const certain = data !== undefined && dataFailure(data) === undefined;
      return {
        kind: 'listed',
        data,
        certainty: certain ? 'source-code' : 'unverified',
        evidence: PARSER,
      };
    }
  }
}

/** A field as Codex lists it: text with whitespace collapsed, '' for anything else. */
function listedText(value: unknown): string {
  if (typeof value === 'string') return collapseWhitespace(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

interface ListedSkill {
  readonly path: string;
  readonly artifact: Artifact;
  readonly root: SkillRootState;
  readonly verdict: Extract<SkillVerdict, { kind: 'listed' }>;
}

function addSkills(
  view: LoadView,
  parts: PlanParts,
  directories: readonly string[],
  cwd: string,
): { readonly roots: readonly SkillRootState[]; readonly listingChars: number } {
  const roots = scanSkillRoots(view, parts, directories);
  const listed: ListedSkill[] = [];

  for (const [path, artifact] of view.index) {
    if (artifact.kind !== 'skill') continue;
    const location = skillLocation(path);
    if (location?.platforms.has('codex') !== true) continue;
    const root = roots.get(location.root);
    if (root === undefined) {
      if (isBelow(ownerOf(location.root), cwd)) {
        parts.outOfScope.push({ path, because: 'below-start-dir' });
      }
      continue;
    }
    const base = { id: `skill:${path}`, role: 'skill', path } as const;
    if (basename(path) !== 'SKILL.md') {
      // Codex discovers only the exact name; no rule reports a case variant for Codex.
      parts.skip({
        ...base,
        code: 'not-read',
        certainty: weakest(root.certainty, 'source-code'),
        evidence: ['codexSkillDiscovery'],
      });
      continue;
    }
    // The rules judge neither skills bundled in another skill nor skills in template, example
    // or fixture folders, so the plan leaves them out too.
    if (isBundledSkill(view.snapshot, artifact.path) || inPayloadFolder(artifact.path)) {
      parts.outOfScope.push({ path, because: 'payload-folder' });
      continue;
    }
    if (location.relative.split('/').length - 1 > CODEX_SKILL_SCAN_DEPTH) {
      // How the source counts levels is not documented.
      parts.skip({
        ...base,
        code: 'not-read',
        certainty: 'unverified',
        evidence: ['codexSkillLimits'],
      });
      continue;
    }

    const verdict = codexSkillVerdict(view, artifact);
    if (verdict.kind === 'unchecked') {
      parts.incomplete.add(`unparsed:${path}`);
    } else if (verdict.kind === 'skipped') {
      parts.skip({
        ...base,
        code: verdict.code,
        ruleId: verdict.ruleId,
        // The skill file: its body never reaches the model.
        size: skippedSize(artifact),
        certainty: weakest(root.certainty, verdict.certainty),
        evidence: sortedKeys([...verdict.evidence, ...root.evidence]),
      });
    } else {
      listed.push({ path, artifact, root, verdict });
    }
  }

  // The order of the listing is not documented; entries follow path order.
  listed.sort((a, b) => compareStrings(a.path, b.path));
  let listingChars = 0;
  for (const { path, artifact, root, verdict } of listed) {
    const { data } = verdict;
    // Without a usable `name`, Codex names the skill after its directory (loader/host.rs).
    const name = listedText(data?.values['name']) || basename(dirnamePosix(path));
    const description = listedText(data?.values['description']);
    const line = `- ${name}: ${description} (file: ${path})`;
    const size = sizeOf(utf8ByteLength(line), line);
    listingChars += size.chars;
    const overLimit = root.directories > CODEX_SKILL_SCAN_DIRECTORIES;
    parts.startup({
      id: `skill:${path}`,
      role: 'skill',
      path,
      realPath: artifact.realPath,
      name,
      size,
      deferred: sizeOf(artifact.file.bytes.length, codexText(artifact.file.bytes)),
      // Past the directory limit, which skills the scan reaches depends on the walk order.
      certainty: weakest(
        weakest(root.certainty, verdict.certainty),
        overLimit ? 'unverified' : 'documented',
      ),
      evidence: sortedKeys([
        'codexSkills',
        'codexSkillDiscovery',
        ...root.evidence,
        ...verdict.evidence,
      ]),
    });
  }
  return { roots: [...roots.values()], listingChars };
}

// ---------------------------------------------------------------------------------------------
// Hooks and config.toml
// ---------------------------------------------------------------------------------------------

/**
 * True when `features.hooks` (or its alias) is false in the project configuration, which turns
 * off every hook (SOURCES.codexHooks, SOURCES.codexConfigReference).
 */
function hooksOff(config: CodexProjectConfig): boolean {
  return codexHooksSetting(config)?.value === false;
}

const HOOKS_DISABLED_EVIDENCE: readonly SourceKey[] = ['codexHooks', 'codexConfigReference'];

/** An event outside "hooks" in `.codex/hooks.json` makes Codex reject the whole file. */
const MISPLACED_EVIDENCE: readonly SourceKey[] = ['codexHookConfig', 'codexHooks'];
/** Codex fires only the events of `HOOK_EVENT_NAMES`. */
const UNKNOWN_EVENT_EVIDENCE: readonly SourceKey[] = ['codexHookEvents', 'codexHooks'];

/**
 * The handlers of one hooks file: `.codex/hooks.json`, or the `[hooks]` table of a
 * `.codex/config.toml` layer. Unknown or misplaced events are skipped with hooks/unknown-event;
 * with hooks turned off, every other handler is skipped as `disabled`. A handler under an event
 * only the source names ({@link CODEX_SOURCE_ONLY_EVENTS}) cites the source.
 */
function addHandlers(
  parts: PlanParts,
  file: { readonly path: string; readonly artifact: Artifact; readonly doc: ParsedJson },
  root: HookRoot,
  certainty: Certainty,
  evidence: readonly SourceKey[],
  disabled: boolean,
): void {
  const { path, artifact, doc } = file;
  const misplaced = root === 'hooks' ? codexMisplacedEvents(doc) : [];
  const events = hookEvents(doc, 'codex', root);
  const handlers = eventHandlers([...events, ...misplaced], 'codex');
  const ids = hookInventoryIds(path, handlers);
  const inventoryIds = hookInventoryIds(artifact.path, handlers);
  const known: readonly string[] = CODEX_EVENTS;
  handlers.forEach((handler, i) => {
    const id = ids[i] ?? '';
    // An event outside "hooks" makes Codex skip the whole file.
    if (misplaced.length > 0 || !known.includes(handler.event)) {
      parts.skip({
        id,
        role: 'hook',
        path,
        name: handler.event,
        code: 'unknown-event',
        ruleId: RULES.unknownEvent,
        certainty: weakest(certainty, 'source-code'),
        evidence: misplaced.length > 0 ? MISPLACED_EVIDENCE : UNKNOWN_EVENT_EVIDENCE,
      });
      return;
    }
    const sourceOnly = CODEX_SOURCE_ONLY_EVENTS.has(handler.event);
    if (disabled) {
      parts.skip({
        id,
        role: 'hook',
        path,
        name: handler.event,
        code: 'disabled',
        certainty,
        evidence: HOOKS_DISABLED_EVIDENCE,
      });
      return;
    }
    parts.entries.push({
      id,
      role: 'hook',
      trigger: 'on-approval',
      path,
      realPath: artifact.realPath,
      name: handler.event,
      inventoryId: inventoryIds[i] ?? '',
      certainty: sourceOnly ? weakest(certainty, 'source-code') : certainty,
      evidence: sourceOnly ? [...evidence, 'codexHookEvents'] : evidence,
    });
  });
  // hooks/unknown-event reports event names, so an unknown or misplaced event without a
  // handler Codex could read is skipped as a whole.
  const withHandlers = new Set(handlers.map((handler) => handler.event));
  const unknown = events.filter((event) => !known.includes(event.name));
  for (const event of [...unknown, ...misplaced]) {
    if (withHandlers.has(event.name)) continue;
    parts.skip({
      id: `hook:${path}#${event.name}`,
      role: 'hook',
      path,
      name: event.name,
      code: 'unknown-event',
      ruleId: RULES.unknownEvent,
      certainty: weakest(certainty, 'source-code'),
      evidence: misplaced.length > 0 ? MISPLACED_EVIDENCE : UNKNOWN_EVENT_EVIDENCE,
    });
  }
}

function addHooks(
  view: LoadView,
  parts: PlanParts,
  directories: readonly string[],
  config: CodexProjectConfig,
): void {
  const disabled = hooksOff(config);
  for (const directory of directories) {
    const path = joinPath(directory, '.codex/hooks.json');
    const artifact = view.index.get(path);
    if (artifact === undefined) {
      if (pathStatus(view.snapshot, path) !== 'missing') parts.incomplete.add(`unread:${path}`);
      continue;
    }
    if (artifact.kind !== 'codex-hooks') continue;
    // The documentation names the project's `.codex/hooks.json`; nested project folders are
    // config layers in the source, which is not verified here.
    const certainty: Certainty = directory === directories[0] ? 'documented' : 'unverified';
    const doc = view.json(artifact);
    if (!doc.ok) {
      const issue = doc.errors[0];
      if (issue === undefined || issueKind(issue) === 'limit') {
        parts.incomplete.add(`unparsed:${path}`);
        continue;
      }
      parts.skip({
        id: `hook:${path}`,
        role: 'hook',
        path,
        code: 'invalid-json',
        ruleId: RULES.invalidJson,
        certainty: weakest(certainty, 'source-code'),
        evidence: ['codexHookDiscovery'],
      });
      continue;
    }
    addHandlers(parts, { path, artifact, doc }, 'hooks', certainty, ['codexHooks'], disabled);
  }
}

const CONFIG_EVIDENCE: readonly SourceKey[] = ['codexConfigBasic', 'codexConfigLoader'];

/**
 * The `.codex/config.toml` layers of the chain: their MCP servers, merged by name with the
 * closest layer winning, and the inline hooks of each layer. A layer that is not valid TOML
 * stops Codex at startup in a trusted project (codex/config-invalid); one agentcheckup could not
 * read makes the plan incomplete.
 */
function addConfig(parts: PlanParts, config: CodexProjectConfig): void {
  for (const problem of config.problems) {
    if (problem.kind === 'invalid') {
      parts.skip({
        id: `mcp-server:${problem.path}`,
        role: 'mcp-server',
        path: problem.path,
        code: 'invalid-toml',
        ruleId: RULES.configInvalid,
        certainty: 'source-code',
        evidence: ['codexConfigLoader'],
      });
    } else {
      parts.incomplete.add(`${problem.kind}:${problem.path}`);
    }
  }

  // Servers: one per name, from the closest layer that declares it; the merged entry decides
  // whether it is enabled and whether Codex accepts it.
  const declared = new Map<string, CodexConfigLayer>();
  for (const layer of config.layers) {
    for (const server of codexMcpServers(layer.doc)) declared.set(server.name, layer);
  }
  // A server's inventory id is that of the first server of its name in its layer.
  const inventoryIds = new Map<CodexConfigLayer, Map<string, string>>();
  const inventoryIdOf = (layer: CodexConfigLayer, name: string): string => {
    let ids = inventoryIds.get(layer);
    if (ids === undefined) {
      const servers = codexMcpServers(layer.doc);
      const all = mcpInventoryIds(layer.artifact.path, servers);
      const byName = new Map<string, string>();
      servers.forEach((server, index) => {
        if (!byName.has(server.name)) byName.set(server.name, all[index] ?? '');
      });
      ids = byName;
      inventoryIds.set(layer, ids);
    }
    return ids.get(name) ?? '';
  };
  for (const [name, layer] of declared) {
    const merged = config.table(['mcp_servers', name]);
    if (merged === undefined) continue;
    const inventoryId = inventoryIdOf(layer, name);
    const id = `mcp-server:${layer.path}#${name}`;
    if (!codexServerEnabled(merged)) {
      parts.skip({
        id,
        role: 'mcp-server',
        path: layer.path,
        name,
        code: 'disabled',
        certainty: 'documented',
        evidence: ['codexMcp'],
      });
      continue;
    }
    // Codex rejects the entry (codex/config-invalid); whether that stops it at startup or only
    // drops the server is not verified.
    const rejected = codexServerProblem(merged) !== undefined;
    parts.entries.push({
      id,
      role: 'mcp-server',
      trigger: 'startup',
      path: layer.path,
      realPath: layer.artifact.realPath,
      name,
      inventoryId,
      certainty: rejected ? 'unverified' : 'documented',
      evidence: rejected ? ['codexMcp', 'codexMcpTypes'] : ['codexMcp', ...CONFIG_EVIDENCE],
    });
  }

  const disabled = hooksOff(config);
  for (const layer of config.layers) {
    const evidence = ['codexHooks', ...CONFIG_EVIDENCE];
    addHandlers(parts, layer, 'toml', 'documented', evidence, disabled);
  }
}

/** A file that Codex reads only from a start below `directory`. */
interface DeeperStartFile {
  readonly path: string;
  readonly directory: string;
}

const DEEPER_START_FILES = new WeakMap<LoadView['index'], readonly DeeperStartFile[]>();

/**
 * The AGENTS.md files (in any letter case), `.codex/hooks.json` and `.codex/config.toml` files of
 * the index, in its order. Found once per index: the matrix plans Codex in every directory with
 * an AGENTS.md.
 */
function deeperStartFiles(view: LoadView): readonly DeeperStartFile[] {
  const cached = DEEPER_START_FILES.get(view.index);
  if (cached !== undefined) return cached;
  const files: DeeperStartFile[] = [];
  for (const [path, artifact] of view.index) {
    // Case variants too: Codex at that directory skips them (instr/filename-case).
    const name = basename(path).toLowerCase();
    if (CODEX_FILE_NAMES.some((file) => file.toLowerCase() === name)) {
      files.push({ path, directory: dirnamePosix(path) });
    } else if (
      (artifact.kind === 'codex-hooks' && path.endsWith('.codex/hooks.json')) ||
      (artifact.kind === 'codex-config' && path.endsWith(CODEX_CONFIG_FILE))
    ) {
      files.push({ path, directory: ownerOf(path) });
    }
  }
  DEEPER_START_FILES.set(view.index, files);
  return files;
}

/** Files below the working directory that Codex would read only from a deeper start. */
function addBelowStart(view: LoadView, parts: PlanParts, cwd: string): void {
  for (const { path, directory } of deeperStartFiles(view)) {
    if (isBelow(directory, cwd)) parts.outOfScope.push({ path, because: 'below-start-dir' });
  }
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

const HIDDEN: readonly HiddenScope[] = [
  {
    scope: 'user',
    locations: ['$CODEX_HOME/AGENTS.override.md', '$CODEX_HOME/AGENTS.md'],
    roles: ['instructions'],
  },
  { scope: 'user', locations: ['~/.agents/skills'], roles: ['skill'] },
  { scope: 'managed', locations: ['/etc/codex/skills'], roles: ['skill'] },
  {
    scope: 'user',
    locations: ['~/.codex/config.toml', '~/.codex/hooks.json'],
    roles: ['hook', 'mcp-server'],
  },
];

function maxBytesOf(config: ResolvedConfig): {
  readonly value: number;
  readonly origin: 'default' | 'rule-option';
} {
  const options = config.ruleSetting(RULES.sizeBudget, '')?.options;
  if (options === undefined || !Object.hasOwn(options, 'maxBytes')) {
    return { value: CODEX_DEFAULT_MAX_BYTES, origin: 'default' };
  }
  return { value: codexMaxBytes(options['maxBytes']), origin: 'rule-option' };
}

function compareEntries(a: LoadEntry, b: LoadEntry): number {
  const position =
    (a.position ?? Number.POSITIVE_INFINITY) - (b.position ?? Number.POSITIVE_INFINITY);
  return (
    (Number.isNaN(position) ? 0 : position) ||
    TRIGGER_RANK[a.trigger] - TRIGGER_RANK[b.trigger] ||
    compareStrings(a.path, b.path) ||
    compareStrings(a.id, b.id)
  );
}

/**
 * What Codex loads for a session started in `options.cwd`. Repository scope only: the global
 * `AGENTS.md`, user and admin skills and `~/.codex/config.toml` are listed in `hidden`.
 */
export function loadCodex(view: LoadView, options: CodexLoadOptions): LoadPlan {
  const { cwd, contextWindow } = options;
  if (normalizeRelative(cwd) !== cwd) {
    throw new Error(
      `Working directory must be a normalized relative path, got ${JSON.stringify(cwd)}.`,
    );
  }
  if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)) {
    throw new Error(`Context window must be a positive integer, got ${String(contextWindow)}.`);
  }
  const parts = new PlanParts();

  // project_doc_max_bytes and project_doc_fallback_filenames: the repository's project
  // configuration, else the rule option, else the default.
  const { chain, config, settings } = configuredCodexChain(view, cwd, maxBytesOf(options.config));
  const budget = settings.maxBytes;
  const directories = chainDirectories(chain.root, cwd);
  addInstructions(view, parts, chain);
  addCaseMismatches(view, parts, new Set(directories));
  const skills = addSkills(view, parts, directories, cwd);
  addHooks(view, parts, directories, config);
  addConfig(parts, config);
  addBelowStart(view, parts, cwd);

  const listingLimit =
    contextWindow === undefined
      ? CODEX_SKILL_LISTING_CHARS
      : Math.floor((contextWindow * CODEX_SKILL_LISTING_PERCENT) / 100) * 4;
  // The chain and the listing are computed for the working directory, which identifies them.
  const limits: LimitUsage[] = [
    {
      key: 'codex.project_doc_max_bytes',
      unit: 'bytes',
      limit: budget.value,
      used: chain.total,
      subject: cwd,
      label: 'AGENTS.md chain',
      effect: 'truncates',
      evidence: INSTRUCTION_EVIDENCE,
    },
    {
      key: 'codex.skills_listing',
      unit: 'chars',
      limit: listingLimit,
      used: skills.listingChars,
      subject: cwd,
      label: 'skills listing',
      effect: 'shortens',
      evidence: ['codexSkills'],
    },
    ...skills.roots.flatMap((root): LimitUsage[] => [
      {
        key: 'codex.skills_scan_depth',
        unit: 'levels',
        limit: CODEX_SKILL_SCAN_DEPTH,
        used: root.depth,
        subject: root.path,
        effect: 'skips',
        evidence: ['codexSkillLimits'],
      },
      {
        key: 'codex.skills_scan_directories',
        unit: 'directories',
        limit: CODEX_SKILL_SCAN_DIRECTORIES,
        used: root.directories,
        subject: root.path,
        effect: 'skips',
        evidence: ['codexSkillLimits'],
      },
    ]),
  ];

  const assumptions: Assumption[] = [
    {
      key: 'codex.project_doc_max_bytes',
      value: budget.value,
      origin: budget.origin,
      evidence:
        budget.origin === 'repository'
          ? ['codexAgentsMd', 'codexConfigBasic', 'codexConfigReference']
          : ['codexAgentsMd', 'codexDefaults'],
    },
    {
      key: 'codex.project_root_markers',
      value: '[".git"]',
      origin: 'default',
      evidence: ['codexConfigAdvanced', 'codexDefaults'],
    },
    {
      key: 'codex.project_doc_fallback_filenames',
      value: JSON.stringify(settings.fallbackNames.value),
      origin: settings.fallbackNames.origin,
      evidence:
        settings.fallbackNames.origin === 'repository'
          ? ['codexAgentsMd', 'codexConfigBasic', 'codexConfigReference']
          : ['codexAgentsMd'],
    },
    {
      key: 'codex.trust_level',
      value: 'trusted',
      origin: 'default',
      evidence: ['codexAgentsMdSource', 'codexConfigBasic'],
    },
    contextWindow === undefined
      ? {
          key: 'codex.context_window',
          value: 'unknown',
          origin: 'default',
          evidence: ['codexSkills'],
        }
      : {
          key: 'codex.context_window',
          value: contextWindow,
          origin: 'flag',
          evidence: ['codexSkills'],
        },
  ];

  const entries = [...parts.entries].sort(compareEntries);
  return {
    agent: 'codex',
    cwd,
    entries,
    skipped: [...parts.skipped].sort(
      (a, b) => compareStrings(a.path, b.path) || compareStrings(a.id, b.id),
    ),
    outOfScope: [...parts.outOfScope].sort(
      (a, b) => compareStrings(a.path, b.path) || compareStrings(a.because, b.because),
    ),
    assumptions: assumptions.sort((a, b) => compareStrings(a.key, b.key)),
    hidden: [...HIDDEN].sort(
      (a, b) =>
        compareStrings(a.scope, b.scope) ||
        compareStrings(a.locations[0] ?? '', b.locations[0] ?? ''),
    ),
    limits: limits.sort(
      (a, b) => compareStrings(a.key, b.key) || compareStrings(a.subject, b.subject),
    ),
    totals: {
      startup: sumSizes(
        entries.flatMap((entry) =>
          entry.trigger === 'startup' && entry.size !== undefined ? [entry.size] : [],
        ),
      ),
      onDemand: sumSizes(
        entries.flatMap((entry) => (entry.deferred === undefined ? [] : [entry.deferred])),
      ),
    },
    incomplete: [...parts.incomplete].sort(compareStrings),
  };
}
