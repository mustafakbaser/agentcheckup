import { describe, expect, it } from 'vitest';
import { descriptionQualityRule } from '../../../src/rules/skill/description-quality.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'skill/description-quality';
const PATH = 'skills/pdf/SKILL.md';

function check(description: string, path = PATH) {
  const result = lint(
    { [path]: `---\nname: pdf\ndescription: ${description}\n---\nBody.\n` },
    { rules: [descriptionQualityRule] },
  );
  return findings(result, ID).map((f) => ({
    severity: f.severity,
    message: f.message,
    range: f.range,
  }));
}

describe('skill/description-quality', () => {
  it('reports a description of a few words', () => {
    expect(check('Helps with documents')).toEqual([
      {
        severity: 'info',
        message:
          'The description has only 3 words, too few for agents to match requests against. Say what the skill does and when to use it.',
        range: { start: { line: 3, column: 14 }, end: { line: 3, column: 34 } },
      },
    ]);
  });

  it('reports a description without trigger phrasing', () => {
    expect(
      check('Extract text and tables from PDF files, fill forms and merge several documents.'),
    ).toEqual([
      expect.objectContaining({
        severity: 'info',
        message:
          'The description does not say when to use the skill. Add a "Use when ..." clause with the situations and keywords that should trigger it.',
      }),
    ]);
  });

  it('accepts descriptions that say when to use the skill', () => {
    for (const description of [
      'Extracts text and tables from PDF files. Use when working with PDF files or forms.',
      'Generates commit messages from staged changes whenever the user is about to commit.',
      'Reviews pull requests for style and correctness, useful for the final pass on a change.',
      'A set of checklists and scripts that the team relies on for reviewing database migrations.',
      'Formats the changelog and release notes for this repository if the user asks to release.',
      'Searches scientific web content with Exa. Applies to requests to search the web or fetch a page.',
      'Answers questions about the billing service and its data model for requests about invoices.',
    ]) {
      expect(check(description)).toEqual([]);
    }
  });

  it('skips descriptions that are not English prose', () => {
    expect(check('Dosyaları işler ve rapor üretir')).toEqual([]);
    expect(check('PDF dosyalarindan metin cikarir')).toEqual([]);
    expect(check('Traite les fichiers PDF et génère des rapports')).toEqual([]);
    expect(check('Erstellt Berichte aus Excel-Dateien')).toEqual([]);
    expect(check('处理 PDF 文件')).toEqual([]);
    expect(check('🚀 📄 ✅')).toEqual([]);
    expect(check('"1234 5678"')).toEqual([]);
  });

  it('does not report missing, empty or non-text descriptions', () => {
    const result = lint(
      {
        'a/SKILL.md': '---\nname: a\n---\n',
        'b/SKILL.md': '---\nname: b\ndescription: ""\n---\n',
        'c/SKILL.md': '---\nname: c\ndescription: [use the tool]\n---\n',
        'd/SKILL.md': '# no frontmatter\n',
      },
      { rules: [descriptionQualityRule] },
    );
    expect(findings(result, ID)).toEqual([]);
  });

  it('does not affect the score', () => {
    const result = lint(
      { [PATH]: '---\nname: pdf\ndescription: Helps with the files\n---\n' },
      { rules: [descriptionQualityRule] },
    );
    expect(result.score.score).toBe(100);
    expect(result.summary.infos).toBe(1);
  });
});
