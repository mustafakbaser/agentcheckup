import type { ArtifactKind, PlatformId, SourceFile } from '../core/types.js';
import { clinePlace } from './cline-rules.js';

/**
 * Path-based classification of agent configuration files.
 *
 * Sources (checked 2026-10-14):
 * - Claude Code memory, skills, settings, hooks, MCP, plugins: https://code.claude.com/docs/en/memory
 * - Codex AGENTS.md: https://learn.chatgpt.com/docs/agent-configuration/agents-md
 * - Cursor rules: https://cursor.com/docs/rules
 * - Copilot instructions: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions
 * - Gemini CLI: https://geminicli.com/docs/cli/gemini-md/
 * - Windsurf / Devin Desktop: https://docs.devin.ai/desktop/cascade/memories
 * - Cline: https://docs.cline.bot/customization/cline-rules
 * - Agent Skills: https://agentskills.io/specification
 * - Per-agent details and every source: docs/platforms.md
 *
 * Hook, MCP and settings files of Copilot, VS Code, Devin Local and Codex (checked 2026-10-17):
 * SOURCES.copilotHooksReference, copilotCliMcp, vscodeMcp, devinCliHooks, devinCliMcp,
 * devinReadConfigFrom, codexConfigLoader and clineConfig in src/platforms/sources.ts.
 */

/** Platforms that read each artifact kind. */
export const READERS: Readonly<Record<ArtifactKind, readonly PlatformId[]>> = {
  'agents-md': ['claude-code', 'cline', 'codex', 'copilot', 'cursor', 'windsurf'],
  'agents-override-md': ['codex'],
  'claude-md': ['claude-code', 'copilot', 'cursor', 'windsurf'],
  'claude-local-md': ['claude-code'],
  // The Copilot CLI and VS Code read `.claude/rules` as instructions files
  // (SOURCES.copilotCliReference, SOURCES.vscodeInstructions).
  'claude-rule': ['claude-code', 'copilot'],
  'claude-agent': ['claude-code'],
  // A subagent's memory, which Claude Code adds to its prompt (SOURCES.claudeSubagents).
  'claude-agent-memory': ['claude-code'],
  // The Copilot CLI reads commands as skills (SOURCES.copilotCliReference), and Devin Local
  // imports them as skills (SOURCES.devinReadConfigFrom).
  'claude-command': ['claude-code', 'copilot', 'windsurf'],
  // Cursor, the Copilot CLI and Devin Local also run hooks defined in Claude Code settings.
  'claude-settings': ['claude-code', 'copilot', 'cursor', 'windsurf'],
  'claude-plugin-manifest': ['claude-code'],
  skill: ['claude-code', 'cline', 'codex', 'copilot', 'cursor', 'gemini', 'windsurf'],
  // Devin Local (Windsurf) reads .cursor/rules/*.md and *.mdc; Cursor itself ignores .md there.
  'cursor-rule': ['cursor', 'windsurf'],
  'cursor-rule-md': ['windsurf'],
  'cursor-legacy-rules': ['cline', 'cursor'],
  'cursor-hooks': ['cursor'],
  'cursor-mcp': ['cursor', 'windsurf'],
  'copilot-instructions': ['copilot'],
  'copilot-path-instructions': ['copilot'],
  'copilot-hooks': ['copilot'],
  'copilot-mcp': ['copilot'],
  'copilot-settings': ['copilot'],
  'vscode-mcp': ['copilot'],
  'gemini-md': ['copilot', 'gemini'],
  'gemini-settings': ['gemini'],
  'mcp-json': ['claude-code', 'copilot', 'windsurf'],
  'codex-hooks': ['codex'],
  'codex-config': ['codex'],
  'windsurf-rule': ['windsurf'],
  'windsurf-legacy-rules': ['cline', 'windsurf'],
  'devin-config': ['windsurf'],
  'devin-mcp': ['windsurf'],
  'devin-hooks': ['windsurf'],
  'cline-rule': ['cline'],
  'cline-workflow': ['cline'],
  // Custom agents and subagents (src/agents). Cursor also reads `.claude/agents` and Copilot
  // reads it too; src/agents models those reads, so `claude-agent` keeps its one reader here.
  'codex-agent': ['codex'],
  'cursor-agent': ['cursor'],
  'gemini-agent': ['gemini'],
  'copilot-agent': ['copilot'],
  'devin-agent': ['windsurf'],
  // Not a location the classifier matches: a file an instruction file imports (`@README.md`),
  // which the agents that expand imports load: Claude Code, Gemini CLI and the Copilot CLI
  // (src/io/imports.ts). See SourceFile.imported.
  'imported-file': ['claude-code', 'copilot', 'gemini'],
};

