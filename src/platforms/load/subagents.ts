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
 *   session's: it is not part of the plan's totals.
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
import { codePointLength, utf8ByteLength } from '../../core/measure.js';
import type { Artifact } from '../../core/types.js';
import { own } from '../../parse/json-access.js';
import { type AgentFile, agentFiles } from '../agent-files.js';
import { inClaudeFolder, nearestGitRoot } from '../paths.js';
import { readingsOf } from '../readings.js';
import { checkSubagent } from '../subagents.js';
import { compareEntries, compareOutOfScope, compareSkips } from './order.js';
import type {
  Certainty,
  ContextAgent,
  LimitUsage,
  LoadEntry,
  LoadPlan,
  OutOfScope,
  Size,
  SkippedLoad,
} from './types.js';
import type { LoadView } from './view.js';

/** Claude Code warns when the subagents' names and descriptions pass this many tokens. */
export const CLAUDE_AGENT_DESCRIPTIONS_TOKENS = 15_000;

/** Characters per token, the same estimate as `Size.tokens`. */
const CHARS_PER_TOKEN = 4;

function sizeOf(chars: number, bytes: number): Size {
  return { bytes, chars, tokens: Math.ceil(chars / CHARS_PER_TOKEN) };
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

  const onPath: AgentFile[] = [];
  for (const file of agentFiles(view)) {
    if (file.agent !== agent) continue;
    const place = placeFor(agent, file.scope, cwd, repositoryRoot);
    if (place === 'below') out(file.file, 'below-start-dir');
    if (place !== 'path' || !insideRepository(file.scope)) continue;
    onPath.push(file);
  }

  // Of one name on the path, one definition wins ({@link precedes}).
  const closest = new Map<string, AgentFile>();
  for (const file of onPath) {
    if (file.status !== 'loads' || file.key === '') continue;
    const known = closest.get(file.key);
    if (known === undefined || precedes(agent, file, known)) closest.set(file.key, file);
  }
  const documentedOrder = claude || agent === 'copilot-cli';

  for (const file of onPath) {
    const base = { role: 'subagent', path: file.file, evidence: file.evidence } as const;
    const name = file.name === undefined ? {} : { name: file.name };
    const winner = file.status === 'loads' && file.key !== '' ? closest.get(file.key) : undefined;
    if (winner !== undefined && winner !== file) {
      skipped.push({
        ...base,
        id: entryId(file),
        ...name,
        code: 'shadowed-by-preferred',
        certainty: documentedOrder ? 'documented' : 'unverified',
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
          reading.kind === 'claude-agent' ? inClaudeFolder(reading.path, 'agents') : undefined;
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
      used: Math.ceil(chars / CHARS_PER_TOKEN),
      subject: cwd,
      effect: 'advice',
      evidence: ['claudeSubagents'],
    },
  ];
}
