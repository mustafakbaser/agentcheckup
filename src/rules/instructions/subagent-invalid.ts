import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, ReportDescriptor } from '../../core/types.js';
import { replaceSpan } from '../../fix/edits.js';
import { pathAs } from '../../platforms/readings.js';
import {
  checkSubagent,
  MAX_SUBAGENT_NAME_LENGTH,
  type SubagentIssue,
} from '../../platforms/subagents.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger, quote, quotePath } from '../shared/format.js';
import { byHand, editBlocker } from './fixes.js';
import { basename } from './helpers.js';
import { issueDetail } from './yaml.js';

const RULE_ID = 'instr/subagent-invalid';

/** A name Claude Code accepts and its documentation uses: lowercase letters, digits, hyphens. */
const SUGGESTED_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The finding message for one reason Claude Code skips a subagent file. */
function message(issue: SubagentIssue): string {
  switch (issue.code) {
    case 'misplaced-frontmatter':
      return 'The frontmatter does not start on line 1, so Claude Code treats this file as documentation and does not load the subagent. Remove the lines before "---".';
    case 'unclosed-frontmatter':
      return 'The frontmatter has no closing "---" line, so Claude Code cannot read its name or description and does not load this subagent.';
    case 'unsupported-frontmatter':
      return 'The frontmatter is not YAML between "---" lines. Claude Code reads only YAML frontmatter, so it treats this file as documentation and does not load the subagent.';
    case 'invalid-yaml':
      return issue.error.code === 'not-a-mapping'
        ? 'The frontmatter is not a YAML mapping of "key: value" fields, so Claude Code finds no name and does not load this subagent.'
        : `The frontmatter is not valid YAML (${issueDetail(issue.error)}), so Claude Code reads no fields from it and skips this subagent.`;
    case 'name-empty':
      return '"name" is empty, so Claude Code treats this file as documentation and does not load the subagent.';
    case 'name-missing':
      return 'The frontmatter has no "name", so Claude Code treats this file as documentation and does not load the subagent.';
    case 'name-leading-dash':
      return `Subagent name ${quote(issue.name)} starts with "-", so Claude Code skips this file.`;
    case 'name-colon':
      return `Subagent name ${quote(issue.name)} contains ":", which Claude Code reserves for plugin subagents, so it skips this file.`;
    case 'name-too-long':
      return `The subagent name is ${formatInteger(issue.length)} characters long, so Claude Code skips this file. The limit is ${formatInteger(MAX_SUBAGENT_NAME_LENGTH)} characters.`;
    case 'description-empty':
      return '"description" is empty, so Claude Code skips this subagent.';
    case 'description-missing':
      return 'The frontmatter has no "description", so Claude Code skips this subagent.';
  }
}

/** A name for the subagent from its file name, when that is already a valid one. */
function nameFromFile(artifact: Artifact): string | undefined {
  const file = basename(artifact.path);
  const name = file.toLowerCase().endsWith('.md') ? file.slice(0, -3) : file;
  return SUGGESTED_NAME.test(name) && name.length <= MAX_SUBAGENT_NAME_LENGTH ? name : undefined;
}

/**
 * Blank lines before the frontmatter are deleted: they are whitespace, so the fix keeps every
 * word. Every other problem needs a value only the author knows, or a YAML repair.
 */
function repair(
  artifact: Artifact,
  issue: SubagentIssue,
): Pick<ReportDescriptor, 'fix' | 'guidance'> {
  switch (issue.code) {
    case 'misplaced-frontmatter': {
      const blocker = editBlocker(artifact);
      if (blocker !== undefined) {
        return { guidance: byHand('delete the blank lines before "---"', blocker) };
      }
      return {
        fix: {
          id: `${RULE_ID}#leading-lines`,
          class: 'safe',
          title: `Delete the blank lines before the frontmatter of ${artifact.path}`,
          changes: [replaceSpan(artifact, { offset: 0, length: issue.span.offset }, '')],
        },
      };
    }
    case 'unclosed-frontmatter':
      return { guidance: 'add a "---" line after the last frontmatter field' };
    case 'unsupported-frontmatter':
      return { guidance: 'rewrite the frontmatter as YAML "key: value" lines between "---" lines' };
    case 'invalid-yaml':
      return {
        guidance:
          'correct the YAML; claude --debug shows why Claude Code skipped the file, and quoting a value that contains ": " often fixes it',
      };
    case 'name-empty':
    case 'name-missing': {
      const name = nameFromFile(artifact);
      return {
        guidance:
          name === undefined
            ? 'add a "name" of lowercase letters and hyphens to the frontmatter'
            : `add "name: ${name}" to the frontmatter`,
      };
    }
    case 'name-leading-dash':
      return { guidance: 'remove the leading "-" from the name' };
    case 'name-colon':
      return { guidance: 'replace ":" in the name with "-"' };
    case 'name-too-long':
      return {
        guidance: `shorten the name to ${formatInteger(MAX_SUBAGENT_NAME_LENGTH)} characters or fewer`,
      };
    case 'description-empty':
    case 'description-missing':
      return { guidance: 'add a "description" that says when Claude should use this subagent' };
  }
}

export const subagentInvalidRule = defineRule({
  meta: {
    id: RULE_ID,
    title: 'Claude Code skips a subagent with invalid frontmatter',
    rationale: [
      'Claude Code loads a subagent from `.claude/agents/` only when YAML frontmatter on the first line has a `name` and a `description`. Without a `name`, or with frontmatter that does not start on the first line, the file is treated as documentation. A `name` that starts with `-`, contains `:` (reserved for plugin subagents) or is longer than 256 characters, a missing `description`, and YAML that does not parse also make Claude Code skip the file. The session shows no message; the reason, if any, is only in the debug log (`claude --debug`).',
      "Files without frontmatter, such as a README in the agents directory, are documentation and are not reported. A file in another agent's folder, such as `.github/agents`, is checked when `.claude/agents` reaches it through a symlink: Claude Code follows the link and reads it as a subagent.",
      'Start the file with the `---` line, add the missing field, and fix the name or the YAML.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    // The other agents' files: `.claude/agents` may reach them through a symlink.
    appliesTo: ['claude-agent', 'cursor-agent', 'gemini-agent', 'copilot-agent', 'devin-agent'],
    platforms: ['claude-code'],
    sources: [SOURCES.claudeSubagents],
    since: RULESET_VERSION,
    fix: {
      classes: ['safe'],
      summary:
        'Deletes the blank lines before the frontmatter. Missing fields, names and YAML errors are left to you.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      // Another agent's file is a subagent where `.claude/agents` reaches it through a symlink.
      const path = pathAs(artifact, 'claude-agent');
      if (path === undefined) continue;
      const check = checkSubagent(artifact.decoded.text, context.frontmatter(artifact));
      if (check.status !== 'skipped') continue;
      const through =
        path === artifact.path ? '' : ` Claude Code reads this file as ${quotePath(path)}.`;
      for (const issue of check.issues) {
        context.report({
          artifact,
          span: issue.span,
          message: `${message(issue)}${through}`,
          ...repair(artifact, issue),
        });
      }
    }
  },
});
