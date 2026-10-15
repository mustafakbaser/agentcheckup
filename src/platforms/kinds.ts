import type { ArtifactKind } from '../core/types.js';

/** Kinds whose content is Markdown (optionally with YAML frontmatter). */
export const MARKDOWN_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'agents-md',
  'agents-override-md',
  'claude-md',
  'claude-local-md',
  'claude-rule',
  'claude-agent',
  'claude-command',
  'skill',
  'cursor-rule',
  'cursor-rule-md',
  'cursor-legacy-rules',
  'copilot-instructions',
  'copilot-path-instructions',
  'gemini-md',
  'windsurf-rule',
  'windsurf-legacy-rules',
  'cline-rule',
]);

/** Kinds whose content is JSON. */
export const JSON_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'claude-settings',
  'claude-plugin-manifest',
  'cursor-hooks',
  'cursor-mcp',
  'gemini-settings',
  'mcp-json',
  'codex-hooks',
]);

/**
 * Markdown kinds plus `imported-file`: a file that an instruction file imports with `@path`
 * (README.md, docs/guide.md), which Claude Code and Gemini CLI load with it. Their text reaches
 * the model like the importing file's, so the checks for hidden text (risk/hidden-unicode,
 * risk/hidden-comment), analysis/partial and inline suppression directives cover them too.
 */
export const MARKDOWN_OR_IMPORTED_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  ...MARKDOWN_KINDS,
  'imported-file',
]);
