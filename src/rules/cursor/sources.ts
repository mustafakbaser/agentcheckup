import type { RuleSource } from '../../core/types.js';
import { SOURCES } from '../../platforms/sources.js';

/** Evidence used only by Cursor rules, in addition to the shared SOURCES. Checked 2026-10-14. */
const CHECKED = '2026-10-14';

const verified = (title: string, url: string): RuleSource => ({
  title,
  url,
  checked: CHECKED,
  status: 'verified',
});

export const CURSOR_SOURCES = {
  // Shared with the Cursor load plan.
  cursorRulesHelp: SOURCES.cursorRulesHelp,
  devinCliRules: verified(
    'Devin CLI: Rules (reads .cursor/rules/*.md and *.mdc)',
    'https://docs.devin.ai/cli/extensibility/rules',
  ),
} as const satisfies Record<string, RuleSource>;
