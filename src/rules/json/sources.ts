import type { RuleSource } from '../../core/types.js';

/** Evidence used only by the json family. Checked 2026-10-14. */
const CHECKED = '2026-10-14';

/** Sources re-read on 2026-10-30, after the Source drift workflow found them changed. */
const AUDIT_CHECKED = '2026-10-30';

const verified = (title: string, url: string, checked = CHECKED): RuleSource => ({
  title,
  url,
  checked,
  status: 'verified',
});

export const JSON_SOURCES = {
  claudePluginTroubleshooting: verified(
    'Claude Code: Troubleshoot plugins (corrupt manifest file, Invalid JSON syntax)',
    'https://code.claude.com/docs/en/plugins/troubleshooting',
    AUDIT_CHECKED,
  ),
  codexHookDiscovery: verified(
    'Codex source: hooks/src/engine/discovery.rs (failed to parse hooks config)',
    'https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs',
    AUDIT_CHECKED,
  ),
  geminiSettingsLoader: verified(
    'Gemini CLI source: packages/cli/src/config/settings.ts (strip-json-comments, FatalConfigError)',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settings.ts',
    AUDIT_CHECKED,
  ),
  ecmaJsonParse: verified(
    'ECMA-262: ParseJSON (duplicate names: lexically preceding values are overwritten)',
    'https://tc39.es/ecma262/multipage/structured-data.html#sec-ParseJSON',
    AUDIT_CHECKED,
  ),
  rfc8259Objects: verified(
    'RFC 8259, section 4: names within an object SHOULD be unique',
    'https://www.rfc-editor.org/rfc/rfc8259#section-4',
  ),
  cursorStrictness: {
    title: 'Cursor forum: "The mcp.json parser can\'t handle JavaScript comments" (user report)',
    url: 'https://forum.cursor.com/t/two-flaws-with-mcp-json/92529',
    checked: AUDIT_CHECKED,
    status: 'unverified',
  },
} as const satisfies Record<string, RuleSource>;
