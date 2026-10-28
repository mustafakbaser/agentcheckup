/**
 * The custom agents and subagents a session lists, added to each agent's load plan after its
 * loader runs (`loadPlans` in ./index.ts), from the discovery the agent definitions share
 * (../agent-files.ts). Pure.
 *
 * - The model picks a subagent by its name and description, so the listing is in the context
 *   from the start: an entry with trigger `startup` and the listing's size, without a position
 *   (no agent documents where the listing sits). Claude Code counts each agent's name plus its
 *   `description`, and warns at startup when they pass 15,000 tokens (SOURCES.claudeSubagents).
 *   Cursor, Gemini CLI and Devin Local document that their model reads the description to decide
 *   when to delegate ({@link DOCUMENTED_LISTINGS}); Codex and Copilot do not document what their
 *   model sees, so their listings are unverified.
 *   A Copilot agent with `disable-model-invocation: true`, or without it the retired
 *   `infer: false`, is not picked by the model: `manual`, without a size.
 * - What a subagent starts with when it runs goes to a context window of its own, not to the
 *   session's: `ownContext` on its entry, not part of the plan's totals. For Claude Code its
 *   prompt, the session's startup instruction files unless `omitClaudeMd: true`, the bodies of
 *   the skills `skills` preloads and the memory `memory` adds (SOURCES.claudeSubagents, "What
 *   loads at startup"); for the other agents, the prompt.
 * - Claude Code finds project subagents from the working directory up to the repository root,
 *   and of one name the definition closest to the working directory wins
 *   (SOURCES.claudeSubagents). The Copilot CLI loads every `.github/agents` from the working
 *   directory up before any `.claude/agents`, the first of an id winning
 *   (SOURCES.copilotCliAgents). Codex and the Copilot CLI read up to the root as well, and the
 *   Copilot cloud agent the root's folder. Cursor, Copilot in VS Code, Gemini CLI and Devin Local
 *   read the working directory's folder only, as their loaders take it ({@link SCOPE}). A folder
 *   below the working directory is out of scope (`below-start-dir`); one outside the session is
 *   not mentioned.
 */
import { compareStrings } from '../../core/compare.js';
import { codePointLength, tokensOf, utf8ByteLength } from '../../core/measure.js';
import type { Artifact } from '../../core/types.js';
import { isTable, own } from '../../parse/json-access.js';
import {
  type AgentFile,
  agentFiles,
  folderPlace,
  switchedOff,
  switchesAt,
} from '../agent-files.js';
import { dirnamePosix, pathStatus } from '../../core/paths.js';
import { basename, inClaudeFolder, joinPath, nearestGitRoot, selfAndAncestors } from '../paths.js';
import { readingsOf } from '../readings.js';
import { claudeProjectSettings, isFalsy, isTruthy, lastSetting } from '../root-settings.js';
import { bodyOffset, claudeBoolean } from '../skills.js';
import { checkSubagent } from '../subagents.js';
import { compareEntries, compareOutOfScope, compareSkips } from './order.js';
import type {
  Certainty,
  ContextAgent,
  LimitUsage,
  LoadEntry,
  LoadPlan,
  OutOfScope,
  OwnContext,
  OwnContextHidden,
  OwnContextPart,
  PreloadNotLoaded,
  Size,
  SkippedLoad,
} from './types.js';
import type { LoadView } from './view.js';

/** Claude Code warns when the subagents' names and descriptions pass this many tokens. */
export const CLAUDE_AGENT_DESCRIPTIONS_TOKENS = 15_000;

function sizeOf(chars: number, bytes: number): Size {
  return { bytes, chars, tokens: tokensOf(chars) };
}

/** Each definition's listing, measured once for every plan of a scan. */
const LISTINGS = new WeakMap<AgentFile, Size>();

/**
 * What the model sees of a definition before it picks it: the name and the description,
 * counted without a separator, as Claude Code counts them.
 */
function listingSize(file: AgentFile): Size {
  let size = LISTINGS.get(file);
  if (size === undefined) {
    const text = `${file.name ?? ''}${file.description ?? ''}`;
    size = sizeOf(codePointLength(text), utf8ByteLength(text));
    LISTINGS.set(file, size);
  }
  return size;
}

