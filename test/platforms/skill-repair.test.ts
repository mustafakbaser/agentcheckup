import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/parse/frontmatter.js';
import {
  claudeCodeAccepts,
  claudeCodeBlock,
  claudeCodeMayRead,
} from '../../src/platforms/skill-repair.js';

const yamlOf = (text: string): string | undefined => {
  const block = claudeCodeBlock(text);
  return block === undefined ? undefined : text.slice(block.start, block.end);
};

const errorsOf = (text: string) => {
  const result = parseFrontmatter(text);
  if (result.kind !== 'invalid') throw new Error(`expected invalid, got ${result.kind}`);
  return result.errors;
};

describe('claudeCodeBlock', () => {
  it('takes the YAML up to the first "---", as Claude Code\'s pattern does', () => {
    expect(yamlOf('---\nname: a\n---\nBody\n')).toBe('name: a\n');
    expect(yamlOf('---\r\nname: a\r\n---\r\n')).toBe('name: a\r\n');
    // Inside a line, and in a longer run of dashes.
    expect(yamlOf('---\nname: a\ndescription: x --- y\n')).toBe('name: a\ndescription: x ');
    expect(yamlOf('---\nname: a\n----\n')).toBe('name: a\n');
    // Any whitespace after the opening dashes, through its last line break.
    expect(yamlOf('--- \nname: a\n---\n')).toBe('name: a\n');
    expect(yamlOf('---  \n\n  name: a\n---\n')).toBe('  name: a\n');
  });

  it('finds no block where the pattern does not match', () => {
    for (const text of [
      '',
      'name: a\n',
      '\n---\na: 1\n---\n',
      '---js\na\n---\n',
      '---\nname: a\n',
    ]) {
      expect(claudeCodeBlock(text), JSON.stringify(text)).toBeUndefined();
    }
  });

  it('runs in linear time on hostile input', () => {
    const text = `---${' '.repeat(200_000)}\n${'-'.repeat(2)} x `.repeat(20);
    const start = performance.now();
    claudeCodeBlock(text);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

describe('claudeCodeMayRead', () => {
  it('reads what its YAML reader accepts and what its retry repairs', () => {
    expect(claudeCodeAccepts(errorsOf('---\na: 1\na: 2\n---\n'))).toBe(true);
    expect(claudeCodeAccepts(errorsOf(`---\n${'k'.repeat(1100)}: v\n---\n`))).toBe(true);
    const retried = '---\nname: a\ndescription: @x\n---\n';
    expect(claudeCodeMayRead(retried, errorsOf(retried))).toBe(true);
  });

  it('does not read YAML that neither repairs', () => {
    const broken = '---\nname: "a\n---\n';
    expect(claudeCodeAccepts(errorsOf(broken))).toBe(false);
    expect(claudeCodeMayRead(broken, errorsOf(broken))).toBe(false);
    expect(claudeCodeAccepts([])).toBe(false);
  });
});
