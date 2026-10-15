/**
 * The import graph for the import rules. The graph itself lives in src/platforms/load/imports.ts,
 * shared with the loaders; this module adapts it to a rule context and adds the heuristics the
 * rules use to decide what to report.
 */
import type { RuleContext } from '../../core/types.js';
import type { ImportDialect } from '../../parse/types.js';
import { ImportGraph as LoadImportGraph } from '../../platforms/load/imports.js';
import { artifactIndex } from '../../platforms/load/view.js';

export {
  agentsMdDirectory,
  CLAUDE_FILE_NAMES,
  claudeFilesOnPath,
  claudeImportOutsideRoot,
  DIALECT_PLATFORM,
  filesWithFollowedImports,
  importRoots,
  importsPastLimit,
  inHtmlComment,
  isAgentsMdReadByClaude,
  isUndocumentedRoot,
  looksLikeFilePath,
  MAX_HOPS,
  scanRootIsRepository,
  targetedDialects,
  tooDeepImports,
  unresolvedImport,
  withoutTrailingPunctuation,
} from '../../platforms/load/imports.js';
export type {
  ClaudeFileOnPath,
  ImportEdge,
  ParsedFile,
  Reach,
  TooDeepImport,
  UnresolvedImport,
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