/**
 * Agents that document that their model reads each custom agent's description to decide when to
 * delegate: "Agent reads this to decide delegation" (SOURCES.cursorSubagents), "visible to the
 * main agent to help it decide when to call this subagent" (SOURCES.geminiSubagents), "the agent
 * sees a description of each available profile" (SOURCES.devinSubagents), and Claude Code.
 */
const DOCUMENTED_LISTINGS: ReadonlySet<ContextAgent> = new Set([
  'claude-code',
  'cursor',
  'gemini',
  'windsurf',
]);

/**
 * Which of two definitions of one name on the path a session takes: the Copilot CLI loads every
 * `.github/agents` before any `.claude/agents`, each from the working directory up, and keeps
 * the first of an id (SOURCES.copilotCliAgents); the others take the one closest to the working
 * directory, as Claude Code documents.
 */
function precedes(agent: ContextAgent, file: AgentFile, other: AgentFile): boolean {
  if (agent === 'copilot-cli' && file.rank !== other.rank) return file.rank < other.rank;
  return file.scope.length > other.scope.length;
}

/**
 * Which agent folders a session reads, as each agent's loader takes its working directory:
 * - `repository`: from the working directory up to the repository root, as Claude Code
 *   documents for project subagents and Codex for project configuration; the Copilot CLI reads
 *   the repository root's `.github` too.
 * - `root`: the repository root's folder only. The Copilot cloud agent reads the repository's
 *   `.github/agents`, as its loader reads the root's `.github` (SOURCES.copilotCustomAgents).
 * - `workspace`: the working directory is the folder opened as the workspace, and folders above
 *   it are not part of it (Cursor, Copilot in VS Code, Devin Local), or the agent reads the
 *   working directory's own configuration folder (Gemini CLI's `.gemini`).
 */
const SCOPE: Readonly<Record<ContextAgent, 'repository' | 'root' | 'workspace'>> = {
  'claude-code': 'repository',
  codex: 'repository',
  cursor: 'workspace',
  'copilot-cli': 'repository',
  'copilot-vscode': 'workspace',
  'copilot-cloud': 'root',
  gemini: 'workspace',
  windsurf: 'workspace',
  cline: 'workspace',
};

/**
 * Where a definition's folder sits for a session of `agent` started in `cwd`, in a repository
 * whose root is `root`: read with the session, below the working directory, or not part of it.
 */
function placeFor(
  agent: ContextAgent,
  owner: string,
  cwd: string,
  root: string,
): 'path' | 'below' | 'outside' {
  const scope = SCOPE[agent];
  if (scope === 'root') return owner === root ? 'path' : 'outside';
  const above = owner === '' || cwd.startsWith(`${owner}/`);
  if (owner === cwd || (above && scope === 'repository')) return 'path';
  if (cwd === '' || owner.startsWith(`${cwd}/`)) return 'below';
  return 'outside';
}

/**
 * A Copilot custom agent the model does not pick on its own: `disable-model-invocation: true`,
 * else the retired `infer: false`; "if both are set, `disable-model-invocation` takes
 * precedence" (SOURCES.copilotCustomAgents).
 */
function manualOnly(file: AgentFile): boolean {
  if (!file.agent.startsWith('copilot-') || file.source.kind !== 'frontmatter') return false;
  const { values } = file.source.fields;
  const disabled = own(values, 'disable-model-invocation');
  if (typeof disabled === 'boolean') return disabled;
  return own(values, 'infer') === false;
}

/** A Codex role `config.toml` declares shares the file with other roles: its id names it. */
function entryId(file: AgentFile): string {
  return file.file.endsWith('.codex/config.toml') && file.name !== undefined
    ? `subagent:${file.file}#${file.name}`
    : `subagent:${file.file}`;
}

function realPathOf(file: AgentFile, view: LoadView): string {
  if (file.source.kind !== 'none') return file.source.artifact.realPath;
  return view.index.get(file.file)?.realPath ?? file.file;
}

