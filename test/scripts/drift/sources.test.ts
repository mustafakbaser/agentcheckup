import { describe, expect, it } from 'vitest';
import {
  buildSourceIndex,
  isOwnRepositoryUrl,
  splitOwnSources,
} from '../../../scripts/drift/sources.js';
import type { RuleSource } from '../../../src/core/types.js';
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
