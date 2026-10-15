import { RULESET_VERSION } from '../../core/meta.js';
import {
  checkSubagent,
  MAX_SUBAGENT_NAME_LENGTH,
  type SubagentIssue,
} from '../../platforms/subagents.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger, quote } from '../shared/format.js';
import { issueDetail } from './yaml.js';

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

export const subagentInvalidRule = defineRule({
  meta: {
    id: 'instr/subagent-invalid',
    title: 'Claude Code skips a subagent with invalid frontmatter',
    rationale: [
      'Claude Code loads a subagent from `.claude/agents/` only when YAML frontmatter on the first line has a `name` and a `description`. Without a `name`, or with frontmatter that does not start on the first line, the file is treated as documentation. A `name` that starts with `-`, contains `:` (reserved for plugin subagents) or is longer than 256 characters, a missing `description`, and YAML that does not parse also make Claude Code skip the file. The session shows no message; the reason, if any, is only in the debug log (`claude --debug`).',
      'Files without frontmatter, such as a README in the agents directory, are documentation and are not reported.',
      'Start the file with the `---` line, add the missing field, and fix the name or the YAML.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: ['claude-agent'],
    platforms: ['claude-code'],
    sources: [SOURCES.claudeSubagents],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const check = checkSubagent(artifact.decoded.text, context.frontmatter(artifact));
      if (check.status !== 'skipped') continue;
      for (const issue of check.issues) {
        context.report({ artifact, span: issue.span, message: message(issue) });
      }
    }
  },
});
