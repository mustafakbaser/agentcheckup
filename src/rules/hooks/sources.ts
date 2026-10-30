import type { RuleSource } from '../../core/types.js';
import { SOURCES } from '../../platforms/sources.js';

/** Evidence used only by the hooks family. Checked 2026-10-14. */
const CHECKED = '2026-10-14';

const verified = (title: string, url: string): RuleSource => ({
  title,
  url,
  checked: CHECKED,
  status: 'verified',
});

export const HOOK_SOURCES = {
  // Shared with the Codex load plan, which cites them by key.
  codexHookConfig: SOURCES.codexHookConfig,
  codexHookEvents: SOURCES.codexHookEvents,
  codexHookDiscovery: SOURCES.codexHookDiscovery,
  geminiHookReference: verified(
    'Gemini CLI: Hooks reference',
    'https://geminicli.com/docs/hooks/reference',
  ),
  geminiHookRegistry: verified(
    'Gemini CLI source: hookRegistry.ts (invalid event names are skipped)',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/hooks/hookRegistry.ts',
  ),
  geminiHookRunner: verified(
    'Gemini CLI source: hookRunner.ts (timeout in milliseconds)',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/hooks/hookRunner.ts',
  ),
} as const satisfies Record<string, RuleSource>;
