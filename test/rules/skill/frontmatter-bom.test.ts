import { describe, expect, it } from 'vitest';
import { frontmatterBomRule } from '../../../src/rules/skill/frontmatter-bom.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'skill/frontmatter-bom';
const PATH = '.agents/skills/deploy/SKILL.md';
const encoder = new TextEncoder();
const withBom = (text: string) => new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(text)]);
const MESSAGE =
  'SKILL.md starts with an invisible UTF-8 byte order mark (U+FEFF) before `---`. Codex does not recognize the frontmatter and skips the skill.';

describe('skill/frontmatter-bom', () => {
  it('reports a byte order mark before the frontmatter', () => {
    const result = lint(
      { [PATH]: withBom('---\nname: deploy\ndescription: Deploys.\n---\n') },
      { rules: [frontmatterBomRule] },
    );
    expect(findings(result, ID)).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: PATH,
        message: MESSAGE,
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } },
      },
    ]);
    // Gemini CLI also reads .agents/skills, but removes the mark first.
    expect(result.findings[0]?.platforms).toEqual(['codex']);
    expect(result.findings[0]?.fix?.id).toBe('skill/frontmatter-bom#remove-bom');
  });

  it('reports invalid and CRLF frontmatter too', () => {
    const invalid = lint(
      { [PATH]: withBom('---\nname: [\n---\n') },
      { rules: [frontmatterBomRule] },
    );
    expect(findings(invalid, ID)).toHaveLength(1);
    const crlf = lint(
      { [PATH]: withBom('---\r\nname: déploiement\r\n---\r\n') },
      { rules: [frontmatterBomRule] },
    );
    expect(findings(crlf, ID)).toHaveLength(1);
  });

  it('only reports for targeted platforms', () => {
    const files = { [PATH]: withBom('---\nname: deploy\n---\n') };
    expect(lint(files, { rules: [frontmatterBomRule], targets: ['claude-code'] }).findings).toEqual(
      [],
    );
    const codex = lint(files, { rules: [frontmatterBomRule], targets: ['codex', 'cursor'] });
    expect(codex.findings.map((f) => [f.severity, f.platforms])).toEqual([['error', ['codex']]]);
    expect(lint(files, { rules: [frontmatterBomRule], targets: ['gemini'] }).findings).toEqual([]);
    expect(lint(files, { rules: [frontmatterBomRule], targets: ['cursor'] }).findings).toEqual([]);
  });

  it('adds the validators for a distributable skill', () => {
    const result = lint(
      { 'skills/deploy/SKILL.md': withBom('---\nname: deploy\n---\n') },
      { rules: [frontmatterBomRule] },
    );
    expect(result.findings.map((f) => [f.severity, f.platforms, f.message])).toEqual([
      [
        'error',
        ['claude-code', 'codex'],
        'SKILL.md starts with an invisible UTF-8 byte order mark (U+FEFF) before `---`. Codex does not recognize the frontmatter and skips the skill, and the skills-ref validator and the anthropics/skills packager reject it.',
      ],
    ]);
  });

  it('does not report where Codex does not load the skill', () => {
    const result = lint(
      { '.claude/skills/deploy/SKILL.md': withBom('---\nname: deploy\n---\n') },
      { rules: [frontmatterBomRule] },
    );
    expect(result.findings).toEqual([]);
  });

  it('does not report a skill only Gemini CLI loads, which removes the mark', () => {
    const result = lint(
      {
        '.gemini/skills/deploy/SKILL.md': withBom(
          '---\nname: deploy\ndescription: Deploys.\n---\n',
        ),
      },
      { rules: [frontmatterBomRule] },
    );
    expect(result.findings).toEqual([]);
  });

  it('does not report files without a byte order mark', () => {
    const result = lint(
      { [PATH]: '---\nname: deploy\ndescription: Deploys.\n---\n' },
      { rules: [frontmatterBomRule] },
    );
    expect(findings(result, ID)).toEqual([]);
  });

  it('leaves a byte order mark without frontmatter to skill/frontmatter-missing', () => {
    const result = lint(
      { [PATH]: withBom('# Deploy\n'), 'x/SKILL.md': withBom('---\nname: a\n') },
      { rules: [frontmatterBomRule] },
    );
    expect(findings(result, ID)).toEqual([]);
  });

  it('ignores UTF-16 files, which are an encoding problem rather than a stray mark', () => {
    const text = '---\nname: deploy\n---\n';
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) utf16[2 + i * 2] = text.charCodeAt(i);
    const result = lint({ [PATH]: utf16 }, { rules: [frontmatterBomRule] });
    expect(findings(result, ID)).toEqual([]);
  });
});