/** The plan with the subagents a session started in its `cwd` lists, and their totals. */
export function withSubagents(plan: LoadPlan, view: LoadView): LoadPlan {
  const { agent, cwd } = plan;
  const claude = agent === 'claude-code';
  const entries: LoadEntry[] = [];
  const skipped: SkippedLoad[] = [];
  const outOfScope = new Map<string, OutOfScope>();
  const out = (path: string, because: OutOfScope['because']): void => {
    outOfScope.set(`${path}\u0000${because}`, { path, because });
  };

  // Folders above the working directory count up to the repository root only.
  const repositoryRoot =
    SCOPE[agent] === 'workspace' ? '' : (nearestGitRoot(view.snapshot, cwd) ?? '');
  const insideRepository = (owner: string): boolean =>
    repositoryRoot === '' || owner === repositoryRoot || owner.startsWith(`${repositoryRoot}/`);

  // The switches this session reads turn custom agents off, wherever their folders are.
  const switches = switchesAt(view, agent, cwd);
  const onPath: AgentFile[] = [];
  for (const file of agentFiles(view)) {
    if (file.agent !== agent) continue;
    const place = placeFor(agent, file.scope, cwd, repositoryRoot);
    if (place === 'below') out(file.file, 'below-start-dir');
    if (place !== 'path' || !insideRepository(file.scope)) continue;
    onPath.push(switchedOff(file, switches));
  }

  // Of one name on the path, one definition wins ({@link precedes}).
  const closest = new Map<string, AgentFile>();
  for (const file of onPath) {
    if (file.status !== 'loads' || file.key === '') continue;
    const known = closest.get(file.key);
    if (known === undefined || precedes(agent, file, known)) closest.set(file.key, file);
  }
  const documentedOrder = claude || agent === 'copilot-cli';

  // What a call starts with, from what the session draws on, computed once per plan.
  let claudeFacts: ClaudeSession | undefined;
  let facts: Session | undefined;
  const callOf = (file: AgentFile): OwnContext =>
    claude
      ? claudeOwnContext(file, (claudeFacts ??= claudeSession(plan, view)), view)
      : ownContextOf(file, (facts ??= sessionOf(plan)), view);
  // A definition that may load instead of the preferred one, where the agent does not document
  // which one wins, has its call measured too: either may run.
  const mayRun = (file: AgentFile, certainty: Certainty): { ownContext?: OwnContext } =>
    certainty === 'unverified' && file.source.kind !== 'none' ? { ownContext: callOf(file) } : {};

  for (const file of onPath) {
    const base = { role: 'subagent', path: file.file, evidence: file.evidence } as const;
    const name = file.name === undefined ? {} : { name: file.name };
    const winner = file.status === 'loads' && file.key !== '' ? closest.get(file.key) : undefined;
    if (winner !== undefined && winner !== file) {
      const certainty: Certainty = documentedOrder ? 'documented' : 'unverified';
      skipped.push({
        ...base,
        id: entryId(file),
        ...name,
        code: 'shadowed-by-preferred',
        ...mayRun(file, certainty),
        certainty,
      });
      continue;
    }
    switch (file.status) {
      case 'skipped':
        skipped.push({
          ...base,
          id: entryId(file),
          ...name,
          code: file.skip ?? 'invalid-subagent',
          ...(claude && file.skip === 'invalid-subagent'
            ? { ruleId: 'instr/subagent-invalid' }
            : {}),
          certainty: claude ? 'documented' : file.certainty,
        });
        break;
      case 'shadowed':
        skipped.push({
          ...base,
          id: entryId(file),
          ...name,
          code: 'shadowed-by-preferred',
          ...mayRun(file, file.certainty),
          certainty: file.certainty,
        });
        break;
      case 'unknown':
        // Whether the agent loads it is not known, nor what it lists.
        entries.push({
          ...base,
          id: entryId(file),
          trigger: 'startup',
          realPath: realPathOf(file, view),
          ...name,
          certainty: 'unverified',
        });
        break;
      case 'loads': {
        const manual = manualOnly(file);
        // A folder another directory owns is documented only for Claude Code, which finds it
        // walking up from the working directory; elsewhere, as sure as the file's own reading.
        const certainty: Certainty = !DOCUMENTED_LISTINGS.has(agent)
          ? 'unverified'
          : file.scope === ''
            ? file.certainty
            : claude
              ? 'documented'
              : 'unverified';
        entries.push({
          ...base,
          id: entryId(file),
          trigger: manual ? 'manual' : 'startup',
          realPath: realPathOf(file, view),
          ...name,
          ...(manual ? {} : { size: listingSize(file) }),
          ownContext: callOf(file),
          certainty,
        });
        break;
      }
    }
  }

  if (claude) {
    // A README or other notes kept in a `.claude/agents` folder the session reads or a deeper
    // start would: documentation, not a subagent.
    for (const artifact of view.artifacts) {
      for (const reading of readingsOf(artifact)) {
        const folder =
          reading.kind === 'claude-agent'
            ? folderPlace(reading.path, ['.claude/agents'])
            : undefined;
        if (folder === undefined) continue;
        const place = placeFor(agent, folder.owner, cwd, repositoryRoot);
        if (place === 'outside' || (place === 'path' && !insideRepository(folder.owner))) continue;
        if (isDocumentation(view, artifact)) out(reading.path, 'documentation');
      }
    }
  }

  const limits = claude ? descriptionsLimit(entries, cwd) : [];
  if (
    entries.length === 0 &&
    skipped.length === 0 &&
    outOfScope.size === 0 &&
    limits.length === 0
  ) {
    return plan;
  }

  let chars = plan.totals.startup.chars;
  let bytes = plan.totals.startup.bytes;
  for (const entry of entries) {
    if (entry.trigger !== 'startup' || entry.size === undefined) continue;
    chars += entry.size.chars;
    bytes += entry.size.bytes;
  }
  const known = new Set(plan.outOfScope.map((item) => `${item.path}\u0000${item.because}`));
  return {
    ...plan,
    entries: [...plan.entries, ...entries].sort(compareEntries),
    skipped: [...plan.skipped, ...skipped].sort(compareSkips),
    outOfScope: [
      ...plan.outOfScope,
      ...[...outOfScope].filter(([key]) => !known.has(key)).map(([, item]) => item),
    ].sort(compareOutOfScope),
    limits: [...plan.limits, ...limits].sort(
      (a, b) => compareStrings(a.key, b.key) || compareStrings(a.subject, b.subject),
    ),
    totals: { ...plan.totals, startup: sizeOf(chars, bytes) },
  };
}

