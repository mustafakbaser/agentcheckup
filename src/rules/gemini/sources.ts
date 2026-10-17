import type { RuleSource } from '../../core/types.js';

/** Evidence used only by Gemini CLI rules, in addition to the shared SOURCES. */
const CHECKED = '2026-10-17';

export const GEMINI_SOURCES = {
  settingsValidation: {
    title:
      'Gemini CLI source: settings-validation.ts (unknown top-level settings keys are kept, not read)',
    url: 'https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settings-validation.ts',
    checked: CHECKED,
    status: 'verified',
  },
  settingsMigration: {
    title:
      'Gemini CLI 0.23.0 source: settings.ts (MIGRATION_MAP, the last release that moved top-level keys)',
    url: 'https://github.com/google-gemini/gemini-cli/blob/v0.23.0/packages/cli/src/config/settings.ts',
    checked: CHECKED,
    status: 'verified',
  },
} as const satisfies Record<string, RuleSource>;
