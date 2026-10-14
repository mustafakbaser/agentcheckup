import { RULESET_VERSION } from '../../core/meta.js';
import { codePointLength } from '../../core/measure.js';
import type { Artifact, RuleContext, Span } from '../../core/types.js';
import { parseFrontmatter } from '../../parse/frontmatter.js';
import type { FrontmatterData } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger, quote } from '../shared/format.js';
import { issueDetail, yamlSyntaxError } from './yaml.js';

/** Supported subagent fields other than `name` (code.claude.com/docs/en/sub-agents). */
const AGENT_FIELDS: ReadonlySet<string> = new Set([
  'description',
  'tools',
  'disallowedTools',
  'model',
  'permissionMode',
  'maxTurns',
  'autoCompactWindow',
  'skills',
  'mcpServers',
  'hooks',
  'memory',
  'background',
  'omitClaudeMd',
  'effort',
  'isolation',
  'color',
  'initialPrompt',
  'experimental',
]);

const MAX_NAME_LENGTH = 256;
const OPENING_DELIMITER: Span = { offset: 0, length: 3 };

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * A frontmatter block that starts after leading blank lines instead of on line 1. Claude Code
 * reads such a file as having no frontmatter. Returns the offset of the `---` line when the
 * block parses and declares a name or description, so it was clearly meant for Claude Code.
 */
function misplacedFrontmatter(text: string): number | undefined {
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const end = newline === -1 ? text.length : newline;
    if (text.slice(offset, end).trim() !== '') break;
    if (newline === -1) return undefined;
    offset = newline + 1;
  }
  if (offset === 0 || !text.startsWith('---', offset)) return undefined;
  const block = parseFrontmatter(text.slice(offset));
  if (block.kind !== 'valid') return undefined;
  const { values } = block.data;
  return isMissing(values['name']) && isMissing(values['description']) ? undefined : offset;
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
      const frontmatter = context.frontmatter(artifact);
      switch (frontmatter.kind) {
        case 'absent': {
          const offset = misplacedFrontmatter(artifact.decoded.text);
          if (offset !== undefined) {
            context.report({
              artifact,
              span: { offset, length: 3 },
              message:
                'The frontmatter does not start on line 1, so Claude Code treats this file as documentation and does not load the subagent. Remove the lines before "---".',
            });
          }
          break;
        }
        case 'unclosed':
          context.report({
            artifact,
            span: frontmatter.openSpan,
            message:
              'The frontmatter has no closing "---" line, so Claude Code cannot read its name or description and does not load this subagent.',
          });
          break;
        case 'unsupported':
          context.report({
            artifact,
            span: frontmatter.span,
            message:
              'The frontmatter is not YAML between "---" lines. Claude Code reads only YAML frontmatter, so it treats this file as documentation and does not load the subagent.',
          });
          break;
        case 'invalid': {
          const error = yamlSyntaxError(frontmatter.errors, { tolerateCommonMistakes: true });
          if (error === undefined) break;
          context.report({
            artifact,
            span: error.span,
            message:
              error.code === 'not-a-mapping'
                ? 'The frontmatter is not a YAML mapping of "key: value" fields, so Claude Code finds no name and does not load this subagent.'
                : `The frontmatter is not valid YAML (${issueDetail(error)}), so Claude Code reads no fields from it and skips this subagent.`,
          });
          break;
        }
        case 'valid':
          checkFields(context, artifact, frontmatter.data);
          break;
      }
    }
  },
});

function checkFields(
  context: Pick<RuleContext<undefined>, 'report'>,
  artifact: Artifact,
  data: FrontmatterData,
): void {
  const { values } = data;
  const name = values['name'];
  if (isMissing(name)) {
    // Frontmatter with no subagent fields at all is documentation, which Claude Code allows.
    if (!data.keys.some((key) => AGENT_FIELDS.has(key))) return;
    const hasKey = Object.hasOwn(values, 'name');
    context.report({
      artifact,
      span: data.keySpan('name') ?? OPENING_DELIMITER,
      message: hasKey
        ? '"name" is empty, so Claude Code treats this file as documentation and does not load the subagent.'
        : 'The frontmatter has no "name", so Claude Code treats this file as documentation and does not load the subagent.',
    });
    return;
  }

  if (typeof name === 'string') {
    const span = data.valueSpan('name') ?? OPENING_DELIMITER;
    const length = codePointLength(name);
    if (name.startsWith('-')) {
      context.report({
        artifact,
        span,
        message: `Subagent name ${quote(name)} starts with "-", so Claude Code skips this file.`,
      });
    } else if (name.includes(':')) {
      context.report({
        artifact,
        span,
        message: `Subagent name ${quote(name)} contains ":", which Claude Code reserves for plugin subagents, so it skips this file.`,
      });
    } else if (length > MAX_NAME_LENGTH) {
      context.report({
        artifact,
        span,
        message: `The subagent name is ${formatInteger(length)} characters long, so Claude Code skips this file. The limit is ${formatInteger(MAX_NAME_LENGTH)} characters.`,
      });
    }
  }

  if (isMissing(values['description'])) {
    const hasKey = Object.hasOwn(values, 'description');
    context.report({
      artifact,
      span: (hasKey ? data.keySpan('description') : data.keySpan('name')) ?? OPENING_DELIMITER,
      message: hasKey
        ? '"description" is empty, so Claude Code skips this subagent.'
        : 'The frontmatter has no "description", so Claude Code skips this subagent.',
    });
  }
}
