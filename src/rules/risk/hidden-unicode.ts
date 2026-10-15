import { RULESET_VERSION } from '../../core/meta.js';
import { type ArtifactKind, PLATFORM_IDS, type Severity } from '../../core/types.js';
import { JSON_KINDS, MARKDOWN_KINDS } from '../../platforms/kinds.js';
import { defineRule } from '../define.js';
import { codePointLabel, formatInteger, joinNames, quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { RISK_SOURCES } from './sources.js';
import { type HiddenRun, scanHidden } from './unicode.js';

/** Findings reported per file before the rest are summarized in one finding. */
export const MAX_HIDDEN_FINDINGS = 20;

const NAMES: Readonly<Record<number, string>> = {
  0x202a: 'LEFT-TO-RIGHT EMBEDDING',
  0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING',
  0x202d: 'LEFT-TO-RIGHT OVERRIDE',
  0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE',
  0x200b: 'ZERO WIDTH SPACE',
  0x200c: 'ZERO WIDTH NON-JOINER',
  0x200d: 'ZERO WIDTH JOINER',
  0x2060: 'WORD JOINER',
  0x2061: 'FUNCTION APPLICATION',
  0x2062: 'INVISIBLE TIMES',
  0x2063: 'INVISIBLE SEPARATOR',
  0x2064: 'INVISIBLE PLUS',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE',
  0x180e: 'MONGOLIAN VOWEL SEPARATOR',
};

function label(cp: number): string {
  const name = NAMES[cp];
  return name === undefined ? codePointLabel(cp) : `${codePointLabel(cp)} ${name}`;
}

function plural(count: number, one: string, many: string): string {
  return `${formatInteger(count)} ${count === 1 ? one : many}`;
}

function describe(run: HiddenRun): string {
  switch (run.kind) {
    case 'tag': {
      const what = `${plural(run.count, 'invisible Unicode tag character', 'invisible Unicode tag characters')} (U+E0000–U+E007F)`;
      const spelled = run.payload === '' ? '' : ` spelling ${quote(run.payload)}`;
      return `${what}${spelled}. Editors, diffs and rendered Markdown show nothing here, but language models read tag characters as text ("ASCII smuggling").`;
    }
    case 'bidi': {
      const names = joinNames(run.codePoints.map(label));
      const count = run.count === 1 ? '' : ` (${formatInteger(run.count)} on this line)`;
      const noun =
        run.count === 1 ? 'Bidirectional control character' : 'Bidirectional control characters';
      const rtl = run.rtlContext
        ? ' The line also has right-to-left text, where these controls are sometimes legitimate.'
        : '';
      const change = run.count === 1 ? 'It changes' : 'They change';
      return `${noun} ${names}${count}. ${change} the order in which text is displayed, so reviewers can see different text than the agent reads ("Trojan Source").${rtl}`;
    }
    case 'zero-width': {
      const names = joinNames(run.codePoints.map(label));
      const what =
        run.count === 1
          ? `Invisible character ${names}`
          : `${formatInteger(run.count)} invisible characters in a row (${names})`;
      const it = run.count === 1 ? 'it' : 'them';
      return `${what}. Editors, diffs and rendered Markdown do not show ${it}, but the agent reads ${it}; invisible characters can split words or carry hidden text past review.`;
    }
    case 'selector': {
      const decoded = run.payload === '' ? '' : ` They decode to ${quote(run.payload)}.`;
      return `${formatInteger(run.count)} variation selectors in a row. A character takes at most one, so the rest are invisible data that editors and diffs do not show.${decoded}`;
    }
  }
}

const RANK: Readonly<Record<Severity, number>> = { info: 0, warn: 1, error: 2 };

export const hiddenUnicodeRule = defineRule({
  meta: {
    id: 'risk/hidden-unicode',
    title: 'File contains invisible or text-reordering Unicode characters',
    rationale: [
      'Unicode tag characters (U+E0000–U+E007F) mirror ASCII but render as nothing: editors, diffs and rendered Markdown do not show them, yet language models read them as text, so a file can carry instructions no reviewer sees ("ASCII smuggling"). Bidirectional controls (U+202A–U+202E, U+2066–U+2069) change the display order of text, so the reviewed text differs from the text the agent reads ("Trojan Source"). Zero-width characters and runs of variation selectors hide data the same way.',
      'Tag characters and bidirectional controls are errors; bidirectional controls are warnings on a line with right-to-left script, where they have legitimate uses. Zero-width characters and variation selector runs are warnings. Not reported: a joiner inside an emoji sequence or a joining script, a zero width space between letters of a script written without spaces, a byte order mark at the start of the file, and subdivision flags such as England (U+1F3F4 followed by tag letters).',
      'Delete the characters. If they came from copy and paste, retype the affected text.',
    ].join('\n\n'),
    category: 'risk',
    severity: 'error',
    appliesTo: [...MARKDOWN_KINDS, ...JSON_KINDS] as readonly ArtifactKind[],
    platforms: PLATFORM_IDS,
    sources: [
      RISK_SOURCES.asciiSmuggling,
      RISK_SOURCES.trojanSource,
      SOURCES.unicodeTagSmuggling,
      RISK_SOURCES.emojiTagSequences,
      RISK_SOURCES.variationSelectorSmuggling,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const readers = artifact.readers.filter((platform) => context.targets.has(platform));
      if (readers.length === 0) continue;

      let reported = 0;
      let extra: { first: HiddenRun; count: number; severity: Severity } | undefined;
      scanHidden(artifact.decoded.text, (run) => {
        if (reported < MAX_HIDDEN_FINDINGS) {
          reported++;
          context.report({
            artifact,
            span: run.span,
            severity: run.severity,
            message: describe(run),
            platforms: readers,
          });
          return;
        }
        extra ??= { first: run, count: 0, severity: run.severity };
        extra.count++;
        if (RANK[run.severity] > RANK[extra.severity]) extra.severity = run.severity;
      });
      if (extra !== undefined) {
        context.report({
          artifact,
          span: extra.first.span,
          severity: extra.severity,
          message: `Only the first ${formatInteger(MAX_HIDDEN_FINDINGS)} runs of invisible characters in this file are listed; ${formatInteger(extra.count)} more from here on ${extra.count === 1 ? 'is' : 'are'} not.`,
          platforms: readers,
        });
      }
    }
  },
});
