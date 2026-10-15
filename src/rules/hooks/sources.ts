import type { RuleSource } from '../../core/types.js';

/** Evidence used only by the hooks family. Checked 2026-10-14. */
const CHECKED = '2026-10-14';

const verified = (title: string, url: string): RuleSource => ({
  title,
  url,
  checked: CHECKED,
  status: 'verified',
});

export const HOOK_SOURCES = {
  codexHookConfig: verified(
    'Codex source: hook_config.rs (event names, hooks.json schema)',
    'https://github.com/openai/codex/blob/main/codex-rs/config/src/hook_config.rs',
  ),
  codexHookDiscovery: verified(
    'Codex source: hooks/src/engine/discovery.rs (parse errors, timeouts)',
    'https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs',
  ),
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
