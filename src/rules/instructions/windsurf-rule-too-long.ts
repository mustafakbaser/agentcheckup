import { RULESET_VERSION } from '../../core/meta.js';
import { lineText, positionAt } from '../../core/text.js';
import {
  WINDSURF_WORKSPACE_RULE_MAX_CHARS,
  windsurfRuleLength,
} from '../../platforms/windsurf-rules.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger } from '../shared/format.js';
import { INSTRUCTION_SOURCES } from './sources.js';

export const windsurfRuleTooLongRule = defineRule({
  meta: {
    id: 'instr/windsurf-rule-too-long',
    title: "Windsurf rule file exceeds Cascade's 12,000-character limit",
    rationale: [
      'Cascade, the older agent in Windsurf (now Devin Desktop), limits each workspace rule file in `.devin/rules/` or `.windsurf/rules/` to 12,000 characters; agentcheckup applies the same limit to the legacy `.windsurfrules`. The documentation does not say whether a longer file is cut off or rejected, and the default Devin Local agent documents no limit, so this is information only.',
      'agentcheckup counts Unicode characters after the frontmatter, with a CRLF line break as one character, so it reports only files that are over the limit however you count.',
      'Split the rule into several rule files with their own activation modes, or move reference material into files the rule points to.',
    ].join('\n\n'),
    category: 'budget',
    severity: 'info',
    appliesTo: ['windsurf-rule', 'windsurf-legacy-rules'],
    platforms: ['windsurf'],
    sources: [SOURCES.windsurfRules, INSTRUCTION_SOURCES.windsurfOverLimitUndocumented],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const { text } = artifact.decoded;
      const frontmatter = context.frontmatter(artifact);
      const start =
        frontmatter.kind === 'valid' || frontmatter.kind === 'invalid' ? frontmatter.bodyOffset : 0;

      const { chars: count, overflow } = windsurfRuleLength(
        text,
        start,
        WINDSURF_WORKSPACE_RULE_MAX_CHARS,
      );
      if (overflow === -1) continue;

      const { line } = positionAt(artifact.decoded, overflow);
      const lineStart = artifact.decoded.lineStarts[line - 1] ?? 0;
      const lineEnd = lineStart + lineText(artifact.decoded, line).length;
      context.report({
        artifact,
        span: { offset: overflow, length: Math.max(0, lineEnd - overflow) },
        message: `This rule has ${formatInteger(count)} characters. Windsurf's Cascade agent limits each workspace rule file to ${formatInteger(WINDSURF_WORKSPACE_RULE_MAX_CHARS)} characters, and the text from line ${formatInteger(line)} on is past that limit.`,
        guidance:
          'split the rule into several rule files with their own activation modes, or move reference material into files the rule points to',
      });
    }
  },
});
