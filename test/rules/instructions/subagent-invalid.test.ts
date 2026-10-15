import { describe, expect, it } from 'vitest';
import { subagentInvalidRule } from '../../../src/rules/instructions/subagent-invalid.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'instr/subagent-invalid';
const rules = [subagentInvalidRule];
const PATH = '.claude/agents/reviewer.md';

function run(text: string, path = PATH) {
  return findings(lint({ [path]: text }, { rules }), RULE);
}

describe('instr/subagent-invalid', () => {
  it('does not report a valid subagent', () => {
    expect(
      run(
        '---\nname: code-reviewer\ndescription: Reviews code\ntools: Read, Grep\n---\nYou review code.\n',
      ),
    ).toEqual([]);
  });

  it('reports a missing name when the file has subagent fields', () => {
    expect(run('---\ndescription: Reviews code\nmodel: sonnet\n---\nBody\n')).toEqual([
      {
        ruleId: RULE,
        severity: 'error',
        path: PATH,
        message:
          'The frontmatter has no "name", so Claude Code treats this file as documentation and does not load the subagent.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } },
      },
    ]);
  });

  it('reports an empty name at its key', () => {
    expect(run('---\nname: ""\ndescription: Reviews code\n---\n')).toEqual([
      expect.objectContaining({
        message:
          '"name" is empty, so Claude Code treats this file as documentation and does not load the subagent.',
        range: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } },
      }),
    ]);
  });

  it.each([
    ['-reviewer', 'Subagent name "-reviewer" starts with "-", so Claude Code skips this file.'],
    [
      'tools:reviewer',
      'Subagent name "tools:reviewer" contains ":", which Claude Code reserves for plugin subagents, so it skips this file.',
    ],
  ])('reports the name %j at its value', (name, message) => {
    expect(run(`---\nname: "${name}"\ndescription: Reviews code\n---\n`)).toEqual([
      expect.objectContaining({
        message,
        range: { start: { line: 2, column: 7 }, end: { line: 2, column: 9 + name.length } },
      }),
    ]);
  });

  it('reports a name longer than 256 characters but not one of exactly 256', () => {
    expect(run(`---\nname: ${'a'.repeat(256)}\ndescription: d\n---\n`)).toEqual([]);
    expect(run(`---\nname: ${'a'.repeat(257)}\ndescription: d\n---\n`)).toEqual([
      expect.objectContaining({
        message:
          'The subagent name is 257 characters long, so Claude Code skips this file. The limit is 256 characters.',
      }),
    ]);
  });

  it('counts characters, not UTF-16 units, in the name length', () => {
    expect(run(`---\nname: ${'😀'.repeat(200)}\ndescription: d\n---\n`)).toEqual([]);
  });

  it('reports a missing or empty description', () => {
    expect(run('---\nname: reviewer\n---\nBody\n')).toEqual([
      expect.objectContaining({
        message: 'The frontmatter has no "description", so Claude Code skips this subagent.',
        range: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } },
      }),
    ]);
    expect(run('---\nname: reviewer\ndescription:\n---\nBody\n')).toEqual([
      expect.objectContaining({
        message: '"description" is empty, so Claude Code skips this subagent.',
        range: { start: { line: 3, column: 1 }, end: { line: 3, column: 12 } },
      }),
    ]);
  });

  it('reports both a bad name and a missing description', () => {
    expect(run('---\nname: a:b\n---\n').map((finding) => finding.message)).toEqual([
      'The frontmatter has no "description", so Claude Code skips this subagent.',
      'Subagent name "a:b" contains ":", which Claude Code reserves for plugin subagents, so it skips this file.',
    ]);
  });

  it('reports YAML that does not parse', () => {
    const result = run('---\nname: "reviewer\ndescription: Reviews code\n---\n');
    expect(result.map((finding) => finding.severity)).toEqual(['error']);
    expect(result[0]?.message).toMatch(
      /^The frontmatter is not valid YAML \(.+\), so Claude Code reads no fields from it and skips this subagent\.$/,
    );
  });

  it('does not report an unquoted colon in a value, which Claude Code is reported to accept', () => {
    expect(
      run('---\nname: scikit\ndescription: Classical ML with scikit-learn: pipelines\n---\nBody\n'),
    ).toEqual([]);
  });

  it('reports frontmatter that is not a mapping', () => {
    expect(run('---\n- name: reviewer\n---\n').map((finding) => finding.message)).toEqual([
      'The frontmatter is not a YAML mapping of "key: value" fields, so Claude Code finds no name and does not load this subagent.',
    ]);
  });

  it('reports unclosed and unsupported frontmatter', () => {
    expect(run('---\nname: reviewer\ndescription: d\n').map((finding) => finding.message)).toEqual([
      'The frontmatter has no closing "---" line, so Claude Code cannot read its name or description and does not load this subagent.',
    ]);
    expect(run('+++\nname = "reviewer"\n+++\n').map((finding) => finding.message)).toEqual([
      'The frontmatter is not YAML between "---" lines. Claude Code reads only YAML frontmatter, so it treats this file as documentation and does not load the subagent.',
    ]);
  });

  it('reports frontmatter that starts after a blank line', () => {
    expect(run('\n---\nname: reviewer\ndescription: d\n---\nBody\n')).toEqual([
      expect.objectContaining({
        message:
          'The frontmatter does not start on line 1, so Claude Code treats this file as documentation and does not load the subagent. Remove the lines before "---".',
        range: { start: { line: 2, column: 1 }, end: { line: 2, column: 4 } },
      }),
    ]);
  });

  describe('does not report documentation', () => {
    it.each([
      ['a README without frontmatter', '# Agents\n\nOur subagents live here.\n'],
      ['frontmatter without subagent fields', '---\ntitle: Agent notes\n---\n# Notes\n'],
      ['a thematic break after a blank line', '\n---\n\n# Notes\n'],
      ['a misplaced block without name or description', '\n---\ntitle: notes\n---\n'],
      ['an empty file', ''],
      ['only blank lines', '\n\n'],
      ['a non-string name', '---\nname: 42\ndescription: d\n---\n'],
    ])('%s', (_label, text) => {
      expect(run(text)).toEqual([]);
    });
  });

  it('does not claim Claude Code rejects frontmatter that only exceeds agentcheckup limits', () => {
    const huge = `---\nname: reviewer\ndescription: ${'x'.repeat(70_000)}\n---\n`;
    expect(run(huge)).toEqual([]);
  });

  it('checks nested agent directories', () => {
    expect(
      run('---\nname: -x\ndescription: d\n---\n', 'packages/api/.claude/agents/review/x.md'),
    ).toHaveLength(1);
  });
});
