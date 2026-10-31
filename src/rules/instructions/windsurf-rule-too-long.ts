import { RULESET_VERSION } from '../../core/meta.js';
import { lineText, positionAt } from '../../core/text.js';
import {
  WINDSURF_WORKSPACE_RULE_MAX_CHARS,
  windsurfRuleLength,
} from '../../platforms/windsurf-rules.js';
import { defineRule } from '../define.js';
import { formatInteger } from '../shared/format.js';
import { INSTRUCTION_SOURCES } from './sources.js';

export const windsurfRuleTooLongRule = defineRule({
  meta: {
    id: 'instr/windsurf-rule-too-long',
    title: "Rule file exceeds Cascade's 12,000-character limit in JetBrains",
    rationale: [
      "Cascade in the Windsurf JetBrains plugin limits each rules file to 12,000 characters. agentcheckup applies the same limit to the rule files of Devin Desktop (formerly Windsurf) in `.devin/rules/` and `.windsurf/rules/` and to the legacy `.windsurfrules`. The plugin's documentation does not say whether a longer file is cut off or rejected, and Devin Local, the default agent of Devin Desktop, documents no limit, so this is information only.",
      'agentcheckup counts Unicode characters after the frontmatter, with a CRLF line break as one character, so it reports only files that are over the limit however you count.',
      'Split the rule into several rule files with their own activation modes, or move reference material into files the rule points to.',
    ].join('\n\n'),
    category: 'budget',
    severity: 'info',
    appliesTo: ['windsurf-rule', 'windsurf-legacy-rules'],
    platforms: ['windsurf'],
    sources: [
      INSTRUCTION_SOURCES.cascadeJetbrainsRules,
      INSTRUCTION_SOURCES.windsurfOverLimitUndocumented,
    ],
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
        message: `This rule has ${formatInteger(count)} characters. Cascade in the Windsurf JetBrains plugin limits each rules file to ${formatInteger(WINDSURF_WORKSPACE_RULE_MAX_CHARS)} characters, and the text from line ${formatInteger(line)} on is past that limit.`,
        guidance:
          'split the rule into several rule files with their own activation modes, or move reference material into files the rule points to',
      });
    }
  },
});
