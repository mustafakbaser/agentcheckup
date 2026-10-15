import type { RuleSource } from '../../core/types.js';
import { SOURCES } from '../../platforms/sources.js';

/**
 * Evidence used only by instruction-file rules, in addition to the shared SOURCES.
 * Checked 2026-10-14. Source-code links point at the default branch; the behavior was read at
 * openai/codex 50d77959 (2026-09-16) and google-gemini/gemini-cli ff00dacd (2026-07-01).
 */
const CHECKED = '2026-10-14';

const verified = (title: string, url: string): RuleSource => ({
  title,
  url,
  checked: CHECKED,
  status: 'verified',
});

const unverified = (title: string, url: string): RuleSource => ({
  title,
  url,
  checked: CHECKED,
  status: 'unverified',
});

export const INSTRUCTION_SOURCES = {
  // Shared with the Codex load plan, which cites them by key.
  codexDefaults: SOURCES.codexDefaults,
  codexFindUp: SOURCES.codexFindUp,
  geminiImportSource: verified(
    'Gemini CLI source: memoryImportProcessor.ts',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryImportProcessor.ts',
  ),
  geminiDiscoverySource: verified(
    'Gemini CLI source: memoryDiscovery.ts (reads GEMINI.md as UTF-8)',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryDiscovery.ts',
  ),
  cascadeAgentsMd: verified(
    'Devin Desktop (Cascade): AGENTS.md ("Both AGENTS.md and agents.md are recognized")',
    'https://docs.devin.ai/desktop/cascade/agents-md',
  ),
  gitCoreSymlinks: verified(
    'Git: core.symlinks',
    'https://git-scm.com/docs/git-config#Documentation/git-config.txt-coresymlinks',
  ),
  claudeRuleImportsUndocumented: unverified(
    'Claude Code: Memory (imports are documented for CLAUDE.md, CLAUDE.local.md, AGENTS.md and user-level rules, not for project .claude/rules files)',
    'https://code.claude.com/docs/en/memory',
  ),
  claudeSymlinkImportsUndocumented: {
    title:
      'Claude Code: Memory (CLAUDE.md is read through a symlink; whether its relative imports then resolve from the link or from its target is not documented)',
    url: 'https://code.claude.com/docs/en/memory',
    checked: '2026-10-15',
    status: 'unverified',
  },
  geminiImportBaseSource: {
    title:
      "Gemini CLI source: memoryDiscovery.ts (reads each GEMINI.md at the path it found, through symlinks, and resolves its imports from that path's directory)",
    url: 'https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryDiscovery.ts',
    checked: '2026-10-15',
    status: 'verified',
  },
  claudeImportCyclesUndocumented: unverified(
    'Claude Code: Memory (how import cycles are handled is not documented)',
    'https://code.claude.com/docs/en/memory',
  ),
  claudeEncodingUndocumented: unverified(
    'Claude Code: Memory (file encoding is not documented)',
    'https://code.claude.com/docs/en/memory',
  ),
  windsurfOverLimitUndocumented: unverified(
    'Devin Desktop (Windsurf): what happens past the 12,000-character limit is not documented',
    'https://docs.devin.ai/desktop/cascade/memories',
  ),
  evaluatingAgentsMd: verified(
    'Gloaguen et al., Evaluating AGENTS.md (arXiv:2602.11988)',
    'https://arxiv.org/abs/2602.11988',
  ),
  aaifEffectiveAgentsMd: verified(
    'Agentic AI Foundation: Writing an effective AGENTS.md',
    'https://aaif.io/blog/writing-an-effective-agents-md',
  ),
  augmentAgentsMd: verified(
    'Augment Code: How to write good AGENTS.md files',
    'https://www.augmentcode.com/blog/how-to-write-good-agents-dot-md-files',
  ),
} as const satisfies Record<string, RuleSource>;
