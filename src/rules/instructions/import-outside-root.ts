import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix } from '../../core/paths.js';
import type { Artifact, ReportDescriptor } from '../../core/types.js';
import type { ImportDialect } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { quotePath } from '../shared/format.js';
import { FindingLimiter, nearestGitRoot } from './helpers.js';
import {
  claudeImportOutsideRoot,
  DIALECT_PLATFORM,
  filesWithFollowedImports,
  type ImportEdge,
  ImportGraph,
  inHtmlComment,
  scanRootIsRepository,
  targetedDialects,
} from './import-graph.js';
import { INSTRUCTION_SOURCES } from './sources.js';

export { isFileSystemPath } from '../../platforms/load/imports.js';

function within(path: string, root: string): boolean {
  return root === '' || path === root || path.startsWith(`${root}/`);
}

function describe(
  graph: ImportGraph,
  artifact: Artifact,
  edge: ImportEdge,
  dialect: ImportDialect,
  repository: boolean,
): Pick<ReportDescriptor, 'message' | 'severity'> | undefined {
  const { reference, target } = edge;
  const written = `@${reference.raw}`;
  if (dialect === 'claude') {
    switch (claudeImportOutsideRoot(edge, repository)) {
      case undefined:
        return undefined;
      case 'home':
        return {
          severity: 'info',
          message: `Import ${quotePath(written)} loads a file from each user's home directory, so teammates and CI runners without that file get nothing from it. Claude Code also asks for approval before it loads files outside the working directory.`,
        };
      case 'absolute':
        return {
          message: `Import ${quotePath(written)} uses an absolute path, which exists only on machines with the same directory layout. Claude Code also asks for approval before it loads files outside the working directory.`,
        };
      case 'relative':
        return {
          message: `Import ${quotePath(written)} resolves outside the repository, so other clones and CI runners do not have that file. Claude Code also asks for approval before it loads files outside the working directory.`,
        };
    }
  }
  switch (reference.kind) {
    case 'home':
      return undefined;
    case 'absolute':
      return {
        message: `Import ${quotePath(written)} uses an absolute path, which does not exist on other machines. Gemini CLI also rejects imports outside the project root and inserts an "Import failed" comment instead.`,
      };
    case 'relative': {
      const projectRoot = nearestGitRoot(graph.snapshot, dirnamePosix(artifact.path));
      if (projectRoot === undefined) return undefined;
      if (target !== undefined && within(target, projectRoot)) return undefined;
      return {
        severity: 'error',
        message: `Import ${quotePath(written)} resolves outside the project root, so Gemini CLI does not load it and inserts an "Import failed ... Path traversal attempt" comment instead.`,
      };
    }
  }
}

export const importOutsideRootRule = defineRule({
  meta: {
    id: 'instr/import-outside-root',
    title: 'Import points outside the repository',
    rationale: [
      'An `@path` import of an absolute path, a `~/` path or a relative path that leaves the repository names a file that other clones and CI runners do not have. Claude Code also asks for approval before it loads imports outside the working directory, and loads none of them if you decline. Gemini CLI never loads an import outside the project root (the nearest directory with `.git`) and inserts an "Import failed ... Path traversal attempt" comment instead; that case is an error.',
      "Claude Code's documentation suggests `~/` imports for personal instructions, so those are information only, and imports in `CLAUDE.local.md` are not reported. Relative imports are checked only when a `.git` entry shows where the repository ends: at the scanned directory for Claude Code, at or above the file for Gemini CLI. Imports reached only through `.claude/rules/` files are information, because Claude Code's documentation does not say it expands imports there.",
      'Copy shared instructions into the repository and import them with a relative path.',
    ].join('\n\n'),
    category: 'portability',
    severity: 'warn',
    appliesTo: ['claude-md', 'claude-local-md', 'claude-rule', 'agents-md', 'gemini-md'],
    platforms: ['claude-code', 'gemini'],
    sources: [
      SOURCES.claudeMemory,
      SOURCES.geminiImports,
      INSTRUCTION_SOURCES.geminiImportSource,
      INSTRUCTION_SOURCES.claudeRuleImportsUndocumented,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    const graph = new ImportGraph(context);
    const repository = scanRootIsRepository(context.snapshot);
    const limiter = new FindingLimiter();
    for (const dialect of targetedDialects(context)) {
      for (const { artifact, documented } of filesWithFollowedImports(graph, dialect)) {
        if (dialect === 'claude' && artifact.kind === 'claude-local-md') continue;
        const doc = graph.markdown(artifact);
        for (const edge of graph.edges(artifact, dialect)) {
          if (dialect === 'claude' && inHtmlComment(doc, edge.reference)) continue;
          const finding = describe(graph, artifact, edge, dialect, repository);
          if (finding === undefined || !limiter.allow(artifact.path)) continue;
          // Reached only through a project rule, whose import expansion is not documented.
          const ruleOnly = dialect === 'claude' && !documented;
          context.report({
            artifact,
            span: edge.reference.span,
            platforms: [DIALECT_PLATFORM[dialect]],
            ...finding,
            ...(ruleOnly
              ? {
                  severity: 'info' as const,
                  message: `${finding.message} Claude Code's documentation does not say it expands imports in project rules.`,
                }
              : {}),
          });
        }
      }
    }
  },
});
