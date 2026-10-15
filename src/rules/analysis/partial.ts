import { RULESET_VERSION } from '../../core/meta.js';
import { PLATFORM_IDS, type ArtifactKind } from '../../core/types.js';
import { MARKDOWN_KINDS } from '../../platforms/kinds.js';
import { defineRule } from '../define.js';
import { formatInteger } from '../shared/format.js';

const SOURCE = {
  title: 'ADR 0003: Treat scanned repositories as hostile',
  url: 'https://github.com/mustafakbaser/agentcheckup/blob/main/docs/adr/0003-treat-scanned-repositories-as-hostile.md',
  checked: '2026-10-14',
  status: 'verified',
} as const;

export const partialRule = defineRule({
  meta: {
    id: 'analysis/partial',
    title: 'File was only partly analyzed',
    rationale: [
      'agentcheckup limits the time and memory it spends on each file, because the Markdown parser it uses can take tens of seconds on a small crafted file. It analyzes at most the first 131,072 characters and 8,192 lines of a file, and fewer when the scan-wide budget runs low. Past a cost estimate it also skips list, block quote and setext heading structure, simplifies deeply nested lines, and ignores inline formatting in the most expensive paragraphs.',
      'Rules do not check the skipped parts, so findings there can be missing. This notice never affects the score.',
      'An instruction file this large is costly for agents too: Codex reads at most 32 KiB of `AGENTS.md` files, and Claude Code recommends `CLAUDE.md` files under 200 lines. Split the file or move reference material out of it.',
    ].join('\n\n'),
    category: 'clarity',
    severity: 'info',
    appliesTo: [...MARKDOWN_KINDS] as ArtifactKind[],
    platforms: PLATFORM_IDS,
    sources: [SOURCE],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const { analysis } = context.markdown(artifact);
      if (analysis.complete) continue;
      const parts: string[] = [];
      if (analysis.analyzedLength < artifact.decoded.text.length) {
        parts.push(
          `only the first ${formatInteger(analysis.analyzedLength)} of ${formatInteger(artifact.decoded.text.length)} characters were analyzed`,
        );
      }
      if (analysis.flat) parts.push('lists, block quotes and setext headings were not parsed');
      if (analysis.defusedParagraphs > 0) {
        parts.push(
          `inline formatting in ${formatInteger(analysis.defusedParagraphs)} paragraph${analysis.defusedParagraphs === 1 ? ' was' : 's were'} ignored`,
        );
      }
      if (analysis.cappedLines > 0) {
        parts.push(
          `deeply nested or indented structure on ${formatInteger(analysis.cappedLines)} line${analysis.cappedLines === 1 ? ' was' : 's were'} simplified`,
        );
      }
      if (parts.length === 0) parts.push('some constructs were simplified');
      context.report({
        artifact,
        message: `To bound parsing time, ${parts.join(', ')}. Rules did not check the skipped parts.`,
      });
    }
  },
});