// ---------------------------------------------------------------------------------------------
// What a subagent starts with when it runs
// ---------------------------------------------------------------------------------------------

/** Claude Code preloads the full content of the first 32 distinct skills `skills` names. */
export const CLAUDE_PRELOAD_MAX_SKILLS = 32;

function textSize(text: string): Size {
  return sizeOf(codePointLength(text), utf8ByteLength(text));
}

function sumOf(sizes: readonly Size[]): Size {
  let chars = 0;
  let bytes = 0;
  for (const size of sizes) {
    chars += size.chars;
    bytes += size.bytes;
  }
  return sizeOf(chars, bytes);
}

/** A field's value in the frontmatter the agent reads, or undefined. */
function field(file: AgentFile, key: string): unknown {
  return file.source.kind === 'frontmatter' ? own(file.source.fields.values, key) : undefined;
}

/**
 * The prompt the definition gives its subagent: the body of its file, or Codex's
 * `developer_instructions`. Undefined when it is not in the repository, as for a role a Codex
 * `config.toml` declares without a file.
 */
function promptOf(file: AgentFile, view: LoadView): string | undefined {
  const { source } = file;
  if (source.kind === 'toml') {
    const value = isTable(source.doc.value)
      ? own(source.doc.value, 'developer_instructions')
      : undefined;
    return typeof value === 'string' ? value : undefined;
  }
  if (file.file.endsWith('.codex/config.toml')) return undefined;
  const artifact = source.kind === 'frontmatter' ? source.artifact : view.index.get(file.file);
  if (artifact === undefined) return undefined;
  return artifact.decoded.text.slice(bodyOffset(view.frontmatter(artifact)));
}

/**
 * Each definition's prompt part, measured once for every plan of a scan: the definitions are
 * shared ({@link agentFiles}), and a matrix or a run with `--by-directory` plans many sessions
 * that list the same subagents. `null` when the prompt is not in the repository.
 */
const PROMPTS = new WeakMap<AgentFile, OwnContextPart | null>();

