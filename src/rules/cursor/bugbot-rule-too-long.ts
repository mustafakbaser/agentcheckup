import { RULESET_VERSION } from '../../core/meta.js';
import { lineText, positionAt } from '../../core/text.js';
import { windsurfRuleLength } from '../../platforms/windsurf-rules.js';
import { defineRule } from '../define.js';
import { formatInteger } from '../shared/format.js';
import { SOURCES } from '../sources.js';

/**
 * "Each rule is truncated at 30,000 characters when included in a review" (SOURCES.cursorBugbot,
 * "Rule limits"). Agent Review reads the same files (SOURCES.cursorAgentReview).
 */
export const BUGBOT_RULE_MAX_CHARS = 30_000;

export const bugbotRuleTooLongRule = defineRule({
  meta: {
    id: 'cursor/bugbot-rule-too-long',
    title: "BUGBOT.md exceeds Bugbot's 30,000-character limit per rule",
    rationale: [
      "Bugbot, Cursor's pull request reviewer, and Agent Review read `.cursor/BUGBOT.md` files as review rules: the root file in every review, and a nested one when the review covers files below its directory. Bugbot truncates each rule at 30,000 characters when it includes it in a review, so the guidance past that point never reaches the reviewer. All rules of a review together are capped at 100,000 characters, and rules past that cap may be left out.",
      'agentcheckup counts Unicode characters, without the frontmatter and with a CRLF line break as one character, so it reports only files that are over the limit however Bugbot counts. Files a `BUGBOT.md` links to count as rules of their own and are not checked.',
      'Move parts of the file into `.md` files it links to, each with its own 30,000-character limit, or into a nested `.cursor/BUGBOT.md` for the directory the guidance is about.',
    ].join('\n\n'),
    category: 'budget',
    severity: 'warn',
    appliesTo: ['cursor-bugbot'],
    platforms: ['cursor'],
    sources: [SOURCES.cursorBugbot, SOURCES.cursorAgentReview],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const { text } = artifact.decoded;
      const frontmatter = context.frontmatter(artifact);
      const start =
        frontmatter.kind === 'valid' || frontmatter.kind === 'invalid' ? frontmatter.bodyOffset : 0;
      const { chars, overflow } = windsurfRuleLength(text, start, BUGBOT_RULE_MAX_CHARS);
      if (overflow === -1) continue;
      const { line } = positionAt(artifact.decoded, overflow);
      const lineStart = artifact.decoded.lineStarts[line - 1] ?? 0;
      const lineEnd = lineStart + lineText(artifact.decoded, line).length;
      context.report({
        artifact,
        span: { offset: overflow, length: Math.max(0, lineEnd - overflow) },
        message: `This Bugbot rule file has ${formatInteger(chars)} characters. Bugbot truncates each rule at ${formatInteger(BUGBOT_RULE_MAX_CHARS)} characters, so reviews do not see the text from line ${formatInteger(line)} on.`,
        guidance:
          'move parts of it into .md files it links to, or into a nested .cursor/BUGBOT.md for the directory they are about',
      });
    }
  },
});
