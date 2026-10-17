import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../../src/core/types.js';
import { fieldTypeRule } from '../../../src/rules/skill/field-type.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'skill/field-type';

function check(
  frontmatter: string,
  path = 'skills/deploy/SKILL.md',
  targets?: readonly PlatformId[],
) {
  const result = lint(
    { [path]: `---\nname: deploy\ndescription: Deploys.\n${frontmatter}---\n` },
    { rules: [fieldTypeRule], ...(targets ? { targets } : {}) },
  );
  findings(result, ID);
  return result.findings.map((f) => ({
    severity: f.severity,
    platforms: f.platforms,
    message: f.message,
    range: f.range,
  }));
}

describe('skill/field-type', () => {
  it('reports text metadata as an error where Codex reads the skill', () => {
    expect(check('metadata: owned by ops\n')).toEqual([
      {
        severity: 'error',
        platforms: ['claude-code', 'codex'],
        message:
          '`metadata` is text, not a map. Codex cannot read the frontmatter and skips the skill, and the Agent Skills specification requires a map of string keys to string values.',
        range: { start: { line: 4, column: 11 }, end: { line: 4, column: 23 } },
      },
    ]);
    expect(check('metadata: 3\n', '.agents/skills/deploy/SKILL.md')).toEqual([
      expect.objectContaining({
        severity: 'error',
        platforms: ['codex'],
        message:
          '`metadata` is a number, not a map. Codex cannot read the frontmatter and skips the skill.',
      }),
    ]);
  });

  it('does not report non-map metadata where neither Codex nor a validator reads the skill', () => {
    expect(check('metadata: 3\n', '.claude/skills/deploy/SKILL.md')).toEqual([]);
    expect(check('metadata:\n  - a\n', '.claude/skills/deploy/SKILL.md')).toEqual([]);
  });

  it('reports list metadata without claiming Codex fails', () => {
    expect(check('metadata:\n  - a\n  - b\n')[0]).toEqual(
      expect.objectContaining({
        severity: 'warn',
        message:
          '`metadata` is a list, not a map. The Agent Skills specification requires a map of string keys to string values.',
      }),
    );
  });

  it('reports metadata values that are not text', () => {
    expect(check('metadata:\n  version: 2\n  beta: true\n  owner: ops\n  empty:\n')).toEqual([
      expect.objectContaining({
        severity: 'warn',
        message:
          'In `metadata`, "version" is a number and "beta" is a boolean, but the Agent Skills specification allows only text values. Quote them.',
        range: { start: { line: 5, column: 3 }, end: { line: 8, column: 9 } },
      }),
    ]);
    expect(check('metadata:\n  a: 1\n  b: 2\n  c: 3\n  d: [x]\n  e: {f: g}\n')[0]?.message).toBe(
      'In `metadata`, "a" is a number, "b" is a number, "c" is a number and 2 more are not text, but the Agent Skills specification allows only text values. Store nested data as text, or keep it outside `metadata`.',
    );
    expect(check('metadata:\n  nested: {a: b}\n')[0]?.message).toBe(
      'In `metadata`, "nested" is a map, but the Agent Skills specification allows only text values. Store nested data as text, or keep it outside `metadata`.',
    );
    expect(check('metadata:\n  n: 1\n')[0]?.message).toBe(
      'In `metadata`, "n" is a number, but the Agent Skills specification allows only text values. Quote it.',
    );
  });

  it('reports compatibility that is not text or too long', () => {
    expect(check('compatibility: 3\n')[0]?.message).toBe(
      '`compatibility` is a number, not text. The skills-ref validator and the anthropics/skills packager reject it.',
    );
    expect(check(`compatibility: ${'c'.repeat(501)}\n`)[0]?.message).toBe(
      '`compatibility` is 501 characters, over the 500 that the Agent Skills specification and Claude Code allow, so the skills-ref validator and the anthropics/skills packager reject it.',
    );
    expect(check(`compatibility: ${'ç'.repeat(500)}\n`)).toEqual([]);
  });

  it('reports allowed-tools lists and other non-strings', () => {
    expect(check('allowed-tools:\n  - Read\n  - Grep\n')[0]?.message).toBe(
      '`allowed-tools` is a YAML list. Claude Code accepts one, but the Agent Skills specification defines a space-separated string.',
    );
    expect(check('allowed-tools: {Bash: true}\n')[0]?.message).toBe(
      '`allowed-tools` is a map, not a space-separated string of tool names.',
    );
    expect(check('allowed-tools: [Read, 3]\n')[0]?.message).toBe(
      '`allowed-tools` is a list, not a space-separated string of tool names.',
    );
  });

  it('reports a license that is not text', () => {
    expect(check('license: 2024\n')[0]?.message).toBe(
      '`license` is a number, not text. The Agent Skills specification expects a license name or the name of a bundled license file.',
    );
  });

  it('does not report correct types or empty values', () => {
    expect(
      check(
        'license: MIT\ncompatibility: Requires git and Python 3.12\nallowed-tools: Read Grep Bash(git status *)\nmetadata:\n  version: "2"\n  owner: Çağrı\n',
      ),
    ).toEqual([]);
    expect(check('metadata:\nlicense:\ncompatibility: ~\nallowed-tools:\n')).toEqual([]);
    expect(check('metadata: {}\n')).toEqual([]);
  });

  it('reports to Cline a disabled or enabled flag that is not a boolean', () => {
    const run = (frontmatter: string, path = '.cline/skills/deploy/SKILL.md') =>
      lint(
        { [path]: `---\nname: deploy\ndescription: Deploys.\n${frontmatter}---\nSteps.\n` },
        { rules: [fieldTypeRule] },
      ).findings.map((f) => [f.severity, f.platforms, f.message, f.range.start.line]);
    expect(run('disabled: "false"\n')).toEqual([
      [
        'error',
        ['cline'],
        '`disabled` is text, not a boolean. Cline cannot read the frontmatter and skips the skill.',
        4,
      ],
    ]);
    expect(run('enabled: 0\n')[0]?.[2]).toBe(
      '`enabled` is a number, not a boolean. Cline cannot read the frontmatter and skips the skill.',
    );
    // Cline reads `enabled` only when `disabled` is not set, and booleans are fine.
    expect(run('disabled: false\nenabled: 0\n')).toEqual([]);
    expect(run('disabled: true\nenabled: false\n')).toEqual([]);
    expect(run('disabled: "yes"\n', '.cursor/skills/deploy/SKILL.md')).toEqual([]);
  });

  it('honors targets', () => {
    expect(check('metadata: text\n', 'skills/x/SKILL.md', ['codex'])).toEqual([
      expect.objectContaining({ severity: 'error', platforms: ['codex'] }),
    ]);
    expect(check('license: 3\n', 'skills/x/SKILL.md', ['codex'])).toEqual([]);
  });
});
