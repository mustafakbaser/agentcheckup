import { describe, expect, it } from 'vitest';
import { analyze } from '../../../src/core/engine.js';
import type { Fix } from '../../../src/core/types.js';
import { completeInput, verifyCompletedInput } from '../../../src/fix/input.js';
import { fixRounds, type FixScanOptions } from '../../../src/fix/verify.js';
import { builtinRules } from '../../../src/rules/index.js';
import { descriptionQualityRule } from '../../../src/rules/skill/description-quality.js';
import { textOf } from '../../fix/helpers.js';
import { findings, lint, type SnapshotExtras, snapshotFrom } from '../../helpers/lint.js';

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

  describe('fixes that need your words', () => {
    const LONG = 'Extract text and tables from PDF files, fill forms and merge documents';
    const options: FixScanOptions = { rules: builtinRules };

    function fixFor(description: string, extras: SnapshotExtras = {}): Fix | undefined {
      const files = { [PATH]: `---\nname: pdf\ndescription: ${description}\n---\nBody.\n` };
      const result = lint(files, { rules: [descriptionQualityRule], ...extras });
      const [finding, ...rest] = result.findings.filter((item) => item.ruleId === ID);
      expect(rest).toEqual([]);
      return finding?.fix;
    }

    /** The fix completed with `answer` and verified with every built-in rule. */
    function answered(text: string, answer: string) {
      const snapshot = snapshotFrom({ [PATH]: text });
      const [entry] = fixRounds(snapshot, options, {
        classes: new Set(['review']),
        ruleIds: new Set([ID]),
        literalSecret: false,
      }).awaitingInput;
      if (entry === undefined) throw new Error('No fix awaits input.');
      const completion = completeInput(entry.fix, answer, analyze(snapshot, options));
      if (!completion.ok) return completion;
      const verified = verifyCompletedInput(snapshot, options, entry, completion.fix);
      return verified.ok ? { ok: true, text: textOf(verified.run.snapshot, PATH) } : verified;
    }

    it('asks for a "Use when ..." sentence after a description of 8 words or more', () => {
      expect(fixFor(LONG)).toEqual({
        id: 'skill/description-quality#when-clause',
        class: 'review',
        title: `Add a "Use when ..." sentence to "description" in ${PATH}`,
        changes: [],
        input: {
          field: 'skill-when-clause',
          question: 'Add a sentence that says when to use this skill?',
          label: 'a "Use when ..." clause',
          initial: 'Use when ',
          target: { kind: 'frontmatter', path: PATH, key: 'description', prefix: `${LONG}. ` },
        },
      });
      // A description that ends a sentence gets a space, not another period.
      expect(fixFor(`${LONG}!`)?.input?.target).toMatchObject({ prefix: `${LONG}! ` });
    });

    it('asks for a new description, prefilled, when it has fewer than 8 words', () => {
      expect(fixFor('Helps with documents')).toEqual({
        id: 'skill/description-quality#rewrite',
        class: 'review',
        title: `Rewrite "description" in ${PATH}`,
        changes: [],
        input: {
          field: 'skill-description',
          question: 'Rewrite the description to say what the skill does and when to use it?',
          label: 'a description of what the skill does and when to use it',
          initial: 'Helps with documents',
          target: { kind: 'frontmatter', path: PATH, key: 'description' },
        },
      });
      expect(fixFor('Writes <b>bold</b> docs')?.input?.initial).toBeUndefined();
    });

    it('asks nothing for a symlinked file or a description that cannot take a sentence', () => {
      expect(fixFor(LONG, { symlinks: { [PATH]: 'shared/pdf/SKILL.md' } })).toBeUndefined();
      expect(fixFor('Helps with documents', { symlinks: { [PATH]: 'x/SKILL.md' } })).toBe(
        undefined,
      );
      expect(fixFor(`"${LONG} <b>now</b>"`)).toBeUndefined();
      expect(fixFor(`"${LONG}${' and more'.repeat(130)}"`)).toBeUndefined();
    });

    it('asks nothing for a SKILL.md another path links to', () => {
      const text = `---\nname: pdf\ndescription: ${LONG}\n---\nBody.\n`;
      const alias = '.claude/skills/pdf/SKILL.md';
      const result = lint(
        { [PATH]: text, [alias]: text },
        { rules: [descriptionQualityRule], symlinks: { [alias]: PATH } },
      );
      const reported = result.findings.filter((item) => item.ruleId === ID);
      expect(reported.length).toBeGreaterThan(0);
      for (const finding of reported) expect(finding.fix).toBeUndefined();
    });

    it('writes an answer that says when, and refuses one that does not, in the rule’s words', () => {
      const text = `---\nname: pdf\ndescription: ${LONG}\n---\nBody.\n`;
      expect(answered(text, 'Use when the user asks about PDF files.')).toEqual({
        ok: true,
        text: `---\nname: pdf\ndescription: "${LONG}. Use when the user asks about PDF files."\n---\nBody.\n`,
      });
      expect(answered(text, 'It is fast.')).toEqual({
        ok: false,
        message:
          'The description does not say when to use the skill. Add a "Use when ..." clause with the situations and keywords that should trigger it.',
      });
      const short = '---\nname: pdf\ndescription: Helps with documents\n---\nBody.\n';
      expect(answered(short, 'Fills PDF forms. Use when the user asks to fill a form.')).toEqual({
        ok: true,
        text: '---\nname: pdf\ndescription: "Fills PDF forms. Use when the user asks to fill a form."\n---\nBody.\n',
      });
      expect(answered(short, 'Helps with PDF documents')).toMatchObject({
        ok: false,
        message: expect.stringContaining('The description has only 4 words') as unknown,
      });
    });
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