function promptPart(file: AgentFile, view: LoadView): OwnContextPart | undefined {
  let part = PROMPTS.get(file);
  if (part === undefined) {
    const prompt = promptOf(file, view);
    // Every agent documents its file's body, or `developer_instructions`, as the prompt.
    part =
      prompt === undefined
        ? null
        : {
            kind: 'prompt',
            size: textSize(prompt),
            certainty: 'documented',
            evidence: file.evidence,
          };
    PROMPTS.set(file, part);
  }
  return part ?? undefined;
}

/** Roles of the instruction files a session loads at startup. */
const INSTRUCTION_ROLES: ReadonlySet<string> = new Set(['instructions', 'import', 'rule']);

/** What every subagent call of one session draws on, computed once per plan. */
interface Session {
  /** The instruction files the session loads at startup, summed; undefined without any. */
  readonly instructions: Size | undefined;
  /** The skills listing the session starts with, summed; undefined without one. */
  readonly listing: Size | undefined;
}

function sessionOf(plan: LoadPlan): Session {
  const files: Size[] = [];
  const listed: Size[] = [];
  for (const entry of plan.entries) {
    if (entry.trigger !== 'startup' || entry.size === undefined) continue;
    if (INSTRUCTION_ROLES.has(entry.role)) files.push(entry.size);
    if (entry.role === 'skill') listed.push(entry.size);
  }
  return {
    instructions: files.length === 0 ? undefined : sumOf(files),
    listing: listed.length === 0 ? undefined : sumOf(listed),
  };
}

/**
 * Whether a Codex custom agent starts with "the automatic skills instructions block": yes unless
 * its file sets `skills.include_instructions = false`, and with other skills when it changes
 * `skills.config` or `skills.bundled` (SOURCES.codexSubagents).
 */
function codexSkillsBlock(file: AgentFile): 'listed' | 'changed' | 'off' {
  if (file.source.kind !== 'toml' || !isTable(file.source.doc.value)) return 'listed';
  const skills = own(file.source.doc.value, 'skills');
  if (!isTable(skills)) return 'listed';
  if (own(skills, 'include_instructions') === false) return 'off';
  return own(skills, 'config') === undefined && own(skills, 'bundled') === undefined
    ? 'listed'
    : 'changed';
}

/**
 * Another agent's subagent: its prompt, as each agent documents, and what its documentation adds.
 * The Copilot CLI gives a custom agent the repository's instruction files only with
 * `include-custom-instructions: true` (SOURCES.copilotCliAgents); Codex adds its skills
 * instructions block. Whether instruction files reach the other agents' subagents is not
 * documented.
 */
function ownContextOf(file: AgentFile, session: Session, view: LoadView): OwnContext {
  // A Gemini CLI remote agent's instructions are in its agent card, outside the repository.
  const prompt = file.remote === true ? undefined : promptPart(file, view);
  const parts = prompt === undefined ? [] : [prompt];
  const copilotCli = file.agent === 'copilot-cli';
  if (copilotCli && field(file, 'include-custom-instructions') === true) {
    if (session.instructions !== undefined) {
      parts.push({
        kind: 'instructions',
        size: session.instructions,
        certainty: 'documented',
        evidence: ['copilotCliAgents'],
      });
    }
  }
  if (file.agent === 'codex' && session.listing !== undefined) {
    const block = codexSkillsBlock(file);
    if (block !== 'off') {
      parts.push({
        kind: 'listing',
        size: session.listing,
        certainty: block === 'listed' ? 'documented' : 'unverified',
        evidence: ['codexSubagents'],
      });
    }
  }
  const notVisible: OwnContextHidden[] = [
    ...(prompt === undefined ? (['prompt'] as const) : []),
    'environment',
    'task',
    'tools',
    ...(copilotCli ? [] : (['instructions'] as const)),
  ];
  return { size: sumOf(parts.map((part) => part.size)), parts, notVisible };
}

/** What every Claude Code subagent of one session draws on, computed once per plan. */
interface ClaudeSession extends Session {
  /** The session's skills by name, a listed one over one that loads later. */
  readonly skills: ReadonlyMap<string, LoadEntry>;
  /** The same skills by their directory's name, which also invokes a skill. */
  readonly folders: ReadonlyMap<string, LoadEntry>;
  /**
   * Skills on the session's path the scan did not read, by their directory's name: a preload
   * of one cannot be measured.
   */
  readonly unread: ReadonlyMap<string, string>;
  /** Skills `skillOverrides` turns off. */
  readonly off: ReadonlySet<string>;
  readonly memoryOff: boolean;
}

