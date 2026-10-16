import { estimateTokens, lineCount } from '../../core/measure.js';
import { RULESET_VERSION } from '../../core/meta.js';
import { lineText, positionAt } from '../../core/text.js';
import type { Artifact, Span } from '../../core/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger } from '../shared/format.js';
import {
  bodyOffset,
  impactsOn,
  loadableSkills,
  reached,
  resolveImpacts,
  SKILL_PLATFORMS,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

export interface BodyTooLongOptions {
  /** Body lines above which the rule warns. */
  readonly maxLines: number;
}

const DEFAULT_MAX_LINES = 500;
/** Tokens of a skill that Claude Code keeps after compaction; also the spec's body budget. */
const TOKEN_BUDGET = 5000;
/** `estimateTokens` assumes four characters per token. */
const CHARACTERS_PER_TOKEN = 4;

/** Options come from user JSON: anything but a positive integer falls back to the default. */
function maxLinesOption(options: BodyTooLongOptions | undefined): number {
  const value: unknown = options?.maxLines;
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_LINES;
}

/** Span of the line that contains `offset`. */
function lineSpanAt(artifact: Artifact, offset: number): Span {
  const { line } = positionAt(artifact.decoded, offset);
  return {
    offset: artifact.decoded.lineStarts[line - 1] ?? 0,
    length: lineText(artifact.decoded, line).length,
  };
}

/** UTF-16 offset in `text` after `count` code points, or undefined when the text is shorter. */
function offsetAfterCodePoints(text: string, count: number): number | undefined {
  let seen = 0;
  let offset = 0;
  for (const char of text) {
    if (seen === count) return offset;
    seen++;
    offset += char.length;
  }
  return undefined;
}

const MOVE_REFERENCE =
  'move reference sections into files next to SKILL.md and link to them from the body';

export const bodyTooLongRule = defineRule<BodyTooLongOptions>({
  meta: {
    id: 'skill/body-too-long',
    title: 'Skill body is longer than recommended',
    rationale: `Agents load the whole SKILL.md body when a skill runs. In Claude Code the body then stays in the conversation on later turns, so every line is a recurring token cost, and after compaction Claude Code re-attaches only the first 5,000 tokens of each invoked skill.

Claude Code and the Agent Skills specification recommend keeping SKILL.md under 500 lines, and the specification recommends a body under 5,000 tokens. Both are recommendations, so findings are advice and do not affect the score. Tokens are estimated at four characters per token. Set \`maxLines\` to change the line limit.

Move reference material into separate files next to SKILL.md and link to them.`,
    category: 'budget',
    severity: 'info',
    appliesTo: ['skill'],
    platforms: SKILL_PLATFORMS,
    sources: [
      SOURCES.claudeSkills,
      SOURCES.agentSkillsSpec,
      SOURCES.claudeApiSkills,
      SKILL_SOURCES.claudeSkillBestPractices,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: { maxLines: DEFAULT_MAX_LINES },
  check(context) {
    const maxLines = maxLinesOption(context.options);
    for (const artifact of loadableSkills(context)) {
      const start = bodyOffset(context.frontmatter(artifact));
      const body = artifact.decoded.text.slice(start);
      const lines = lineCount(body);
      if (lines > maxLines) {
        const resolved = resolveImpacts(context, artifact, impactsOn(SKILL_PLATFORMS, 'info'));
        if (resolved !== undefined) {
          const firstOver = positionAt(artifact.decoded, start).line + maxLines;
          const maximum =
            maxLines === DEFAULT_MAX_LINES
              ? `the ${formatInteger(maxLines)} that Claude Code and the Agent Skills specification recommend`
              : `the configured maximum of ${formatInteger(maxLines)}`;
          context.report({
            artifact,
            message: `The skill body is ${formatInteger(lines)} lines, over ${maximum}. Agents load the whole body when the skill runs, so move reference material into separate files.`,
            severity: resolved.severity,
            platforms: resolved.platforms,
            span: lineSpanAt(artifact, artifact.decoded.lineStarts[firstOver - 1] ?? start),
            guidance: MOVE_REFERENCE,
          });
        }
      }

      const tokens = estimateTokens(body);
      if (tokens <= TOKEN_BUDGET) continue;
      const resolved = resolveImpacts(context, artifact, impactsOn(SKILL_PLATFORMS, 'info'));
      if (resolved === undefined) continue;
      const cut = offsetAfterCodePoints(body, TOKEN_BUDGET * CHARACTERS_PER_TOKEN) ?? body.length;
      const budget = formatInteger(TOKEN_BUDGET);
      const claude = reached(context, artifact, ['claude-code']).length > 0;
      context.report({
        artifact,
        message: `The skill body is about ${formatInteger(tokens)} tokens (estimated), over the ${budget} that the Agent Skills specification recommends. ${
          claude
            ? `After compaction, Claude Code keeps only the first ${budget} tokens, which end at about this line.`
            : 'Move reference material into separate files.'
        }`,
        severity: resolved.severity,
        platforms: resolved.platforms,
        span: lineSpanAt(artifact, start + cut),
        guidance: MOVE_REFERENCE,
      });
    }
  },
});
