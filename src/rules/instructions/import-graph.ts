/**
 * The import graph for the import rules. The graph itself lives in src/platforms/load/imports.ts,
 * shared with the loaders; this module adapts it to a rule context and adds the heuristics the
 * rules use to decide what to report.
 */
import type { RuleContext } from '../../core/types.js';
import type { ImportDialect } from '../../parse/types.js';
import {
  type ImportsUncertainty,
  ImportGraph as LoadImportGraph,
} from '../../platforms/load/imports.js';
import { artifactIndex } from '../../platforms/load/view.js';

export {
  agentsMdDirectory,
  CLAUDE_FILE_NAMES,
  claudeFilesOnPath,
  claudeImportOutsideRoot,
  DIALECT_PLATFORM,
  filesWithFollowedImports,
  geminiImportOutsideRoot,
  importRoots,
  importsPastLimit,
  inHtmlComment,
  importsUncertainty,
  isAgentsMdReadByClaude,
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
  ImportsUncertainty,
  ParsedFile,
  Reach,
  TooDeepImport,
  UnresolvedImport,
} from '../../platforms/load/imports.js';

export const DIALECT_AGENT: Readonly<Record<ImportDialect, string>> = {
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
};

/**
 * The sentence a finding that rests on undocumented import handling ends with; such findings
 * are information.
 */
export function uncertaintyNote(uncertainty: ImportsUncertainty): string {
  return uncertainty === 'project-rule'
    ? "Claude Code's documentation does not say it expands imports in project rules."
    : "Claude Code reads this through a symlink in another directory than the file it points to, and its documentation does not say whether imports then resolve from the link's directory, as agentcheckup assumes, or from the target's.";
}

/** Without `json`, only GEMINI.md files are Gemini CLI roots (see `ImportView`). */
export type GraphContext = Pick<
  RuleContext<unknown>,
  'markdown' | 'snapshot' | 'allArtifacts' | 'targets'
> &
  Partial<Pick<RuleContext<unknown>, 'json'>>;

/** The shared import graph, built from a rule context. */
export class ImportGraph extends LoadImportGraph {
  constructor(context: GraphContext, maxEdgeVisits?: number) {
    const json = context.json?.bind(context);
    super(
      {
        snapshot: context.snapshot,
        index: artifactIndex(context.allArtifacts),
        markdown: (artifact) => context.markdown(artifact),
        ...(json === undefined ? {} : { json }),
      },
      maxEdgeVisits,
    );
  }
}
