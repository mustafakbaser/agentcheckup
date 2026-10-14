import { describe, expect, it } from 'vitest';
import type { PlatformId } from '../../../src/core/types.js';
import { yamlPortabilityRule } from '../../../src/rules/skill/yaml-portability.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'skill/yaml-portability';
/** Outside every skills directory and plugin: uploaded or installed on its own. */
const PATH = 'skills/deploy/SKILL.md';

function check(frontmatter: string, targets?: readonly PlatformId[]) {
  const result = lint(
    { [PATH]: `---\n${frontmatter}---\nBody.\n` },
    { rules: [yamlPortabilityRule], ...(targets ? { targets } : {}) },
  );
  return findings(result, ID).map((f) => ({
    severity: f.severity,
    message: f.message,
    range: f.range,
  }));
}

const at = (line: number, column: number, endColumn: number) => ({
  start: { line, column },
  end: { line, column: endColumn },
});

describe('skill/yaml-portability', () => {
  it('reports YAML 1.1 booleans', () => {
    expect(check('name: deploy\ndescription: Deploys.\nuser-invocable: no\n')).toEqual([
      {
        severity: 'warn',
        message:
          '"no" is text to YAML 1.2 parsers but the boolean false to YAML 1.1 parsers such as PyYAML, which the anthropics/skills packager uses. Quote it, or write `true` or `false`.',
        range: at(4, 17, 19),
      },
    ]);
    expect(check('name: deploy\ndescription: Deploys.\nbeta: On\n')[0]?.message).toContain(
      'the boolean true',
    );
  });

  it('reports numbers whose text changes', () => {
    expect(check('name: deploy\ndescription: Deploys.\nmetadata:\n  version: 1.10\n')).toEqual([
      {
        severity: 'warn',
        message:
          '"1.10" is the number 1.1 to YAML 1.2 parsers such as js-yaml, which Gemini CLI uses, but text to strictyaml, which the skills-ref validator uses. Quote it to keep the text.',
        range: at(5, 12, 16),
      },
    ]);
    expect(check('name: deploy\ndescription: Deploys.\nlimit: 0x1F\n')[0]?.message).toContain(
      'the number 31',
    );
  });

  it('reports anchors and aliases', () => {
    expect(check('name: &n deploy\ndescription: *n\n')).toEqual([
      {
        severity: 'warn',
        message:
          'This value defines a YAML anchor, and strictyaml, which the skills-ref validator uses, rejects anchors. Remove the anchor and write out the values that refer to it.',
        range: at(2, 10, 16),
      },
      {
        severity: 'warn',
        message:
          '"*n" is a YAML alias, and strictyaml, which the skills-ref validator uses, rejects aliases. Write the value out.',
        range: at(3, 14, 16),
      },
    ]);
  });

  it('reports explicit tags once per value', () => {
    expect(check('name: deploy\ndescription: !!str Deploys.\nother: !custom x\n')).toEqual([
      {
        severity: 'warn',
        message:
          'This value has an explicit YAML tag, and strictyaml, which the skills-ref validator uses, rejects tags. Remove the tag.',
        range: at(3, 20, 28),
      },
      {
        severity: 'warn',
        message:
          'This value has an explicit YAML tag, and strictyaml, which the skills-ref validator uses, rejects tags. Remove the tag.',
        range: at(4, 16, 17),
      },
    ]);
  });

  it('reports empty values by key name', () => {
    expect(
      check(
        'name: deploy\ndescription: Deploys.\nlicense: ~\nallowed-tools:\nmetadata:\n  owner:\n  team: null\n',
      ),
    ).toEqual([
      {
        severity: 'warn',
        message:
          '"license" is empty (null), but strictyaml, which the skills-ref validator uses, reads it as text. Remove the key or give it a value.',
        range: at(4, 10, 11),
      },
      {
        severity: 'warn',
        message:
          '"allowed-tools" is empty (null), but strictyaml, which the skills-ref validator uses, reads it as text. Remove the key or give it a value.',
        range: at(5, 1, 14),
      },
      {
        severity: 'warn',
        message:
          '"owner" is empty (null), but strictyaml, which the skills-ref validator uses, reads it as text. Remove the key or give it a value.',
        range: at(7, 3, 8),
      },
      {
        severity: 'warn',
        message:
          'This value is empty (null), but strictyaml, which the skills-ref validator uses, reads it as text. Remove the key or give it a value.',
        range: at(8, 9, 13),
      },
    ]);
  });

  it('leaves empty name and description to their own rules', () => {
    expect(check('name:\ndescription: ~\n')).toEqual([]);
  });

  it('does not report portable YAML', () => {
    expect(
      check(
        'name: deploy\ndescription: "Deploys: production. Use when shipping."\nlicense: MIT\nmetadata:\n  version: "1.0"\n  beta: "yes"\n  owner: Çağrı 🚀\ndisable-model-invocation: true\n',
      ),
    ).toEqual([]);
    expect(check('name: deploy\ndescription: 42 tests\ncount: 3\n')).toEqual([]);
  });

  it('does not run on invalid or missing frontmatter', () => {
    const result = lint(
      { [PATH]: '---\nname: [yes\n---\n', 'b/SKILL.md': '# yes\n' },
      { rules: [yamlPortabilityRule] },
    );
    expect(findings(result, ID)).toEqual([]);
  });

  it('only judges skills that are uploaded or installed on their own', () => {
    const frontmatter = '---\nname: deploy\nbeta: yes\nversion: 1.0\n---\n';
    const result = lint(
      {
        '.agents/skills/deploy/SKILL.md': frontmatter,
        'plugin/skills/deploy/SKILL.md': frontmatter,
      },
      { rules: [yamlPortabilityRule], paths: ['plugin/.claude-plugin/plugin.json'] },
    );
    expect(findings(result, ID)).toEqual([]);
  });

  it('honors targets', () => {
    const result = lint(
      { [PATH]: '---\nname: deploy\nbeta: yes\n---\n' },
      { rules: [yamlPortabilityRule], targets: ['codex'] },
    );
    expect(result.findings.map((f) => f.platforms)).toEqual([['codex']]);
  });

  it('handles CRLF line endings', () => {
    const result = lint(
      { [PATH]: '---\r\nname: deploy\r\nbeta: off\r\n---\r\n' },
      { rules: [yamlPortabilityRule] },
    );
    expect(findings(result, ID).map((f) => f.range)).toEqual([at(3, 7, 10)]);
  });
});
