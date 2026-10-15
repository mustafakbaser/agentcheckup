/**
 * The import graph for the import rules. The graph itself lives in src/platforms/load/imports.ts,
 * shared with the loaders; this module adapts it to a rule context and adds the heuristics the
 * rules use to decide what to report.
 */
import type { RuleContext } from '../../core/types.js';
import type { ImportDialect } from '../../parse/types.js';
import { ImportGraph as LoadImportGraph } from '../../platforms/load/imports.js';
import { artifactIndex } from '../../platforms/load/view.js';
import { basename } from './helpers.js';

export {
  agentsMdDirectory,
  CLAUDE_FILE_NAMES,
  claudeFilesOnPath,
  DIALECT_PLATFORM,
  filesWithFollowedImports,
  importRoots,
  inHtmlComment,
  isAgentsMdReadByClaude,
  isUndocumentedRoot,
  MAX_HOPS,
  targetedDialects,
} from '../../platforms/load/imports.js';
export type {
  ClaudeFileOnPath,
  ImportEdge,
  ParsedFile,
  Reach,
} from '../../platforms/load/imports.js';

export const DIALECT_AGENT: Readonly<Record<ImportDialect, string>> = {
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
};

export type GraphContext = Pick<
  RuleContext<unknown>,
  'markdown' | 'snapshot' | 'allArtifacts' | 'targets'
>;

/** The shared import graph, built from a rule context. */
export class ImportGraph extends LoadImportGraph {
  constructor(context: GraphContext, maxEdgeVisits?: number) {
    super(
      {
        snapshot: context.snapshot,
        index: artifactIndex(context.allArtifacts),
        markdown: (artifact) => context.markdown(artifact),
      },
      maxEdgeVisits,
    );
  }
}

const TRAILING_PUNCTUATION = '.,;:!?)]}\'"';

/** `docs/guide.md.` -> `docs/guide.md`. */
export function withoutTrailingPunctuation(path: string): string {
  let end = path.length;
  while (end > 0 && TRAILING_PUNCTUATION.includes(path.charAt(end - 1))) end--;
  return path.slice(0, end);
}

/**
 * Whether a Claude Code import was meant as a file: it starts with `./` or `../`, or its last
 * segment has a file extension. Claude Code also parses mentions such as `@tanstack/react-query`
 * or `@octocat` as imports; those are not reported.
 */
export function looksLikeFilePath(path: string): boolean {
  if (path.includes(':')) return false;
  if (path.startsWith('./') || path.startsWith('../')) return true;
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  const extension = name.slice(dot + 1);
  if (extension.length > 10) return false;
  const first = extension.charCodeAt(0);
  const isLetter = (first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a);
  if (!isLetter) return false;
  for (let i = 1; i < extension.length; i++) {
    const code = extension.charCodeAt(i);
    const alnum =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a);
    if (!alnum) return false;
  }
  return true;
}
