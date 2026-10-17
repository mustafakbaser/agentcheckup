import { describe, expect, it } from 'vitest';
import { allRuleMeta } from '../../src/cli/common.js';
import { forYouReason } from '../../src/tasks/for-you.js';
import {
  genericTemplate,
  guardRulesOf,
  NO_SUPPRESSION,
  TEMPLATE_RULE_IDS,
  templateOf,
} from '../../src/tasks/templates.js';

const RULES = allRuleMeta();
const KNOWN = new Set(RULES.map((meta) => meta.id));

describe('task templates', () => {
  it('cover the rules that most often need judgment', () => {
    expect(TEMPLATE_RULE_IDS).toEqual(
      expect.arrayContaining([
        'skill/description-quality',
        'skill/description-missing',
        'skill/body-too-long',
        'skill/non-portable-field',
        'skill/broad-allowed-tools',
        'instr/claude-md-too-long',
        'instr/codex-size-budget',
        'instr/windsurf-rule-too-long',
        'cursor/rule-never-applied',
        'skill/broken-reference',
        'instr/import-unresolved',
      ]),
    );
  });

  it.each(TEMPLATE_RULE_IDS)(
    '%s names a rule, known guard rules, and is not for the user',
    (id) => {
      expect(KNOWN.has(id)).toBe(true);
      const template = templateOf(id);
      for (const guard of template?.guardRules ?? []) expect(KNOWN.has(guard)).toBe(true);
      expect(template?.guardRules).toContain('risk/hidden-unicode');
      expect(template?.do.length).toBeGreaterThan(0);
      expect(template?.why).not.toBe('');
      // A template for a rule whose findings are always for the user would never be used.
      const meta = RULES.find((candidate) => candidate.id === id);
      expect(meta?.appliesTo.some((kind) => forYouReason(id, kind) === undefined)).toBe(true);
    },
  );

  it('never tell an agent to widen what a skill may do', () => {
    for (const id of TEMPLATE_RULE_IDS) {
      const text = JSON.stringify(templateOf(id)).toLowerCase();
      expect(text).not.toMatch(/\badd (?:a |an )?(?:hook|permission|mcp server)/);
    }
  });

  it('give a rule without a template a generic one that asks before files change', () => {
    const meta = RULES.find((candidate) => candidate.id === 'instr/filename-case');
    if (meta === undefined) throw new Error('rule not found');
    expect(templateOf(meta.id)).toBeUndefined();
    const generic = genericTemplate(meta, true);
    expect(generic.do[0]).toBe('resolve the problem in this file as the hint describes');
    expect(generic.do[1]).toContain('docs/rules/instr/filename-case.md');
    expect(generic.askUser).toMatch(/^whether to create, rename or delete/);
    expect(generic.why.length).toBeLessThanOrEqual(401);
    expect(genericTemplate(meta, false).do).toHaveLength(1);
    expect(guardRulesOf(meta.id)).toEqual(['risk/hidden-unicode']);
  });

  it('cut a long rationale after a sentence', () => {
    const long = {
      ...RULES[0],
      id: 'x/y',
      rationale: `${'A short sentence. '.repeat(40)}\n\nSecond paragraph.`,
    } as (typeof RULES)[number];
    const why = genericTemplate(long, false).why;
    expect(why.endsWith('sentence.')).toBe(true);
    expect(why.length).toBeLessThanOrEqual(400);
    const unbroken = { ...long, rationale: 'x'.repeat(500) };
    expect(genericTemplate(unbroken, false).why).toMatch(/x…$/);
  });

  it('forbid suppressions in every task', () => {
    expect(NO_SUPPRESSION).toBe('do not add agentcheckup-disable comments');
  });
});
