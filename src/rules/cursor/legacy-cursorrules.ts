import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix } from '../../core/paths.js';
import type { Artifact, Fix, ReportDescriptor, RuleContext } from '../../core/types.js';
import { prependFrontmatter, renameFile } from '../../fix/edits.js';
import { defineRule } from '../define.js';
import { joinPath } from '../instructions/helpers.js';
import { editAt, isLinked, linkedGuidance, pathTaken } from './fixes.js';
import { CURSOR_SOURCES } from './sources.js';

const ID = 'cursor/legacy-cursorrules';

/** The Always Apply rule Cursor's migration steps move `.cursorrules` to. */
const RULE_PATH = '.cursor/rules/cursorrules.mdc';

const CLINE_NOTE =
  'Cline reads .cursorrules but not .cursor/rules, so it stops loading these instructions.';
const DEVIN_NOTE = 'Devin Local reads .cursor/rules, so it starts loading these instructions.';

type Context = Pick<RuleContext<undefined>, 'frontmatter' | 'snapshot'>;

/** The `-i` alternative: rename to AGENTS.md, when the directory has none. */
function agentsMdAlternative(
  context: Context,
  artifact: Artifact,
  directory: string,
): Fix | undefined {
  const target = joinPath(directory, 'AGENTS.md');
  if (pathTaken(context.snapshot, target)) return undefined;
  return {
    id: `${ID}#agents-md`,
    class: 'review',
    title: `Rename ${artifact.path} to ${target}`,
    changes: [renameFile(artifact, target)],
    notes: [
      'Cursor and Cline keep reading these instructions as AGENTS.md, and Codex, GitHub Copilot and Devin Local start reading them.',
    ],
  };
}

function fixFor(context: Context, artifact: Artifact): Pick<ReportDescriptor, 'fix' | 'guidance'> {
  if (isLinked(artifact)) {
    return { guidance: linkedGuidance(artifact, `move it to ${RULE_PATH}`) };
  }
  const directory = dirnamePosix(artifact.path);
  const target = joinPath(directory, RULE_PATH);
  const agentsMd = joinPath(directory, 'AGENTS.md');
  if (pathTaken(context.snapshot, target)) {
    return { guidance: `${target} already exists: merge ${artifact.path} into it by hand` };
  }
  const frontmatter = context.frontmatter(artifact);
  const prepend = prependFrontmatter(artifact, frontmatter, [{ key: 'alwaysApply', value: true }]);
  if (prepend === undefined) {
    return {
      guidance: `the file starts with a "---" block: move it to ${target} by hand and give it the frontmatter "alwaysApply: true"`,
    };
  }
  const alternative = agentsMdAlternative(context, artifact, directory);
  const notes = [CLINE_NOTE, DEVIN_NOTE];
  if (directory !== '') {
    notes.push(
      `Cursor reads this .cursorrules only when ${directory} is the workspace folder. Opened at the repository root, Cursor may also apply the new rule to files in ${directory}.`,
    );
  }
  return {
    fix: {
      id: `${ID}#cursor-rule`,
      class: 'review',
      title: `Move ${artifact.path} to ${target} with "alwaysApply: true"`,
      changes: [renameFile(artifact, target), editAt(target, prepend)],
      notes,
      ...(alternative === undefined ? {} : { alternatives: [alternative] }),
    },
    // Merging two instruction files needs judgment: the tool never does it.
    ...(alternative === undefined
      ? {
          guidance: `to use AGENTS.md instead, which more agents read, merge ${artifact.path} into ${agentsMd} by hand`,
        }
      : {}),
  };
}

export const legacyCursorrulesRule = defineRule({
  meta: {
    id: ID,
    title: '.cursorrules is a legacy file that Cursor plans to deprecate',
    rationale: [
      'Cursor\'s help center calls the `.cursorrules` file in the project root "legacy" and says it "will be deprecated". Its migration steps move the content into a project rule in `.cursor/rules` with the type **Always Apply**, which matches the old behavior.',
      'Cline also reads `.cursorrules`. Moving the instructions to `AGENTS.md` instead keeps them working in Cursor and Cline, and also in Codex, GitHub Copilot and Devin Local.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'info',
    appliesTo: ['cursor-legacy-rules'],
    platforms: ['cursor'],
    sources: [CURSOR_SOURCES.cursorRulesHelp],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      summary:
        'Moves the file to .cursor/rules/cursorrules.mdc with "alwaysApply: true", as Cursor\'s migration steps do. `fix -i` also offers renaming it to AGENTS.md when the directory has none.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      context.report({
        artifact,
        message:
          '.cursorrules is a legacy file that Cursor says "will be deprecated". Move its content to AGENTS.md or to an Always Apply rule in .cursor/rules.',
        ...fixFor(context, artifact),
      });
    }
  },
});
