import { RULESET_VERSION } from './meta.js';
import type { RuleMeta } from './types.js';

/**
 * Findings about agentcheckup's own inline directives. The engine reports these; they are not
 * runnable rules, but they have stable ids, docs pages and SARIF entries like any other rule.
 */
const SOURCE = {
  title: 'agentcheckup inline suppression directives',
  url: 'https://github.com/mustafakbaser/agentcheckup/blob/main/docs/configuration.md#inline-suppressions',
  checked: '2026-10-14',
  status: 'verified',
} as const;

const MARKDOWN_KINDS_FOR_DIRECTIVES = [
  'agents-md',
  'agents-override-md',
  'claude-md',
  'claude-local-md',
  'claude-rule',
  'claude-agent',
  'claude-command',
  'skill',
  'cursor-rule',
  'cursor-rule-md',
  'cursor-legacy-rules',
  'copilot-instructions',
  'copilot-path-instructions',
  'gemini-md',
  'windsurf-rule',
  'windsurf-legacy-rules',
  'cline-rule',
  'imported-file',
] as const;

const ALL_PLATFORMS = [
  'claude-code',
  'codex',
  'cursor',
  'copilot',
  'gemini',
  'windsurf',
  'cline',
] as const;

export const DIRECTIVE_MISSING_REASON: RuleMeta = {
  id: 'directive/missing-reason',
  title: 'Suppression directive has no rule id or no reason',
  rationale: [
    'An inline directive such as `<!-- agentcheckup-disable-next-line instr/import-unresolved -- generated file -->` must name the rules it disables and give a reason after ` -- `. A directive without either has no effect.',
    'Add the rule ids and a short reason.',
  ].join('\n\n'),
  category: 'correctness',
  severity: 'warn',
  appliesTo: MARKDOWN_KINDS_FOR_DIRECTIVES,
  platforms: ALL_PLATFORMS,
  sources: [SOURCE],
  since: RULESET_VERSION,
};

export const DIRECTIVE_UNUSED: RuleMeta = {
  id: 'directive/unused',
  title: 'Suppression directive does not suppress anything',
  rationale:
    'None of the rules the directive names reports a finding where it applies, so it suppresses nothing. Remove it so it cannot hide a future problem.',
  category: 'correctness',
  severity: 'warn',
  appliesTo: MARKDOWN_KINDS_FOR_DIRECTIVES,
  platforms: ALL_PLATFORMS,
  sources: [SOURCE],
  since: RULESET_VERSION,
};

export const DIRECTIVE_UNKNOWN_RULE: RuleMeta = {
  id: 'directive/unknown-rule',
  title: 'Suppression directive names a rule that does not exist',
  rationale: [
    'agentcheckup has no rule with this id, so the directive suppresses nothing for it. Rules the same directive names correctly are still suppressed.',
    'Check the id against the rule catalog; usually it is misspelled.',
  ].join('\n\n'),
  category: 'correctness',
  severity: 'warn',
  appliesTo: MARKDOWN_KINDS_FOR_DIRECTIVES,
  platforms: ALL_PLATFORMS,
  sources: [SOURCE],
  since: RULESET_VERSION,
};

export const DIRECTIVE_RULES: readonly RuleMeta[] = [
  DIRECTIVE_MISSING_REASON,
  DIRECTIVE_UNKNOWN_RULE,
  DIRECTIVE_UNUSED,
];
