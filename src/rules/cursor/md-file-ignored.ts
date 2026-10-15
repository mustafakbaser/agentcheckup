import { RULESET_VERSION } from '../../core/meta.js';
import { isRulesReadme } from '../../platforms/cursor-rules.js';
import { defineRule } from '../define.js';
import { quote } from '../shared/format.js';
import { basename } from '../instructions/helpers.js';
import { SOURCES } from '../sources.js';
import { CURSOR_SOURCES } from './sources.js';

export const mdFileIgnoredRule = defineRule({
  meta: {
    id: 'cursor/md-file-ignored',
    title: 'Cursor ignores .md files in .cursor/rules',
    rationale: [
      'Cursor loads project rules from `.cursor/rules` only when they use the `.mdc` extension. Its documentation says a plain `.md` file there "is ignored by the rules system" because it has no frontmatter to set `description`, `globs` and `alwaysApply`. Devin Local, the default agent in Windsurf (now Devin Desktop), does read `.md` files in `.cursor/rules`, so the same file applies in Windsurf and not in Cursor.',
      'A `README.md` in the directory is treated as documentation and is not reported.',
      'Rename the file to `.mdc` and add frontmatter, or move plain Markdown instructions to `AGENTS.md`.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: ['cursor-rule-md'],
    platforms: ['cursor'],
    sources: [SOURCES.cursorRules, CURSOR_SOURCES.devinCliRules],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      if (isRulesReadme(artifact.path)) continue;
      const name = basename(artifact.path);
      const renamed = `${name.slice(0, -'.md'.length)}.mdc`;
      context.report({
        artifact,
        message: `Cursor loads only .mdc files from .cursor/rules, so it ignores ${quote(name)}. Rename it to ${quote(renamed)} and add frontmatter with description, globs or alwaysApply.`,
      });
    }
  },
});
