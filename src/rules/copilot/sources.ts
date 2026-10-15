import type { RuleSource } from '../../core/types.js';

/** Evidence used only by Copilot rules, in addition to the shared SOURCES. Checked 2026-10-14. */
const CHECKED = '2026-10-14';

export const COPILOT_SOURCES = {
  vscodeInstructions: {
    title: 'VS Code: Custom instructions',
    url: 'https://code.visualstudio.com/docs/agent-customization/custom-instructions',
    checked: CHECKED,
    status: 'verified',
  },
  excludeAgentChangelog: {
    title: 'GitHub changelog, 2025-11-12: agent-specific instructions ("coding-agent")',
    url: 'https://github.blog/changelog/2025-11-12-copilot-code-review-and-coding-agent-now-support-agent-specific-instructions/',
    checked: CHECKED,
    status: 'unverified',
  },
} as const satisfies Record<string, RuleSource>;
