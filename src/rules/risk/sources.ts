import type { RuleSource } from '../../core/types.js';

/** Evidence used only by the risk family. Checked 2026-10-14. */
const CHECKED = '2026-10-14';

/** Sources re-read on 2026-10-30, after the Source drift workflow found them changed. */
const AUDIT_CHECKED = '2026-10-30';

export const RISK_SOURCES = {
  trojanSource: {
    title:
      'Boucher and Anderson, "Trojan Source: Invisible Vulnerabilities" (USENIX Security 2023)',
    url: 'https://arxiv.org/abs/2111.00169',
    checked: AUDIT_CHECKED,
    status: 'verified',
  },
  asciiSmuggling: {
    title: 'Embrace The Red: ASCII Smuggler, hiding text in Unicode tag characters',
    url: 'https://embracethered.com/blog/posts/2024/hiding-and-finding-text-with-unicode-tags/',
    checked: CHECKED,
    status: 'verified',
  },
  emojiTagSequences: {
    title: 'Unicode Technical Standard #51: Unicode Emoji (emoji tag sequences, Annex C)',
    url: 'https://www.unicode.org/reports/tr51/',
    checked: CHECKED,
    status: 'verified',
  },
  variationSelectorSmuggling: {
    title: 'Paul Butler: Smuggling arbitrary data through an emoji',
    url: 'https://paulbutler.org/2025/smuggling-arbitrary-data-through-an-emoji/',
    checked: CHECKED,
    status: 'verified',
  },
  claudeSecurity: {
    title: 'Claude Code: Security (network command approval)',
    url: 'https://code.claude.com/docs/en/security',
    checked: AUDIT_CHECKED,
    status: 'verified',
  },
  cursorRulesComments: {
    title: 'Cursor: Rules (does not say whether HTML comments reach the model)',
    url: 'https://cursor.com/docs/rules',
    checked: AUDIT_CHECKED,
    status: 'unverified',
  },
  copilotInstructionsComments: {
    title:
      'GitHub Copilot: Repository custom instructions (does not say whether HTML comments reach the model)',
    url: 'https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions',
    checked: AUDIT_CHECKED,
    status: 'unverified',
  },
} as const satisfies Record<string, RuleSource>;
