import { RULESET_VERSION } from '../../core/meta.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';

function isSet(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

export const ruleNeverAppliedRule = defineRule({
  meta: {
    id: 'cursor/rule-never-applied',
    title: 'Cursor rule is applied only when @-mentioned',
    rationale: [
      'Cursor decides when to include a rule from its frontmatter. With `alwaysApply: true` the rule is always included; with `globs` it is attached when a matching file is in context; with only a `description` the agent includes it when relevant. With none of them the rule is included only when you @-mention it in chat.',
      'That manual mode is useful on purpose, so a rule that sets `alwaysApply: false` explicitly is not reported. A rule without frontmatter, or whose frontmatter sets none of the three fields, is reported as information because it is often an accident, for example a file copied from another tool.',
      'Add `alwaysApply: true`, `globs` or a `description`, or set `alwaysApply: false` to keep the rule manual on purpose.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'info',
    appliesTo: ['cursor-rule'],
    platforms: ['cursor'],
    sources: [SOURCES.cursorRules],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const frontmatter = context.frontmatter(artifact);
      if (frontmatter.kind === 'absent') {
        context.report({
          artifact,
          message:
            'This rule has no frontmatter, so Cursor applies it only when you @-mention it. Add "description", "globs" or "alwaysApply: true" to apply it automatically.',
        });
        continue;
      }
      if (frontmatter.kind !== 'valid') continue;
      const { values } = frontmatter.data;
      if (Object.hasOwn(values, 'alwaysApply')) continue;
      if (isSet(values['description']) || isSet(values['globs'])) continue;
      context.report({
        artifact,
        span: { offset: 0, length: 3 },
        message:
          'This rule sets none of "alwaysApply", "description" and "globs", so Cursor applies it only when you @-mention it. Add one of them to apply it automatically.',
      });
    }
  },
});