const UNREAD = new WeakMap<LoadView['snapshot'], ReadonlySet<string>>();

/**
 * Paths the walk saw but did not read, a symlink to a file outside the repository included: an
 * agent may read them, agentcheckup cannot measure them.
 */
function unreadPaths(view: LoadView): ReadonlySet<string> {
  let paths = UNREAD.get(view.snapshot);
  if (paths === undefined) {
    paths = new Set([
      ...view.snapshot.skipped
        .filter((entry) => entry.reason !== 'import-limit')
        .map((entry) => entry.path),
      ...view.snapshot.unresolvedSymlinks
        .filter((link) => link.problem === 'outside-root')
        .map((link) => link.path),
    ]);
    UNREAD.set(view.snapshot, paths);
  }
  return paths;
}

function claudeSession(plan: LoadPlan, view: LoadView): ClaudeSession {
  const skills = new Map<string, LoadEntry>();
  const folders = new Map<string, LoadEntry>();
  // A listed skill over one that loads later, as the session can invoke it now.
  const keep = (map: Map<string, LoadEntry>, key: string, entry: LoadEntry): void => {
    const known = map.get(key);
    if (known === undefined || (known.trigger !== 'startup' && entry.trigger === 'startup')) {
      map.set(key, entry);
    }
  };
  for (const entry of plan.entries) {
    if (entry.role !== 'skill' || entry.name === undefined) continue;
    keep(skills, entry.name, entry);
    if (basename(entry.path) === 'SKILL.md') {
      keep(folders, basename(dirnamePosix(entry.path)), entry);
    }
  }
  const onPath = new Set(selfAndAncestors(plan.cwd));
  const unread = new Map<string, string>();
  for (const path of unreadPaths(view)) {
    const folder = inClaudeFolder(path, 'skills');
    const parts = folder?.relative.split('/') ?? [];
    if (folder === undefined || !onPath.has(folder.owner) || parts.length !== 2) continue;
    if (parts[1] === 'SKILL.md' && parts[0] !== undefined) unread.set(parts[0], path);
  }
  const off = new Set(
    plan.skipped.flatMap((skip) =>
      skip.role === 'skill' && skip.code === 'disabled' && skip.name !== undefined
        ? [skip.name]
        : [],
    ),
  );
  return {
    ...sessionOf(plan),
    skills,
    folders,
    unread,
    off,
    memoryOff: autoMemoryOff(view, plan.cwd),
  };
}

/**
 * A Claude Code subagent's own context (SOURCES.claudeSubagents, "What loads at startup"): its
 * prompt; the instruction files the session loads at startup, unless `omitClaudeMd: true`; the
 * bodies of the skills `skills` preloads; and the agent memory `memory` adds.
 */
function claudeOwnContext(file: AgentFile, session: ClaudeSession, view: LoadView): OwnContext {
  const parts: OwnContextPart[] = [];
  const prompt = promptPart(file, view);
  if (prompt !== undefined) parts.push(prompt);

  const omitValue = field(file, 'omitClaudeMd');
  const omit = omitValue === true;
  if (!omit && session.instructions !== undefined) {
    parts.push({
      kind: 'instructions',
      size: session.instructions,
      // That the subagent gets the files the session loads at startup is documented; how sure
      // the plan is of each file, its order included, is in the plan's entries. Claude Code
      // reads `yes`, `on` and `1` as true in a skill's boolean fields; whether it does here is
      // not documented, so such a value may leave the files out.
      certainty: claudeBoolean(omitValue) === true ? 'unverified' : 'documented',
      evidence: ['claudeSubagents', 'claudeMemory'],
    });
  }

  const { preloaded, notLoaded, overLimit, unmeasured } = preloads(file, session);
  parts.push(...preloaded);
  const memory = session.memoryOff ? undefined : memoryOf(file, view);
  if (memory?.part !== undefined) parts.push(memory.part);
  if (memory?.unmeasured !== undefined) unmeasured.push(memory.unmeasured);
  const notVisible: OwnContextHidden[] = [
    'environment',
    'task',
    'tools',
    'git-status',
    ...(omit ? [] : (['user-instructions'] as const)),
    'managed-instructions',
  ];
  return {
    size: sumOf(parts.map((part) => part.size)),
    parts,
    ...(notLoaded.length === 0 ? {} : { notLoaded }),
    ...(overLimit === 0 ? {} : { overLimit }),
    ...(unmeasured.length === 0 ? {} : { unmeasured }),
    ...(memory === undefined ? {} : { memory: memory.memory }),
    notVisible,
  };
}

