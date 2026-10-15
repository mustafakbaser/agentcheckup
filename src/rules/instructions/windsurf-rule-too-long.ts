import { RULESET_VERSION } from '../../core/meta.js';
import { lineText, positionAt } from '../../core/text.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger } from '../shared/format.js';
import { INSTRUCTION_SOURCES } from './sources.js';

const MAX_CHARACTERS = 12_000;

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

      let count = 0;
      let overflow = -1;
      for (let i = start; i < text.length; i++) {
        const code = text.charCodeAt(i);
        // The second half of a surrogate pair and the CR of a CRLF pair are not counted.
        if (code >= 0xdc00 && code <= 0xdfff && i > start) {
          const previous = text.charCodeAt(i - 1);
          if (previous >= 0xd800 && previous <= 0xdbff) continue;
        }
        if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) continue;
        count++;
        if (count === MAX_CHARACTERS + 1) overflow = i;
      }
      if (overflow === -1) continue;

      const { line } = positionAt(artifact.decoded, overflow);
      const lineStart = artifact.decoded.lineStarts[line - 1] ?? 0;
      const lineEnd = lineStart + lineText(artifact.decoded, line).length;
      context.report({
        artifact,
        span: { offset: overflow, length: Math.max(0, lineEnd - overflow) },
        message: `This rule has ${formatInteger(count)} characters. Windsurf's Cascade agent limits each workspace rule file to 12,000 characters, and the text from line ${formatInteger(line)} on is past that limit.`,
      });
    }
  },
});
