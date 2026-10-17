import { RULESET_VERSION } from '../../core/meta.js';
import {
  GEMINI_DEFAULT_CONTEXT_FILE,
  GEMINI_LEGACY_SETTINGS_KEYS,
} from '../../platforms/gemini.js';
import { defineRule } from '../define.js';
import { at, isObject, keySpanOf, own } from '../json/access.js';
import { SOURCES } from '../sources.js';
import { joinNames, quote } from '../shared/format.js';
import { GEMINI_SOURCES } from './sources.js';

const ID = 'gemini/settings-key-ignored';

/** True when the nested key at `path` (`context.fileName`) is set in `root`. */
function isSet(root: unknown, path: string): boolean {
  let value = root;
  for (const segment of path.split('.')) {
    if (!isObject(value)) return false;
    value = own(value, segment);
  }
  return value !== undefined;
}

/** The file names a `contextFileName` value lists, other than GEMINI.md, which is read anyway. */
function lostNames(value: unknown): string[] {
  const items: readonly unknown[] = Array.isArray(value) ? value : [value];
  const names: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name !== '' && name !== GEMINI_DEFAULT_CONTEXT_FILE && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

export const settingsKeyIgnoredRule = defineRule({
  meta: {
    id: ID,
    title: 'Gemini CLI ignores a top-level key from its old settings format',
    rationale: [
      'Since version 0.3, Gemini CLI keeps its settings in nested categories, such as `context.fileName`, `ui.theme` and `tools.exclude`. Versions up to 0.23 moved the old top-level keys into place when they loaded a settings file. Version 0.24 removed that migration, and current versions keep an unknown top-level key without reading it and without a warning.',
      'So a committed `.gemini/settings.json` with `{ "contextFileName": "AGENTS.md" }` no longer makes Gemini CLI read `AGENTS.md`: it reads only `GEMINI.md`. Every old key this rule reports has a nested place in the current settings schema.',
      'Move each key to its nested place, for example `"context": { "fileName": "AGENTS.md" }`.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'warn',
    appliesTo: ['gemini-settings'],
    platforms: ['gemini'],
    sources: [
      SOURCES.geminiConfiguration,
      SOURCES.geminiCliConfigSource,
      SOURCES.geminiSettingsSource,
      GEMINI_SOURCES.settingsValidation,
      GEMINI_SOURCES.settingsMigration,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const doc = context.json(artifact);
      if (!doc.ok || !isObject(doc.value)) continue;
      const root = doc.value;
      for (const key of Object.keys(root)) {
        if (!Object.hasOwn(GEMINI_LEGACY_SETTINGS_KEYS, key)) continue;
        const target = GEMINI_LEGACY_SETTINGS_KEYS[key];
        if (target === undefined) continue;
        const targetSet = isSet(root, target);
        let consequence = `since version 0.24 it reads this setting only as ${quote(target)}.`;
        if (key === 'contextFileName' && !targetSet) {
          const lost = lostNames(own(root, key));
          if (lost.length > 0) {
            consequence = `since version 0.24 it reads context file names only from ${quote(target)}, so it loads GEMINI.md but not ${joinNames(lost.map((name) => quote(name)))}.`;
          }
        }
        context.report({
          artifact,
          ...at(keySpanOf(doc, [key])),
          message: `Gemini CLI ignores the top-level ${quote(key)}, a key from its old settings format: ${consequence}`,
          guidance: targetSet
            ? `remove ${quote(key)}; this file already sets ${quote(target)}`
            : `move the value to ${quote(target)}`,
        });
      }
    }
  },
});
