/**
 * Fixes and manual steps of the directive findings: removing an unused directive only when every
 * rule it names checked the file, correcting a misspelled rule id, and the form a directive
 * without a reason should have.
 */
import { describe, expect, it } from 'vitest';
import {
  boundedDistance,
  directiveRemoval,
  missingReasonGuidance,
  similarRuleIds,
} from '../../src/core/directive-fixes.js';
import { analyze, runRules } from '../../src/core/engine.js';
import { parseDirective } from '../../src/core/suppress.js';
import { claudeMdTooLongRule } from '../../src/rules/instructions/claude-md-too-long.js';
import { emptyFileRule } from '../../src/rules/instructions/empty-file.js';
import { vagueDirectiveRule } from '../../src/rules/instructions/vague-directive.js';
import { lint, snapshotFrom } from '../helpers/lint.js';
import { fixedText, fixFiles, repairs, selectRule } from '../rules/instructions/fix-helpers.js';

const UNUSED = 'directive/unused';
const UNKNOWN = 'directive/unknown-rule';
const rules = [vagueDirectiveRule, claudeMdTooLongRule, emptyFileRule];
const directive = (ids: string, scope = 'next-line') =>
  `<!-- agentcheckup-disable-${scope} ${ids} -- legacy wording -->`;

function removed(text: string, comment: string): string {
  const offset = text.indexOf(comment);
  const span = directiveRemoval(text, { offset, length: comment.length });
  return text.slice(0, span.offset) + text.slice(span.offset + span.length);
}

describe('directiveRemoval', () => {
  const comment = directive('instr/vague-directive');

  it.each([
    ['its own line between blank lines', `# A\n\n${comment}\n\nB\n`, '# A\n\nB\n'],
    ['its own line before text', `# A\n\n${comment}\nB\n`, '# A\n\nB\n'],
    ['its own line after text', `# A\n${comment}\n\nB\n`, '# A\n\nB\n'],
    ['the first line', `${comment}\n\n# A\n`, '# A\n'],
    ['the last line without a line break', `# A\n${comment}`, '# A'],
    ['the only line', `${comment}\n`, ''],
    ['CRLF lines', `# A\r\n\r\n${comment}\r\n\r\nB\r\n`, '# A\r\n\r\nB\r\n'],
    ['indented', `- a\n  ${comment}\n- b\n`, '- a\n- b\n'],
    ['after text on its line', `Use pnpm.  ${comment}\nB\n`, 'Use pnpm.\nB\n'],
    ['before text on its line', `${comment} Use pnpm.\n`, 'Use pnpm.\n'],
  ])('removes a comment on %s', (_label, text, expected) => {
    expect(removed(text, comment)).toBe(expected);
  });

  it('removes a comment that spans lines with its lines', () => {
    const multi = '<!--\nagentcheckup-disable-file instr/vague-directive -- legacy\n-->';
    expect(removed(`# A\n\n${multi}\n\nB\n`, multi)).toBe('# A\n\nB\n');
  });
});

describe('similar rule ids', () => {
  it('measures edit distance up to a bound', () => {
    expect(boundedDistance('instr/encoding', 'instr/encoding', 2)).toBe(0);
    expect(boundedDistance('instr/encodng', 'instr/encoding', 2)).toBe(1);
    expect(boundedDistance('instr/ecnoding', 'instr/encoding', 2)).toBe(2);
    expect(boundedDistance('instr/x', 'instr/encoding', 2)).toBe(3);
    expect(boundedDistance('abcdef', 'ghijkl', 2)).toBe(3);
  });

  it('finds ids within two edits, ignoring case and directive ids', () => {
    const known = ['instr/encoding', 'instr/empty-file', 'skill/name-format', 'directive/unused'];
    expect(similarRuleIds('Instr/Encoding', known)).toEqual(['instr/encoding']);
    expect(similarRuleIds('directive/unsed', known)).toEqual([]);
    expect(similarRuleIds('x'.repeat(10_000), known)).toEqual([]);
  });
});

