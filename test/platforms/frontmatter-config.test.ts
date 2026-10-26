import { describe, expect, it } from 'vitest';
import type { Span } from '../../src/core/types.js';
import { MAX_FRONTMATTER_LENGTH, parseFrontmatter } from '../../src/parse/frontmatter.js';
import {
  claudeFrontmatterConfig,
  type FrontmatterConfig,
} from '../../src/platforms/frontmatter-config.js';

const slice = (text: string, span: Span | undefined): string | undefined =>
  span === undefined ? undefined : text.slice(span.offset, span.offset + span.length);

function configOf(text: string): FrontmatterConfig {
  return claudeFrontmatterConfig(text, parseFrontmatter(text));
}

/** The values of each reading, documented first. */
const values = (config: FrontmatterConfig): unknown[] =>
  config.readings.map((reading) => reading.doc.value);

const line = (text: string, span: Span | undefined): number =>
  text.slice(0, span?.offset ?? 0).split('\n').length;

describe('claudeFrontmatterConfig', () => {
  it('reads valid frontmatter as it parses, with spans into the file', () => {
    const text = '---\nname: a\nhooks:\n  Stop:\n    - hooks:\n        - command: x\n---\nBody\n';
    const config = configOf(text);
    expect(config.unreadable).toBe(false);
    expect(config.readings).toHaveLength(1);
    const [reading] = config.readings;
    expect(reading?.documented).toBe(true);
    expect(reading?.doc.value).toEqual({
      name: 'a',
      hooks: { Stop: [{ hooks: [{ command: 'x' }] }] },
    });
    expect(slice(text, reading?.doc.valueSpan(['name']))).toBe('a');
    expect(slice(text, reading?.doc.keySpan(['hooks', 'Stop']))).toBe('Stop');
    expect(slice(text, reading?.doc.valueSpan(['hooks', 'Stop', 0, 'hooks', 0, 'command']))).toBe(
      'x',
    );
  });

  it("reads what Claude Code's retry repairs, mapping spans to the same line of the file", () => {
    const text = [
      '---',
      // Claude Code wraps the value in quotes and escapes the inner ones: a longer line.
      'description: Use when: deploying, "quoted" too',
      'allowed-tools: Bash',
      'hooks:',
      '  PreToolUse:',
      '    - hooks:',
      '        - command: ./check.sh',
      '---',
      '',
    ].join('\n');
    const config = configOf(text);
    expect(config.unreadable).toBe(false);
    const [reading] = config.readings;
    expect(reading?.documented).toBe(false);
    expect(reading?.doc.value).toMatchObject({
      description: 'Use when: deploying, "quoted" too',
      'allowed-tools': 'Bash',
    });
    expect(line(text, reading?.doc.valueSpan(['description']))).toBe(2);
    expect(line(text, reading?.doc.keySpan(['allowed-tools']))).toBe(3);
    expect(
      slice(text, reading?.doc.valueSpan(['hooks', 'PreToolUse', 0, 'hooks', 0, 'command'])),
    ).toBe('./check.sh');
    // A span never reaches past the end of its line in the file.
    expect(slice(text, reading?.doc.valueSpan(['description']))?.includes('\n')).toBe(false);
  });

  it("reads the block Claude Code's reader finds when it differs from the documented one", () => {
    // No closing line: only Claude Code's reader, which stops at the first "---", finds a block.
    const unclosed = '---\nallowed-tools: Bash\ndescription: Deploy ---\n# Deploy\n';
    expect(values(configOf(unclosed))).toEqual([
      { 'allowed-tools': 'Bash', description: 'Deploy' },
    ]);
    expect(configOf(unclosed).readings[0]?.documented).toBe(false);
    // Two blocks: the documented one and Claude Code's, which ends inside a value.
    const both = '---\nallowed-tools: Read\nnotes: see --- below\nhooks: {}\n---\n';
    expect(values(configOf(both))).toEqual([
      { 'allowed-tools': 'Read', notes: 'see --- below', hooks: {} },
      { 'allowed-tools': 'Read', notes: 'see' },
    ]);
    // Whitespace other than spaces and tabs after the opening "---".
    const nbsp = '--- \nallowed-tools: Bash\n---\n';
    expect(values(configOf(nbsp))).toEqual([{ 'allowed-tools': 'Bash' }]);
    const [reading] = configOf(unclosed).readings;
    expect(line(unclosed, reading?.doc.keySpan(['allowed-tools']))).toBe(2);
  });

  it('reads no fields where no block exists', () => {
    for (const text of ['# No frontmatter\n', '---\nname: a\n', '+++\nname = "a"\n+++\n']) {
      expect(configOf(text), text).toEqual({ readings: [], unreadable: false });
    }
  });

  it('fails closed on a block that may hold fields agentcheckup cannot read', () => {
    for (const text of [
      // Claude Code's YAML reader keeps the last of repeated keys.
      '---\nname: a\nname: b\nhooks: {}\n---\n',
      // ... and accepts keys longer than 1,024 characters.
      `---\n${'k'.repeat(1100)}: v\nhooks: {}\n---\n`,
      // Neither parse nor retry reads it.
      '---\nlist:\n  - a\n - b\n---\n',
      // Past a parser limit.
      `---\nname: big\ndescription: "${'x'.repeat(MAX_FRONTMATTER_LENGTH)}"\n---\n`,
    ]) {
      expect(configOf(text), text.slice(0, 40)).toEqual({ readings: [], unreadable: true });
    }
  });

  it('fails closed on merge keys, which Claude Code applies, and still lists the rest', () => {
    const text = '---\nbase: &b {PreToolUse: []}\nhooks:\n  <<: *b\nallowed-tools: Bash\n---\n';
    const config = configOf(text);
    expect(config.unreadable).toBe(true);
    expect(config.readings).toHaveLength(1);
  });

  it('fails closed when the retry hits a parser limit', () => {
    const deep = `${'['.repeat(300)}${']'.repeat(300)}`;
    const text = `---\ndescription: Use when: reviewing\nd:\n  - ${deep}\n---\n`;
    expect(configOf(text)).toEqual({ readings: [], unreadable: true });
  });
});
