import { RULESET_VERSION } from '../../core/meta.js';
import { lineCount } from '../../core/measure.js';
import { lineText } from '../../core/text.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger } from '../shared/format.js';

export interface ClaudeMdTooLongOptions {
  readonly maxLines: number;
}

const DOCUMENTED_MAX_LINES = 200;

function maxLinesOption(options: ClaudeMdTooLongOptions): number {
  const value: unknown = options.maxLines;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Option "maxLines" must be a positive integer, got ${JSON.stringify(value)}.`);
  }
  return value;
}

export const claudeMdTooLongRule = defineRule<ClaudeMdTooLongOptions>({
  meta: {
    id: 'instr/claude-md-too-long',
    title: 'CLAUDE.md is longer than 200 lines',
    rationale: [
      'Claude Code loads every `CLAUDE.md` and `CLAUDE.local.md` in the working directory and above it at the start of each session. Its documentation recommends under 200 lines per file, because longer files consume more context and reduce adherence, and Claude Code warns at startup about a longer file. A file that loads at launch still loads in full (up to 4 MiB), so this is information only.',
      'A `CLAUDE.md` in a subdirectory loads on demand, when Claude works with a file there. Since v2.1.309 Claude Code gives Claude only the start of such a file and of the files it imports: 40,000 characters in a 200K context window, 150,000 or more in a 1M one. `agentcheckup context` shows where the cut falls.',
      'Moving text into `@path` imports does not help: imported files load at launch too. Move instructions that matter for only part of the codebase into path-scoped rules in `.claude/rules/`, which load when Claude works with matching files, or into skills, which load on demand. The `maxLines` option changes the limit.',
    ].join('\n\n'),
    category: 'budget',
    severity: 'info',
    appliesTo: ['claude-md', 'claude-local-md'],
    platforms: ['claude-code'],
    sources: [SOURCES.claudeMemory],
    since: RULESET_VERSION,
  },
  defaultOptions: { maxLines: DOCUMENTED_MAX_LINES },
  check(context) {
    const maxLines = maxLinesOption(context.options);
    for (const artifact of context.artifacts) {
      // A case variant such as docs/claude.md may be a document about Claude, not a CLAUDE.md;
      // instr/filename-case reports it.
      if (artifact.caseMismatch !== undefined) continue;
      const lines = lineCount(artifact.decoded.text);
      if (lines <= maxLines) continue;
      const firstExtraLine = maxLines + 1;
      const offset = artifact.decoded.lineStarts[maxLines] ?? 0;
      const message =
        maxLines === DOCUMENTED_MAX_LINES
          ? `This file has ${formatInteger(lines)} lines. Claude Code's documentation recommends keeping each CLAUDE.md under 200 lines, because longer files use more context and reduce adherence.`
          : `This file has ${formatInteger(lines)} lines, over the configured limit of ${formatInteger(maxLines)}. Longer CLAUDE.md files use more context and reduce adherence.`;
      context.report({
        artifact,
        message,
        span: { offset, length: lineText(artifact.decoded, firstExtraLine).length },
        guidance:
          'move instructions that matter for only part of the codebase into path-scoped rules in .claude/rules/ or into skills; @path imports do not help, because imported files load at launch too',
      });
    }
  },
});
