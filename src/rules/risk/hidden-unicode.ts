import { RULESET_VERSION } from '../../core/meta.js';
import {
  type Artifact,
  type ArtifactKind,
  type Fix,
  PLATFORM_IDS,
  type Severity,
  type Span,
} from '../../core/types.js';
import { replaceSpan } from '../../fix/edits.js';
import { JSON_KINDS, MARKDOWN_OR_IMPORTED_KINDS } from '../../platforms/kinds.js';
import { defineRule } from '../define.js';
import { editable, mergeEdits, sharedFileGuidance } from '../json/fix-support.js';
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

const ID = 'risk/hidden-unicode';

/** Most runs one fix deletes; a file with more is left to the user. */
export const MAX_DELETED_RUNS = 1000;

const BIDI_GUIDANCE =
  'delete the bidirectional controls by hand unless right-to-left text on this line needs them, and check that the line reads the same afterwards';

/**
 * What the fix deletes from a run: the whole run, except that a run of variation selectors keeps
 * its first selector, which may belong to the character before it (an emoji's U+FE0F).
 */
function deletion(text: string, run: HiddenRun): Span {
  if (run.kind !== 'selector') return run.span;
  const first = text.codePointAt(run.span.offset) ?? 0;
  const size = first > 0xffff ? 2 : 1;
  return { offset: run.span.offset + size, length: run.span.length - size };
}

/**
 * One fix for the whole file, carried by every finding it resolves: deletes every run of tag
 * characters, zero-width characters and surplus variation selectors. Bidirectional controls stay,
 * as they can be legitimate in right-to-left text. Undefined when there is nothing to delete,
 * too much, or a bidirectional finding past the cap would surface once the summary is gone and
 * keep the fix from verifying.
 */
function deletionFix(artifact: Artifact): Fix | undefined {
  const { text } = artifact.decoded;
  const spans: Span[] = [];
  // An object, so the flow analysis sees the callback's writes.
  const seen = { runs: 0, bidi: 0, bidiPastCap: false };
  scanHidden(text, (run) => {
    seen.runs++;
    if (run.kind === 'bidi') {
      seen.bidi++;
      if (seen.runs > MAX_HIDDEN_FINDINGS) seen.bidiPastCap = true;
      return;
    }
    if (spans.length <= MAX_DELETED_RUNS) spans.push(deletion(text, run));
  });
  const { bidi } = seen;
  if (spans.length === 0 || spans.length > MAX_DELETED_RUNS || seen.bidiPastCap) return undefined;
  const change = mergeEdits(
    artifact,
    spans.map((span) => replaceSpan(artifact, span, '')),
  );
  if (change === undefined) return undefined;
  return {
    id: `${ID}#delete`,
    class: 'review',
    title: `Delete ${plural(spans.length, 'run', 'runs')} of invisible characters`,
    changes: [change],
    notes: [
      'Text the characters spelled or split joins up again: check that each changed line reads as intended.',
      ...(bidi === 0
        ? []
        : [
            `${plural(bidi, 'line', 'lines')} with bidirectional controls ${bidi === 1 ? 'is' : 'are'} left for you to check.`,
          ]),
    ],
  };
}

export const hiddenUnicodeRule = defineRule({
  meta: {
    id: ID,
    title: 'File contains invisible or text-reordering Unicode characters',
    rationale: [
      'Unicode tag characters (U+E0000–U+E007F) mirror ASCII but render as nothing: editors, diffs and rendered Markdown do not show them, yet language models read them as text, so a file can carry instructions no reviewer sees ("ASCII smuggling"). Bidirectional controls (U+202A–U+202E, U+2066–U+2069) change the display order of text, so the reviewed text differs from the text the agent reads ("Trojan Source"). Zero-width characters and runs of variation selectors hide data the same way.',
      'Tag characters and bidirectional controls are errors; bidirectional controls are warnings on a line with right-to-left script, where they have legitimate uses. Zero-width characters and variation selector runs are warnings. Not reported: a joiner inside an emoji sequence or a joining script, a zero width space between letters of a script written without spaces, a byte order mark at the start of the file, and subdivision flags such as England (U+1F3F4 followed by tag letters). Files that an instruction file imports with `@path`, such as a `README.md` that `CLAUDE.md` imports, are checked too: the agent loads their text with the file that imports them.',
      'Delete the characters. If they came from copy and paste, retype the affected text.',
    ].join('\n\n'),
    category: 'risk',
    severity: 'error',
    appliesTo: [...MARKDOWN_OR_IMPORTED_KINDS, ...JSON_KINDS] as readonly ArtifactKind[],
    platforms: PLATFORM_IDS,
    sources: [
      RISK_SOURCES.asciiSmuggling,
      RISK_SOURCES.trojanSource,
      SOURCES.unicodeTagSmuggling,
      RISK_SOURCES.emojiTagSequences,
      RISK_SOURCES.variationSelectorSmuggling,
    ],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      summary:
        "Deletes every run of tag characters and zero-width characters in the file, and every variation selector after a run's first. Bidirectional controls are left to you, because right-to-left text can need them.",
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const readers = artifact.readers.filter((platform) => context.targets.has(platform));
      if (readers.length === 0) continue;

      const canEdit = editable(artifact);
      const fix = canEdit ? deletionFix(artifact) : undefined;
      let reported = 0;
      let extra: { first: HiddenRun; count: number; severity: Severity } | undefined;
      scanHidden(artifact.decoded.text, (run) => {
        if (reported < MAX_HIDDEN_FINDINGS) {
          reported++;
          const guidance =
            run.kind === 'bidi'
              ? BIDI_GUIDANCE
              : canEdit
                ? undefined
                : sharedFileGuidance(artifact);
          context.report({
            artifact,
            span: run.span,
            severity: run.severity,
            message: describe(run),
            platforms: readers,
            ...(fix === undefined || run.kind === 'bidi' ? {} : { fix }),
            ...(guidance === undefined ? {} : { guidance }),
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
          // The fix removes every run past the cap, so the summary goes too.
          ...(fix === undefined ? {} : { fix }),
        });
      }
    }
  },
});
