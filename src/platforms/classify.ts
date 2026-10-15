import type { ArtifactKind, PlatformId } from '../core/types.js';

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
 */

/** Platforms that read each artifact kind. */
export const READERS: Readonly<Record<ArtifactKind, readonly PlatformId[]>> = {
  'agents-md': ['claude-code', 'cline', 'codex', 'copilot', 'cursor', 'windsurf'],
  'agents-override-md': ['codex'],
  'claude-md': ['claude-code', 'copilot', 'cursor', 'windsurf'],
  'claude-local-md': ['claude-code'],
  'claude-rule': ['claude-code'],
  'claude-agent': ['claude-code'],
  'claude-command': ['claude-code'],
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
  'gemini-md': ['copilot', 'gemini'],
  'gemini-settings': ['gemini'],
  'mcp-json': ['claude-code', 'copilot', 'windsurf'],
  'codex-hooks': ['codex'],
  'windsurf-rule': ['windsurf'],
  'windsurf-legacy-rules': ['cline', 'windsurf'],
  'cline-rule': ['cline'],
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
  /** Canonical spelling of the case-sensitive part, used to detect case mismatches. */
  readonly canonical: (path: string) => string;
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const keepPath = (path: string): string => path;
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

  // Cline
  {
    kind: 'cline-rule',
    pattern: /(?:^|\/)\.(?:clinerules|cline\/rules)\/(?:[^/]+\/)*[^/]+\.md$/,
    canonical: keepPath,
  },
];

/**
 * Classifies a POSIX path relative to the scan root. Returns undefined for files agentcheck
 * does not read. Matching is case-insensitive so that `Agents.md` is found and can be flagged.
 */
export function classify(path: string): Classification | undefined {
  const lower = path.toLowerCase();
  for (const matcher of MATCHERS) {
    if (!matcher.pattern.test(lower)) continue;
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
    lower === '.cursorrules' ||
    lower === '.windsurfrules'
  );
}
