import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RULESET_VERSION } from '../../../src/core/meta.js';
import { skillRules } from '../../../src/rules/skill/index.js';

const SOURCE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '../../../src/rules/skill');
const HELPERS = new Set([
  'index.ts',
  'field-effects.ts',
  'narrow-tools.ts',
  'fixes.ts',
  'format.ts',
  'repair.ts',
  'sections.ts',
  'shared.ts',
  'sources.ts',
]);

describe('skill rule family', () => {
  it('registers one rule per file, in id order', () => {
    const files = readdirSync(SOURCE_DIRECTORY)
      .filter((file) => file.endsWith('.ts') && !HELPERS.has(file))
      .map((file) => `skill/${file.slice(0, -3)}`)
      .sort();
    const ids = skillRules.map((rule) => rule.meta.id);
    expect(ids).toEqual(files);
    expect([...ids].sort()).toEqual(ids);
  });

  it('follows the metadata conventions', () => {
    for (const { meta } of skillRules) {
      expect(meta.since).toBe(RULESET_VERSION);
      expect(meta.appliesTo).toEqual(['skill']);
      expect(meta.title).toMatch(/^[A-Z][^.]*[^.\s]$/);
      expect(meta.rationale.length).toBeGreaterThan(100);
      expect(meta.sources.length).toBeGreaterThan(0);
      for (const source of meta.sources) {
        expect(source.url).toMatch(/^https:\/\//);
        expect(source.status).toBe('verified');
      }
      if (meta.category === 'clarity') expect(meta.severity).toBe('info');
    }
  });
});
