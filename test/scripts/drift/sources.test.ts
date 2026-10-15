import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBaseline } from '../../../scripts/drift/baseline.js';
import {
  buildSourceIndex,
  CONTEXT_LOADERS,
  isOwnRepositoryUrl,
  splitOwnSources,
} from '../../../scripts/drift/sources.js';
import { DIRECTIVE_RULES } from '../../../src/core/directive-rules.js';
import type { RuleSource } from '../../../src/core/types.js';
import { SOURCES } from '../../../src/platforms/sources.js';
import { builtinRules } from '../../../src/rules/index.js';

function source(url: string): RuleSource {
  return { title: url, url, checked: '2026-10-14', status: 'verified' };
}

const A = 'https://a.example/docs';
const B = 'https://b.example/docs';
const OWN = 'https://github.com/mustafakbaser/agentcheckup/blob/main/docs/configuration.md#x';

describe('buildSourceIndex', () => {
  it('maps each URL to the sorted, unique ids of the rules citing it', () => {
    const index = buildSourceIndex([
      { id: 'skill/zeta', sources: [source(B), source(A)] },
      { id: 'instr/alpha', sources: [source(A), source(A)] },
      { id: 'mcp/only-b', sources: [source(B)] },
    ]);
    expect([...index]).toEqual([
      [A, ['instr/alpha', 'skill/zeta']],
      [B, ['mcp/only-b', 'skill/zeta']],
    ]);
  });

  it('keeps URLs that differ only in their fragment apart', () => {
    const index = buildSourceIndex([
      { id: 'a/one', sources: [source(`${A}#one`)] },
      { id: 'a/two', sources: [source(`${A}#two`)] },
    ]);
    expect([...index.keys()]).toEqual([`${A}#one`, `${A}#two`]);
  });

  it('indexes every URL cited by the built-in rules', () => {
    const index = buildSourceIndex(builtinRules.map((rule) => rule.meta));
    const cited = new Set(builtinRules.flatMap((rule) => rule.meta.sources.map((s) => s.url)));
    expect(new Set(index.keys())).toEqual(cited);
    for (const [url, ids] of index) {
      expect(ids.length).toBeGreaterThan(0);
      expect(url.startsWith('https://')).toBe(true);
    }
  });
});

describe('buildSourceIndex with the shared source table', () => {
  const index = buildSourceIndex(
    [...builtinRules.map((rule) => rule.meta), ...DIRECTIVE_RULES],
    SOURCES,
  );

  it('watches every entry of src/platforms/sources.ts, as used by the context loaders', () => {
    for (const [key, source] of Object.entries(SOURCES)) {
      expect(index.get(source.url), key).toContain(CONTEXT_LOADERS);
    }
    // Cited by the Cursor loader only, never by a rule.
    expect(index.get(SOURCES.cursorThirdPartyHooks.url)).toEqual([CONTEXT_LOADERS]);
    // Cited by rules and loaders.
    expect(index.get(SOURCES.claudeMemory.url)).toEqual(
      expect.arrayContaining([CONTEXT_LOADERS, 'instr/claude-md-too-long']),
    );
  });

  it('lists users sorted and once, rule ids next to the loaders', () => {
    const merged = buildSourceIndex([{ id: 'z/rule', sources: [source(A)] }], {
      one: source(A),
      two: source(A),
      three: source(B),
    });
    expect([...merged]).toEqual([
      [A, [CONTEXT_LOADERS, 'z/rule']],
      [B, [CONTEXT_LOADERS]],
    ]);
  });

  it('the committed baseline has a hash for every watched URL', () => {
    const baseline = parseBaseline(
      readFileSync(new URL('../../../scripts/drift/baseline.json', import.meta.url), 'utf8'),
    );
    const { watched } = splitOwnSources(index);
    expect([...watched.keys()].filter((url) => !baseline.has(url))).toEqual([]);
    expect([...baseline.keys()].filter((url) => !watched.has(url))).toEqual([]);
  });
});

describe('isOwnRepositoryUrl', () => {
  it('matches URLs into this repository', () => {
    expect(isOwnRepositoryUrl('https://github.com/mustafakbaser/agentcheckup')).toBe(true);
    expect(isOwnRepositoryUrl(OWN)).toBe(true);
    expect(isOwnRepositoryUrl('https://github.com/mustafakbaser/agentcheckup#readme')).toBe(true);
  });

  it('does not match other repositories with the same prefix', () => {
    expect(
      isOwnRepositoryUrl('https://github.com/mustafakbaser/agentcheckup-action/blob/main/a'),
    ).toBe(false);
    expect(isOwnRepositoryUrl('https://github.com/openai/codex/blob/main/a')).toBe(false);
  });
});

describe('splitOwnSources', () => {
  it('separates URLs into this repository from watched ones', () => {
    const index = buildSourceIndex([{ id: 'a/b', sources: [source(A), source(OWN)] }]);
    const { watched, own } = splitOwnSources(index);
    expect([...watched.keys()]).toEqual([A]);
    expect([...own]).toEqual([[OWN, ['a/b']]]);
  });
});
