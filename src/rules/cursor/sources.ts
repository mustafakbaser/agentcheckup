import type { RuleSource } from '../../core/types.js';
import { SOURCES } from '../../platforms/sources.js';

/** Evidence used only by Cursor rules, in addition to the shared SOURCES. Checked 2026-10-14. */
const CHECKED = '2026-10-14';

/** Sources re-read on 2026-10-30, after the Source drift workflow found them changed. */
const AUDIT_CHECKED = '2026-10-30';

const verified = (title: string, url: string, checked = CHECKED): RuleSource => ({
  title,
  url,
  checked,
  status: 'verified',
});

export const CURSOR_SOURCES = {
  // Shared with the Cursor load plan.
  cursorRulesHelp: SOURCES.cursorRulesHelp,
  devinCliRules: verified(
    'Devin CLI: Rules (reads .cursor/rules/*.md and *.mdc)',
    'https://docs.devin.ai/cli/extensibility/rules',
    AUDIT_CHECKED,
  ),
} as const satisfies Record<string, RuleSource>;