/** Each definition's `skills` names, read once for every plan of a scan. */
const PRELOAD_NAMES = new WeakMap<
  AgentFile,
  { readonly names: readonly string[]; readonly fromString: boolean }
>();

/**
 * The distinct skill names the `skills` field gives, in order. A YAML list is documented; a
 * comma-separated string is read like `tools`, which is not.
 */
function preloadNames(file: AgentFile): {
  readonly names: readonly string[];
  readonly fromString: boolean;
} {
  let known = PRELOAD_NAMES.get(file);
  if (known === undefined) {
    const value = field(file, 'skills');
    const fromString = typeof value === 'string';
    const raw = fromString
      ? value.split(',')
      : Array.isArray(value)
        ? (value as readonly unknown[]).filter((item): item is string => typeof item === 'string')
        : [];
    known = {
      names: [...new Set(raw.map((name) => name.trim()).filter((name) => name !== ''))],
      fromString,
    };
    PRELOAD_NAMES.set(file, known);
  }
  return known;
}

/**
 * The skills the `skills` field preloads, from the session's listing; those it names that the
 * subagent does not get; how many distinct names pass the first 32; and the skills it preloads
 * that the scan did not read. A comma-separated string's skills are unverified, as is a skill
 * found by its directory's name.
 */
function preloads(
  file: AgentFile,
  session: ClaudeSession,
): {
  readonly preloaded: OwnContextPart[];
  readonly notLoaded: PreloadNotLoaded[];
  readonly overLimit: number;
  readonly unmeasured: string[];
} {
  const { names, fromString } = preloadNames(file);
  const preloaded: OwnContextPart[] = [];
  const notLoaded: PreloadNotLoaded[] = [];
  const unmeasured: string[] = [];
  for (const name of names.slice(0, CLAUDE_PRELOAD_MAX_SKILLS)) {
    const byName = session.skills.get(name);
    const skill = byName ?? session.folders.get(name);
    const unread = skill === undefined ? session.unread.get(name) : undefined;
    if (skill?.trigger === 'startup' && skill.deferred !== undefined) {
      preloaded.push({
        kind: 'skill',
        path: skill.path,
        name,
        size: skill.deferred,
        certainty:
          fromString || byName === undefined || skill.certainty === 'unverified'
            ? 'unverified'
            : 'documented',
        evidence: ['claudeSubagents', 'claudeSkills'],
      });
    } else if (skill?.trigger === 'manual') {
      notLoaded.push({ name, reason: 'not-model-invocable' });
    } else if (session.off.has(name)) {
      notLoaded.push({ name, reason: 'off' });
    } else if (unread !== undefined) {
      unmeasured.push(unread);
    } else {
      notLoaded.push({ name, reason: 'not-found' });
    }
  }
  return {
    preloaded,
    notLoaded,
    overLimit: Math.max(0, names.length - CLAUDE_PRELOAD_MAX_SKILLS),
    unmeasured,
  };
}

/** A name Claude Code can make one folder of `.claude/agent-memory` from. */
function isFolderName(name: string): boolean {
  return name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
}

/** Claude Code adds "the first 200 lines or 25KB of `MEMORY.md`" (SOURCES.claudeSubagents). */
const MEMORY_MAX_LINES = 200;
const MEMORY_MAX_BYTES = 25 * 1024;

