import { describe, expect, it } from 'vitest';
import { parseDirective } from '../../src/core/suppress.js';

const candidate = (text: string, endLine = 3) => ({
  text,
  span: { offset: 0, length: text.length },
  startLine: endLine,
  endLine,
});

describe('parseDirective', () => {
  it('parses a next-line HTML directive with several rules and a reason', () => {
    expect(
      parseDirective(
        candidate('<!-- agentcheck-disable-next-line skill/a, skill/b -- generated file -->'),
      ),
    ).toMatchObject({
      scope: 'next-line',
      ruleIds: ['skill/a', 'skill/b'],
      reason: 'generated file',
      targetLine: 4,
    });
  });

  it('parses a file-scope YAML comment directive', () => {
    expect(
      parseDirective(
        candidate('# agentcheck-disable-file skill/non-portable-field -- Claude only'),
      ),
    ).toMatchObject({ scope: 'file', ruleIds: ['skill/non-portable-field'], targetLine: 0 });
  });

  it('keeps an empty reason so the engine can report it', () => {
    expect(
      parseDirective(candidate('<!-- agentcheck-disable-next-line skill/a -->')),
    ).toMatchObject({
      ruleIds: ['skill/a'],
      reason: '',
    });
  });

  it.each([
    '<!-- just a comment -->',
    '<!-- eslint-disable-next-line foo -->',
    '<!-- agentcheck-enable skill/a -->',
    '# heading',
    'agentcheck-disable-next-line skill/a -- not a comment',
  ])('ignores %j', (text) => {
    expect(parseDirective(candidate(text))).toBeUndefined();
  });

  it('stays linear on long adversarial input', () => {
    const text = `<!-- agentcheck-disable-next-line ${'a,'.repeat(200_000)} -- ${' '.repeat(200_000)}x -->`;
    const started = performance.now();
    parseDirective(candidate(text));
    expect(performance.now() - started).toBeLessThan(500);
  });
});
