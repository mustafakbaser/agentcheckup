import { RULESET_VERSION } from '../../core/meta.js';
import { defineRule } from '../define.js';
import { CURSOR_SOURCES } from './sources.js';

export const legacyCursorrulesRule = defineRule({
  meta: {
    id: 'cursor/legacy-cursorrules',
    title: '.cursorrules is a legacy file that Cursor plans to deprecate',
    rationale: [
      'Cursor\'s help center calls the `.cursorrules` file in the project root "legacy" and says it "will be deprecated". Its migration steps move the content into a project rule in `.cursor/rules` with the type **Always Apply**, which matches the old behavior.',
      'Cline also reads `.cursorrules`. Moving the instructions to `AGENTS.md` instead keeps them working in Cursor and Cline, and also in Codex, GitHub Copilot and Windsurf.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'info',
    appliesTo: ['cursor-legacy-rules'],
    platforms: ['cursor'],
    sources: [CURSOR_SOURCES.cursorRulesHelp],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      context.report({
        artifact,
        message:
          '.cursorrules is a legacy file that Cursor says "will be deprecated". Move its content to AGENTS.md or to an Always Apply rule in .cursor/rules.',
      });
    }
  },
});
