/**
 * How Gemini CLI reads a SKILL.md (src/platforms/gemini-skills.ts), which the skill rules and the
 * Gemini CLI load plan share.
 */
import { describe, expect, it } from 'vitest';
import { decode } from '../../../src/core/text.js';
import { parseFrontmatter } from '../../../src/parse/frontmatter.js';
import {
  geminiLineFields,
  geminiSkillVerdict,
  geminiSkipReasons,
} from '../../../src/platforms/gemini-skills.js';

const encoder = new TextEncoder();

function read(text: string) {
  const decoded = decode(encoder.encode(text));
  return { decoded, result: parseFrontmatter(decoded.text) };
}

function reasons(text: string): string[] {
  const { decoded, result } = read(text);
  return geminiSkipReasons(result, decoded);
}

function verdict(text: string) {
  const { decoded, result } = read(text);
  return geminiSkillVerdict(result, decoded);
}

describe('geminiSkipReasons', () => {
  it('gives every reason, in reading order', () => {
    expect(reasons('No frontmatter.\n')).toEqual(['no-frontmatter']);
    expect(reasons('')).toEqual(['no-frontmatter']);
    expect(reasons('+++\nname = "x"\n+++\n')).toEqual(['unsupported']);
    expect(reasons('---\n- a\n---\n')).toEqual(['not-a-mapping']);
    // Gemini CLI removes a byte order mark before it reads the frontmatter.
    expect(reasons('\uFEFF---\nname: x\n---\n')).toEqual(['no-description']);
    expect(reasons('---\ntitle: x\n---\n')).toEqual(['no-description', 'no-name']);
  });

  it('finds no reason for a skill Gemini CLI lists', () => {
    expect(reasons('---\nname: x\ndescription: Does x.\n---\n')).toEqual([]);
    // Empty values load: under an empty name, or with no description.
    expect(reasons('---\nname: ""\ndescription:\n---\n')).toEqual([]);
    // YAML that does not parse is read line by line.
    expect(reasons('---\nname: x\ndescription: a: b\n---\n')).toEqual([]);
  });

  it('closes the block only at a line that is --- and optional spaces or tabs', () => {
    const unclosed = read('---\nname: x\ndescription: y\n----\nBody.\n');
    expect(unclosed.result.kind).toBe('unclosed');
    expect(geminiSkipReasons(unclosed.result, unclosed.decoded)).toEqual(['no-frontmatter']);
    expect(reasons('---\nname: x\ndescription: y\n  ---\n')).toEqual(['no-frontmatter']);
    expect(reasons('---\nname: x\ndescription: y\n--- x\n')).toEqual(['no-frontmatter']);
    expect(reasons('---\nname: x\ndescription: y\n--- \nBody.\n')).toEqual([]);
    expect(reasons('---\nname: x\ndescription: y\n---\t\r\nBody.\r\n')).toEqual([]);
    expect(reasons('---\nname: x\ndescription: y\n---')).toEqual([]);
  });

  it('reads a skill that starts with a byte order mark', () => {
    const text = '\uFEFF---\nname: x\ndescription: Does x.\n---\n';
    expect(reasons(text)).toEqual([]);
    expect(verdict(text)).toEqual({
      kind: 'listed',
      name: 'x',
      description: 'Does x.',
      fields: 'yaml',
    });
  });
});

describe('geminiSkillVerdict', () => {
  it('lists the YAML name and description, with unsafe name characters replaced', () => {
    expect(verdict('---\nname: "a:b/c"\ndescription: Does it.\n---\n')).toEqual({
      kind: 'listed',
      name: 'a-b-c',
      description: 'Does it.',
      fields: 'yaml',
    });
  });

  it('reads the lines when the YAML gives no text, and skips without them', () => {
    expect(verdict('---\nname: x\ndescription: one: two\n---\n')).toEqual({
      kind: 'listed',
      name: 'x',
      description: 'one: two',
      fields: 'lines',
    });
    expect(verdict('---\nname: 7\ndescription: [a, b]\n---\n')).toMatchObject({
      kind: 'listed',
      name: '7',
      description: '[a, b]',
    });
    expect(verdict('---\ntitle: [x\n---\n')).toEqual({ kind: 'skipped', reason: 'no-fields' });
    expect(verdict('No frontmatter.\n')).toEqual({ kind: 'skipped', reason: 'no-frontmatter' });
    expect(verdict('---\nname: x\n----\n')).toEqual({ kind: 'skipped', reason: 'no-frontmatter' });
  });
});

describe('geminiLineFields', () => {
  it('reads the last name line and a description with its continuation lines', () => {
    expect(
      geminiLineFields(
        [
          'Name: first',
          'name: "second"',
          'description: >-',
          '  Line one,',
          '  # a comment ends it',
          '  line two.',
        ].join('\n'),
      ),
    ).toEqual({ name: 'second', description: 'Line one,' });
    expect(geminiLineFields('description: |\r\n  One\r\n  two\r\nother: key\r\nname: n')).toEqual({
      name: 'n',
      description: 'One two',
    });
    expect(geminiLineFields("name: 'quoted'\ndescription: x\n  more\n")).toEqual({
      name: 'quoted',
      description: 'x more',
    });
  });

  it('gives nothing without both lines', () => {
    expect(geminiLineFields('name: only')).toBeUndefined();
    expect(geminiLineFields('description: only')).toBeUndefined();
    expect(geminiLineFields('')).toBeUndefined();
  });
});
