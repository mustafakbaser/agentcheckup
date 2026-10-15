import { RULESET_VERSION } from '../../core/meta.js';
import { type ArtifactKind, PLATFORM_IDS } from '../../core/types.js';
import { JSON_KINDS } from '../../platforms/kinds.js';
import { defineRule } from '../define.js';
import { quote } from '../shared/format.js';
import { JSON_SOURCES } from './sources.js';

/** Parser warning code for a key that a later key of the same name overrides. */
const DUPLICATE_KEY = 'duplicate-key';

/** The key as written, without its quotes (escapes are shown as written). */
function keyText(text: string, offset: number, length: number): string {
  const token = text.slice(offset, offset + length);
  return token.length >= 2 && token.startsWith('"') && token.endsWith('"')
    ? token.slice(1, -1)
    : token;
}

export const duplicateKeyRule = defineRule({
  meta: {
    id: 'json/duplicate-key',
    title: 'JSON object repeats a key',
    rationale: [
      'RFC 8259 leaves the result of a repeated key open. `JSON.parse`, which Gemini CLI uses for `settings.json`, keeps only the last value (ECMA-262); some parsers reject the object instead. Either way the earlier value never takes effect: a second `"hooks"` block replaces the first, and a second `.mcp.json` server with the same name replaces the first server, without an error.',
      'The finding points at the earlier key, the one that is ignored. Merge the two entries or delete the one you do not want.',
    ].join('\n\n'),
    category: 'correctness',
    severity: 'warn',
    appliesTo: [...JSON_KINDS] as readonly ArtifactKind[],
    platforms: PLATFORM_IDS,
    sources: [
      JSON_SOURCES.ecmaJsonParse,
      JSON_SOURCES.rfc8259Objects,
      JSON_SOURCES.geminiSettingsLoader,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const readers = artifact.readers.filter((platform) => context.targets.has(platform));
      if (readers.length === 0) continue;
      const doc = context.json(artifact);
      if (!doc.ok) continue;
      for (const warning of doc.warnings) {
        if (warning.code !== DUPLICATE_KEY) continue;
        const name = quote(
          keyText(artifact.decoded.text, warning.span.offset, warning.span.length),
        );
        const consequence =
          artifact.kind === 'gemini-settings'
            ? 'Gemini CLI reads settings with JSON.parse, which keeps only the last value, so this one is ignored.'
            : 'JSON.parse keeps only the last value and strict parsers reject the file, so this one never takes effect.';
        context.report({
          artifact,
          span: warning.span,
          message: `Key ${name} is repeated later in the same object. ${consequence}`,
          platforms: readers,
        });
      }
    }
  },
});