/** The part of a `MEMORY.md` Claude Code adds: its first 200 lines, cut at 25 KB. */
function memoryHead(text: string): string {
  let end = 0;
  for (let line = 0; line < MEMORY_MAX_LINES && end < text.length; line++) {
    const newline = text.indexOf('\n', end);
    end = newline === -1 ? text.length : newline + 1;
  }
  const head = text.slice(0, end);
  if (utf8ByteLength(head) <= MEMORY_MAX_BYTES) return head;
  let bytes = 0;
  let index = 0;
  for (const char of head) {
    const size = utf8ByteLength(char);
    if (bytes + size > MEMORY_MAX_BYTES) break;
    bytes += size;
    index += char.length;
  }
  return head.slice(0, index);
}

/**
 * The agent memory `memory` adds to the subagent's prompt (SOURCES.claudeSubagents, "Enable
 * persistent memory"), in `.claude/agent-memory/<name>/` beside the definition's `.claude`
 * folder: a `memory` part when the scan read the file, unmeasured when it did not. A name that
 * is not one folder name gives no path; the user's scope is never read.
 */
function memoryOf(
  file: AgentFile,
  view: LoadView,
):
  | {
      readonly memory: NonNullable<OwnContext['memory']>;
      readonly part?: OwnContextPart;
      readonly unmeasured?: string;
    }
  | undefined {
  const scope = field(file, 'memory');
  if (scope !== 'project' && scope !== 'local' && scope !== 'user') return undefined;
  if (scope === 'user' || file.name === undefined || !isFolderName(file.name)) {
    return { memory: { scope } };
  }
  const folder = scope === 'project' ? '.claude/agent-memory' : '.claude/agent-memory-local';
  const path = joinPath(file.scope, `${folder}/${file.name}/MEMORY.md`);
  const status = pathStatus(view.snapshot, path);
  const memory: NonNullable<OwnContext['memory']> = {
    scope,
    path,
    ...(status === 'unknown' ? {} : { exists: status !== 'missing' }),
  };
  const artifact = view.index.get(path);
  if (artifact?.kind === 'claude-agent-memory') {
    return {
      memory,
      part: {
        kind: 'memory',
        path,
        size: textSize(memoryHead(artifact.decoded.text)),
        certainty: 'documented',
        evidence: ['claudeSubagents'],
      },
    };
  }
  return status === 'exists' || unreadPaths(view).has(path)
    ? { memory, unmeasured: path }
    : { memory };
}

/**
 * Whether the working directory's `.claude/settings.json` and `.claude/settings.local.json`, the
 * local file winning on a key, turn auto memory off: `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` when
 * set to a true or false value, which "takes precedence over this key for one session, in either
 * direction", else `autoMemoryEnabled: false` (SOURCES.claudeSettingsReference).
 */
function autoMemoryOff(view: LoadView, cwd: string): boolean {
  const settings = claudeProjectSettings(view, cwd);
  const disable = lastSetting(settings, ['env', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY']);
  if (isTruthy(disable)) return true;
  if (isFalsy(disable)) return false;
  return lastSetting(settings, ['autoMemoryEnabled']) === false;
}

/** Whether a `.claude/agents` file is documentation, once per file for every plan of a scan. */
const DOCUMENTATION = new WeakMap<Artifact, boolean>();

function isDocumentation(view: LoadView, artifact: Artifact): boolean {
  let documentation = DOCUMENTATION.get(artifact);
  if (documentation === undefined) {
    documentation =
      checkSubagent(artifact.decoded.text, view.frontmatter(artifact)).status === 'documentation';
    DOCUMENTATION.set(artifact, documentation);
  }
  return documentation;
}

/**
 * Claude Code's warning threshold for the subagents' names and descriptions, measured on the
 * listing of a session started in `cwd`. Every subagent still loads past it: advice.
 */
function descriptionsLimit(entries: readonly LoadEntry[], cwd: string): LimitUsage[] {
  let chars = 0;
  let listed = 0;
  for (const entry of entries) {
    if (entry.trigger !== 'startup' || entry.size === undefined) continue;
    chars += entry.size.chars;
    listed++;
  }
  if (listed === 0) return [];
  return [
    {
      key: 'claude-code.agent_descriptions_tokens',
      label: 'subagents listing',
      unit: 'tokens',
      limit: CLAUDE_AGENT_DESCRIPTIONS_TOKENS,
      used: tokensOf(chars),
      subject: cwd,
      effect: 'advice',
      evidence: ['claudeSubagents'],
    },
  ];
}
