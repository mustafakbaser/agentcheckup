import { describe, expect, it } from 'vitest';
import type { Grade } from '../../src/core/score.js';
import { badgeMarkdown, badgeUrl, shieldsSegment } from '../../src/report/badge.js';
import { emptyResult, makeResult, richResult } from './fixtures.js';

const graded = (score: number, grade: Grade | null) =>
  makeResult({ score: { score, grade, capped: false } });

describe('badgeUrl', () => {
  it.each([
    [95, 'A', 'brightgreen'],
    [85, 'B', 'green'],
    [72, 'C', 'yellow'],
    [65, 'D', 'orange'],
    [10, 'F', 'red'],
  ] as const)('%i/100 (%s) is %s', (score, grade, color) => {
    expect(badgeUrl(graded(score, grade))).toBe(
      `https://img.shields.io/badge/agent_config-${score}%2F100-${color}`,
    );
  });

  it('shows "no config" in light grey without a score', () => {
    expect(badgeUrl(emptyResult)).toBe(
      'https://img.shields.io/badge/agent_config-no_config-lightgrey',
    );
    expect(badgeUrl(graded(50, null))).toBe(
      'https://img.shields.io/badge/agent_config-50%2F100-lightgrey',
    );
  });
});

describe('shieldsSegment', () => {
  it('doubles dashes and underscores, turns spaces into underscores, encodes the rest', () => {
    expect(shieldsSegment('a-b_c d/e%')).toBe('a--b__c_d%2Fe%25');
  });
});

describe('badgeMarkdown', () => {
  it('links to agentcheckup by default', () => {
    expect(badgeMarkdown(richResult)).toBe(
      '[![agent config: 49/100](https://img.shields.io/badge/agent_config-49%2F100-red)](https://github.com/mustafakbaser/agentcheckup)',
    );
  });

  it('encodes characters that would break the link destination', () => {
    expect(badgeMarkdown(emptyResult, 'https://example.com/a (b)<c>')).toBe(
      '[![agent config: no config](https://img.shields.io/badge/agent_config-no_config-lightgrey)](https://example.com/a%20%28b%29%3Cc%3E)',
    );
  });
});
