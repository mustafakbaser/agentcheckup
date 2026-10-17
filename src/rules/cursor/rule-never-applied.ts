import { editableFile } from '../../core/directive-fixes.js';
import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, Fix, FixInput } from '../../core/types.js';
import { cursorActivation } from '../../platforms/cursor-rules.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';

const ID = 'cursor/rule-never-applied';

/**
 * Which mode fits is the author's choice, so no fix is ready-made: `alwaysApply: true` would add
 * the rule to every conversation, and globs or a description must come from the author.
 * `fix -i` asks for globs ({@link globsInput}).
 */
const GUIDANCE =
  'add "globs" with the files the rule is for, a "description" of when to use it, or "alwaysApply: true"; to keep it manual on purpose, add "alwaysApply: false"';

/**
 * What `fix -i` asks for a rule in `path` that Cursor should attach to files: `globs`, written
 * double-quoted as one comma-separated string, the form Cursor documents. Shared with
 * cursor/md-file-ignored.
 */
export function globsInput(path: string): FixInput {
  return {
    field: 'cursor-globs',
    question: 'Attach this rule to the files that match glob patterns, such as src/**/*.ts?',
    label: '"globs" patterns',
    target: { kind: 'frontmatter', path, key: 'globs' },
  };
}

/** The fix that needs the user's words: globs for a rule that Cursor applies only on request. */
function globsFix(artifact: Artifact): Fix | undefined {
  // Reached through a symlink, linked from another path, or not decoded cleanly.
  if (!editableFile(artifact)) return undefined;
  return {
    id: `${ID}#globs`,
    class: 'review',
    title: `Add "globs" to ${artifact.path}`,
    changes: [],
    input: globsInput(artifact.path),
  };
}

export const ruleNeverAppliedRule = defineRule({
  meta: {
    id: ID,
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
    fix: {
      classes: ['review'],
      summary:
        'Needs your words: `agentcheckup fix -i` asks for the glob patterns of the files the rule is for and writes them as "globs", adding frontmatter when the file has none.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const frontmatter = context.frontmatter(artifact);
      // Frontmatter that does not parse has an unknown mode; an explicit alwaysApply is on purpose.
      const activation = cursorActivation(frontmatter);
      if (activation.mode !== 'manual' || activation.alwaysApplySet) continue;
      const fix = globsFix(artifact);
      const repair = { ...(fix === undefined ? {} : { fix }), guidance: GUIDANCE };
      if (frontmatter.kind === 'absent') {
        context.report({
          artifact,
          message:
            'This rule has no frontmatter, so Cursor applies it only when you @-mention it. Add "description", "globs" or "alwaysApply: true" to apply it automatically.',
          ...repair,
        });
        continue;
      }
      context.report({
        artifact,
        span: { offset: 0, length: 3 },
        message:
          'This rule sets none of "alwaysApply", "description" and "globs", so Cursor applies it only when you @-mention it. Add one of them to apply it automatically.',
        ...repair,
      });
    }
  },
});