describe('directive/unused fix', () => {
  it('removes an unused directive when every rule it names checked the file, as a safe fix', () => {
    const text = `# Rules\n\n${directive('instr/vague-directive')}\n\nUse pnpm.\n`;
    const result = lint({ 'AGENTS.md': text }, { rules });
    expect(repairs(result, UNUSED)).toEqual([
      {
        path: 'AGENTS.md',
        fix: {
          id: `${UNUSED}#remove`,
          class: 'safe',
          title: 'Remove the unused directive on line 3 of AGENTS.md',
          changes: [
            {
              kind: 'edit',
              path: 'AGENTS.md',
              edits: [{ offset: 9, length: 81, text: '' }],
            },
          ],
        },
      },
    ]);
    const run = fixFiles({ 'AGENTS.md': text }, { rules }, selectRule(UNUSED));
    expect(fixedText(run, 'AGENTS.md')).toBe('# Rules\n\nUse pnpm.\n');
  });

  describe('leaves to the user', () => {
    const guidance =
      'remove the directive unless a rule it names reports here with other targets or settings';

    it.each([
      ['a rule that does not check the file', 'AGENTS.md', 'instr/claude-md-too-long', {}],
      [
        'a rule for an agent the user does not target',
        'CLAUDE.md',
        'instr/claude-md-too-long',
        { targets: ['codex' as const] },
      ],
      [
        'a rule turned off',
        'AGENTS.md',
        'instr/vague-directive',
        { config: { rules: { 'instr/vague-directive': 'off' } } },
      ],
      ['a rule that is not in this scan', 'AGENTS.md', 'skill/name-format', {}],
    ])('a directive naming %s', (_label, path, id, options) => {
      const text = `# Rules\n\n${directive(id)}\nUse pnpm.\n`;
      const result = lint({ [path]: text }, { rules, ...options });
      expect(repairs(result, UNUSED)).toEqual([{ path, guidance }]);
    });

    it('a file that another path links to', () => {
      const text = `${directive('instr/vague-directive')}\nUse pnpm.\n`;
      const result = lint(
        { 'AGENTS.md': text, 'CLAUDE.md': text },
        { rules, symlinks: { 'CLAUDE.md': 'AGENTS.md' } },
      );
      expect(repairs(result, UNUSED)).toEqual([{ path: 'AGENTS.md', guidance }]);
    });

    it('a file whose Markdown was not analyzed to the end', () => {
      const text = `${directive('instr/vague-directive')}\nUse pnpm.\n${'More text.\n'.repeat(50)}`;
      const options = { rules, markdownBudget: 120 };
      const result = runRules(analyze(snapshotFrom({ 'AGENTS.md': text }), options), options);
      expect(repairs(result, UNUSED)).toEqual([{ path: 'AGENTS.md', guidance }]);
      // With the whole file analyzed, the same directive is proven unused.
      expect(repairs(lint({ 'AGENTS.md': text }, { rules }), UNUSED)[0]?.fix?.class).toBe('safe');
    });

    it('nothing in untrusted mode, where directives are ignored', () => {
      const text = `${directive('instr/vague-directive')}\nUse pnpm.\n`;
      const run = fixFiles(
        { 'AGENTS.md': text },
        { rules, trustDirectives: false },
        selectRule(UNUSED),
      );
      expect(
        run.before.findings.filter((finding) => finding.ruleId.startsWith('directive/')),
      ).toEqual([]);
      expect(run.applied).toEqual([]);
    });
  });
});

describe('directive/unknown-rule fix', () => {
  it('replaces a misspelled id with the only rule id within two edits, for review', () => {
    const text = `${directive('instr/vague-directve, instr/claude-md-too-long')}\nFollow best practices.\n`;
    const result = lint({ 'AGENTS.md': text }, { rules });
    expect(repairs(result, UNKNOWN)).toEqual([
      {
        path: 'AGENTS.md',
        fix: {
          id: `${UNKNOWN}#rename`,
          class: 'review',
          title:
            'Replace "instr/vague-directve" with "instr/vague-directive" in the directive on line 1',
          changes: [
            {
              kind: 'edit',
              path: 'AGENTS.md',
              edits: [{ offset: 36, length: 20, text: 'instr/vague-directive' }],
            },
          ],
          notes: [
            'The directive then suppresses instr/vague-directive findings on the line after it.',
          ],
        },
      },
    ]);
  });

  it('leaves an id with several similar rule ids, or none, to the user', () => {
    const ambiguous = lint(
      { 'AGENTS.md': `${directive('instr/empty-filed')}\nx\n` },
      {
        rules: [
          ...rules,
          { ...emptyFileRule, meta: { ...emptyFileRule.meta, id: 'instr/empty-fil' } },
        ],
      },
    );
    expect(repairs(ambiguous, UNKNOWN)).toEqual([
      {
        path: 'AGENTS.md',
        guidance:
          'replace it with the rule you meant (instr/empty-fil, instr/empty-file) or remove it',
      },
    ]);
    const none = lint({ 'AGENTS.md': `${directive('nothing/like-this')}\nx\n` }, { rules });
    expect(repairs(none, UNKNOWN)).toEqual([
      {
        path: 'AGENTS.md',
        guidance:
          'correct the id or remove it from the directive; every rule id is listed in the rule docs',
      },
    ]);
  });
});

describe('directive/missing-reason guidance', () => {
  it('shows the complete directive in the comment style of the file', () => {
    const html = lint(
      { 'AGENTS.md': '<!-- agentcheckup-disable-next-line instr/vague-directive -->\nx\n' },
      { rules },
    );
    expect(repairs(html, 'directive/missing-reason')).toEqual([
      {
        path: 'AGENTS.md',
        guidance:
          'write it as <!-- agentcheckup-disable-next-line instr/vague-directive -- <reason> -->',
      },
    ]);
    const parsed = parseDirective({
      text: '# agentcheckup-disable-file',
      span: { offset: 0, length: 27 },
      startLine: 2,
      endLine: 2,
    });
    expect(parsed === undefined ? undefined : missingReasonGuidance(parsed, true)).toBe(
      'write it as # agentcheckup-disable-file <rule-id> -- <reason>',
    );
  });
});

describe('parseDirective rule id spans', () => {
  it('locates each id in the text', () => {
    const text = '<!-- agentcheckup-disable-next-line  a/b ,c/d,, e/f -- why -->';
    const parsed = parseDirective({
      text,
      span: { offset: 10, length: text.length },
      startLine: 1,
      endLine: 1,
    });
    expect(parsed?.ruleIds).toEqual(['a/b', 'c/d', 'e/f']);
    expect(
      parsed?.ruleIdSpans.map((span) =>
        text.slice(span.offset - 10, span.offset - 10 + span.length),
      ),
    ).toEqual(['a/b', 'c/d', 'e/f']);
  });
});