export interface Classification {
  readonly kind: ArtifactKind;
  /** Present when the path matched only case-insensitively. */
  readonly caseMismatch?: { readonly expected: string };
}

interface Matcher {
  readonly kind: ArtifactKind;
  /** Tested against the lower-cased path. Anchored, linear-time patterns only. */
  readonly pattern: RegExp;
  /** A further test on the path, for layouts a pattern does not express well. */
  readonly where?: (path: string) => boolean;
  /** Canonical spelling of the case-sensitive part, used to detect case mismatches. */
  readonly canonical: (path: string) => string;
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const keepPath = (path: string): string => path;

/**
 * Instruction file names that keep their own kind directly in an agent folder, where an
 * `AGENTS.md` or `GEMINI.md` documents the folder: the matchers below them read them so.
 */
const FOLDER_INSTRUCTIONS: ReadonlySet<string> = new Set(['agents.md', 'gemini.md']);
const notFolderInstructions = (path: string): boolean =>
  !FOLDER_INSTRUCTIONS.has(basename(path).toLowerCase());

/**
 * Devin Local's agent files: `agents/<name>.md`, or `agents/<name>/` with `AGENT.md`, `agent.md`,
 * `AGENTS.md` or `agents.md` (SOURCES.devinSubagents). Directly in the folder, an `AGENTS.md`
 * documents it.
 */
const isDevinAgentFile = (path: string): boolean => {
  const parent = basename(path.slice(0, path.lastIndexOf('/')));
  return parent.toLowerCase() !== 'agents' || notFolderInstructions(path);
};
const withBase =
  (canonicalBase: string) =>
  (path: string): string =>
    path.slice(0, path.lastIndexOf('/') + 1) + canonicalBase;

/**
 * Order matters: the first match wins. More specific locations come before generic names.
 * All patterns are matched against the lower-cased POSIX path.
 */
const MATCHERS: readonly Matcher[] = [
  // Skills: any SKILL.md. Location-specific checks are left to rules, because skill roots
  // differ per platform (.claude/skills, .agents/skills, .cursor/skills, .github/skills, ...).
  { kind: 'skill', pattern: /(?:^|\/)skill\.md$/, canonical: withBase('SKILL.md') },

  // Claude Code. Files inside rules/, agents/ and commands/ keep that role even when they are
  // named CLAUDE.md, so those directory matchers come before the file-name matchers.
  {
    kind: 'claude-rule',
    pattern: /(?:^|\/)\.claude\/rules\/(?:[^/]+\/)*[^/]+\.md$/,
    canonical: keepPath,
  },
  {
    kind: 'claude-agent',
    pattern: /(?:^|\/)\.claude\/agents\/(?:[^/]+\/)*[^/]+\.md$/,
    canonical: keepPath,
  },
  {
    kind: 'claude-agent-memory',
    pattern: /(?:^|\/)\.claude\/agent-memory(?:-local)?\/[^/]+\/memory\.md$/,
    canonical: keepPath,
  },
  {
    kind: 'claude-command',
    pattern: /(?:^|\/)\.claude\/commands\/(?:[^/]+\/)*[^/]+\.md$/,
    canonical: keepPath,
  },
  {
    kind: 'claude-local-md',
    pattern: /(?:^|\/)claude\.local\.md$/,
    canonical: withBase('CLAUDE.local.md'),
  },
  { kind: 'claude-md', pattern: /(?:^|\/)claude\.md$/, canonical: withBase('CLAUDE.md') },
  {
    kind: 'claude-settings',
    pattern: /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/,
    canonical: keepPath,
  },
  {
    kind: 'claude-plugin-manifest',
    pattern: /(?:^|\/)\.claude-plugin\/plugin\.json$/,
    canonical: keepPath,
  },
  { kind: 'mcp-json', pattern: /(?:^|\/)\.mcp\.json$/, canonical: keepPath },

  // Codex
  {
    kind: 'agents-override-md',
    pattern: /(?:^|\/)agents\.override\.md$/,
    canonical: withBase('AGENTS.override.md'),
  },
  { kind: 'codex-hooks', pattern: /(?:^|\/)\.codex\/hooks\.json$/, canonical: keepPath },
  { kind: 'codex-config', pattern: /(?:^|\/)\.codex\/config\.toml$/, canonical: keepPath },
  // Custom agents: one TOML file per agent, subfolders included (SOURCES.codexSubagents).
  {
    kind: 'codex-agent',
    pattern: /(?:^|\/)\.codex\/agents\/(?:[^/]+\/)*[^/]+\.toml$/,
    canonical: keepPath,
  },
  // Cursor's subagents, and the Markdown files it reads from `.codex/agents` ("Codex
  // compatibility"), where Codex itself reads only TOML (SOURCES.cursorSubagents).
  {
    kind: 'cursor-agent',
    pattern: /(?:^|\/)\.(?:cursor|codex)\/agents\/(?:[^/]+\/)*[^/]+\.md$/,
    where: notFolderInstructions,
    canonical: keepPath,
  },
  // Gemini CLI reads `.gemini/agents/*.md`, not subfolders (SOURCES.geminiSubagents).
  {
    kind: 'gemini-agent',
    pattern: /(?:^|\/)\.gemini\/agents\/[^/]+\.md$/,
    where: notFolderInstructions,
    canonical: keepPath,
  },
  // Copilot's custom agents; the VS Code agent reads only the folder itself, the CLI subfolders
  // too (SOURCES.vscodeCustomAgents, SOURCES.copilotCliAgents).
  {
    kind: 'copilot-agent',
    pattern: /(?:^|\/)\.github\/agents\/(?:[^/]+\/)*[^/]+\.md$/,
    where: notFolderInstructions,
    canonical: keepPath,
  },
  {
    kind: 'devin-agent',
    pattern: /(?:^|\/)\.(?:devin|agents)\/agents\/(?:[^/]+\/agents?|[^/]+)\.md$/,
    where: isDevinAgentFile,
    canonical: keepPath,
  },

  // Cross-agent
  { kind: 'agents-md', pattern: /(?:^|\/)agents\.md$/, canonical: withBase('AGENTS.md') },

  // Cursor
  {
    kind: 'cursor-rule',
    pattern: /(?:^|\/)\.cursor\/rules\/(?:[^/]+\/)*[^/]+\.mdc$/,
    canonical: keepPath,
  },
  {
    kind: 'cursor-rule-md',
    pattern: /(?:^|\/)\.cursor\/rules\/(?:[^/]+\/)*[^/]+\.md$/,
    canonical: keepPath,
  },
  { kind: 'cursor-legacy-rules', pattern: /(?:^|\/)\.cursorrules$/, canonical: keepPath },
  { kind: 'cursor-hooks', pattern: /(?:^|\/)\.cursor\/hooks\.json$/, canonical: keepPath },
  { kind: 'cursor-mcp', pattern: /(?:^|\/)\.cursor\/mcp\.json$/, canonical: keepPath },

  // GitHub Copilot. Misplaced *.instructions.md files are classified too, so a rule can flag them.
  {
    kind: 'copilot-instructions',
    pattern: /(?:^|\/)copilot-instructions\.md$/,
    canonical: keepPath,
  },
  {
    kind: 'copilot-path-instructions',
    pattern: /(?:^|\/)[^/]+\.instructions\.md$/,
    canonical: keepPath,
  },
  { kind: 'copilot-hooks', pattern: /(?:^|\/)\.github\/hooks\/[^/]+\.json$/, canonical: keepPath },
  { kind: 'copilot-mcp', pattern: /(?:^|\/)\.github\/mcp\.json$/, canonical: keepPath },
  {
    kind: 'copilot-settings',
    pattern: /(?:^|\/)\.github\/copilot\/settings(?:\.local)?\.json$/,
    canonical: keepPath,
  },
  // VS Code's MCP configuration, which its Copilot agent reads.
  { kind: 'vscode-mcp', pattern: /(?:^|\/)\.vscode\/mcp\.json$/, canonical: keepPath },

  // Gemini CLI
  { kind: 'gemini-md', pattern: /(?:^|\/)gemini\.md$/, canonical: withBase('GEMINI.md') },
  { kind: 'gemini-settings', pattern: /(?:^|\/)\.gemini\/settings\.json$/, canonical: keepPath },

  // Windsurf / Devin Desktop
  {
    kind: 'windsurf-rule',
    pattern: /(?:^|\/)\.(?:windsurf|devin)\/rules\/[^/]+\.md$/,
    canonical: keepPath,
  },
  { kind: 'windsurf-legacy-rules', pattern: /(?:^|\/)\.windsurfrules$/, canonical: keepPath },
  {
    kind: 'devin-config',
    pattern: /(?:^|\/)\.devin\/config(?:\.local)?\.json$/,
    canonical: keepPath,
  },
  {
    kind: 'devin-mcp',
    pattern: /(?:^|\/)\.devin\/mcp_config(?:\.local)?\.json$/,
    canonical: keepPath,
  },
  // `hooks.v1.json` for Devin Local, `hooks.json` for Cascade.
  { kind: 'devin-hooks', pattern: /(?:^|\/)\.devin\/hooks(?:\.v1)?\.json$/, canonical: keepPath },

  // Cline. Workflows are commands, not rules; files in the hooks and skills folders of
  // .clinerules are not rules either (clinePlace).
  {
    kind: 'cline-workflow',
    pattern: /(?:^|\/)\.(?:clinerules|cline)\/workflows\/(?:[^/]+\/)*[^/]+\.md$/,
    where: (path) => clinePlace(path)?.role === 'workflow',
    canonical: keepPath,
  },
  {
    kind: 'cline-rule',
    pattern: /(?:^|\/)\.(?:clinerules|cline\/rules)\/(?:[^/]+\/)*[^/]+\.md$/,
    where: (path) => clinePlace(path)?.role === 'rule',
    canonical: keepPath,
  },
];

/**
 * Classifies a POSIX path relative to the scan root. Returns undefined for files agentcheckup
 * does not read. Matching is case-insensitive so that `Agents.md` is found and can be flagged.
 */
export function classify(path: string): Classification | undefined {
  const lower = path.toLowerCase();
  for (const matcher of MATCHERS) {
    if (!matcher.pattern.test(lower)) continue;
    if (matcher.where !== undefined && !matcher.where(path)) continue;
    const expected = matcher.canonical(path);
    // Only the canonical, case-sensitive file names (AGENTS.md, CLAUDE.md, SKILL.md, ...) can
    // mismatch. Directory names like `.cursor/rules` are lowercase by convention and in docs.
    if (expected !== path && basename(expected) !== basename(path)) {
      if (!isPlausibleMisspelling(path)) return undefined;
      return { kind: matcher.kind, caseMismatch: { expected } };
    }
    return { kind: matcher.kind };
  }
  return undefined;
}

const IMPORTED_FILE: Classification = { kind: 'imported-file' };

/**
 * A snapshot file's classification: `classify()` of its path, or `imported-file` for a file the
 * walker read only because an instruction file imports it and that no pattern matches.
 */
export function classifyFile(
  file: Pick<SourceFile, 'path' | 'imported'>,
): Classification | undefined {
  return classify(file.path) ?? (file.imported === true ? IMPORTED_FILE : undefined);
}

/**
 * Case variants are reported only where a person plausibly meant the agent file. In real
 * repositories most lower-case `agents.md`, `gemini.md` or `skill.md` files are documentation
 * pages (`docs/ai/agents.md`), so an all-lower-case name counts only at the scan root, or as
 * `skill.md` directly inside a `skills/<name>/` directory. Mixed case (`Agents.md`) counts anywhere.
 */
function isPlausibleMisspelling(path: string): boolean {
  const name = basename(path);
  if (name !== name.toLowerCase()) return true;
  const segments = path.split('/');
  if (segments.length === 1) return true;
  return name === 'skill.md' && segments.length >= 3 && segments[segments.length - 3] === 'skills';
}

/** Cheap pre-filter for the walker: could a file with this base name be a candidate? */
export function isCandidateBasename(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith('.md') ||
    lower.endsWith('.mdc') ||
    lower.endsWith('.json') ||
    // `config.toml` and the agent files in `.codex/agents`; the classifier decides.
    lower.endsWith('.toml') ||
    lower === '.cursorrules' ||
    lower === '.windsurfrules'
  );
}
