import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact } from '../../core/types.js';
import type { ImportDialect, ImportReference } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger, quote, quotePath } from '../shared/format.js';
import {
  DIALECT_AGENT,
  DIALECT_PLATFORM,
  type ImportEdge,
  ImportGraph,
  importRoots,
  importsUncertainty,
  inHtmlComment,
  MAX_HOPS,
  targetedDialects,
  tooDeepImports,
  uncertaintyNote,
} from './import-graph.js';
import { INSTRUCTION_SOURCES } from './sources.js';

/** Paths shown in a cycle message; longer cycles are elided in the middle. */
const MAX_CYCLE_ENTRIES = 6;

interface Cycle {
  readonly file: Artifact;
  readonly reference: ImportReference;
  readonly members: readonly Artifact[];
}

interface Frame {
  readonly artifact: Artifact;
  readonly edges: readonly ImportEdge[];
  next: number;
}

/** Import cycles reachable from `roots`, found by an iterative depth-first search. */
function findCycles(
  graph: ImportGraph,
  roots: readonly Artifact[],
  dialect: ImportDialect,
): Cycle[] {
  const done = new Set<Artifact>();
  const onStack = new Set<Artifact>();
  const cycles: Cycle[] = [];
  for (const root of roots) {
    if (done.has(root)) continue;
    const stack: Frame[] = [];
    const enter = (artifact: Artifact): boolean => {
      const edges = graph.edges(artifact, dialect);
      if (!graph.spend(edges.length)) return false;
      onStack.add(artifact);
      stack.push({ artifact, edges, next: 0 });
      return true;
    };
    if (!enter(root)) return cycles;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      const edge = frame.edges[frame.next];
      if (edge === undefined) {
        onStack.delete(frame.artifact);
        done.add(frame.artifact);
        stack.pop();
        continue;
      }
      frame.next++;
      if (edge.target === undefined) continue;
      if (dialect === 'claude' && inHtmlComment(graph.markdown(frame.artifact), edge.reference)) {
        continue;
      }
      const next = graph.index.get(edge.target);
      if (next === undefined || done.has(next)) continue;
      if (onStack.has(next)) {
        const start = stack.findIndex((entry) => entry.artifact === next);
        cycles.push({
          file: frame.artifact,
          reference: edge.reference,
          members: [...stack.slice(start).map((entry) => entry.artifact), next],
        });
        continue;
      }
      if (!enter(next)) return cycles;
    }
  }
  return cycles;
}

function cycleText(members: readonly Artifact[]): string {
  const paths = members.map((member) => quote(member.path, 40).slice(1, -1));
  if (paths.length <= MAX_CYCLE_ENTRIES) return paths.join(' → ');
  return [...paths.slice(0, 3), '…', ...paths.slice(-2)].join(' → ');
}

export const importDepthRule = defineRule({
  meta: {
    id: 'instr/import-depth',
    title: 'Import is nested deeper than the agent follows',
    rationale: [
      'Imported files can import other files, up to a fixed depth: Claude Code follows imports at most four hops from the file it loads, Gemini CLI five. A deeper import is not followed, so the file it names is not loaded.',
      "agentcheckup follows imports only through files it read, such as `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `.claude/rules/` files, and does not report a chain that passes through a file it did not read. A chain that starts at a `.claude/rules/` file is information, because Claude Code's documentation does not say it expands imports there. So is a chain that starts at a symlink such as `.claude/CLAUDE.md -> ../AGENTS.md` in another directory than its target: agentcheckup resolves its imports from the link's directory, which Claude Code's documentation does not confirm. It also reports import cycles as information: the import that closes a cycle names a file that is already loaded, so it adds no new instructions. Gemini CLI documents that it detects cycles; Claude Code does not document how it handles them.",
      'Import deeply nested files directly from the top-level file.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: ['claude-md', 'claude-local-md', 'claude-rule', 'agents-md', 'gemini-md'],
    platforms: ['claude-code', 'gemini'],
    sources: [
      SOURCES.claudeMemory,
      SOURCES.geminiImports,
      INSTRUCTION_SOURCES.geminiImportSource,
      INSTRUCTION_SOURCES.claudeRuleImportsUndocumented,
      INSTRUCTION_SOURCES.claudeSymlinkImportsUndocumented,
      INSTRUCTION_SOURCES.geminiImportBaseSource,
      INSTRUCTION_SOURCES.claudeImportCyclesUndocumented,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    const graph = new ImportGraph(context);
    const reported = new Set<string>();
    const once = (file: Artifact, reference: ImportReference): boolean => {
      const key = `${file.path}\u0000${String(reference.span.offset)}`;
      if (reported.has(key)) return false;
      reported.add(key);
      return true;
    };

    for (const dialect of targetedDialects(context)) {
      const maxHops = MAX_HOPS[dialect];
      const platforms = [DIALECT_PLATFORM[dialect]];
      const roots = importRoots(graph, dialect);

      for (const { root, file, reference, target } of tooDeepImports(graph, roots, dialect)) {
        if (!once(file, reference)) continue;
        const uncertainty = importsUncertainty(graph, root, dialect);
        // The path the agent loads the root by: `CLAUDE.md` for `CLAUDE.md -> AGENTS.md`.
        const from = graph.rootPath(root, dialect) ?? root.path;
        const message = `This import is ${formatInteger(maxHops + 1)} hops from ${quotePath(from)}. ${DIALECT_AGENT[dialect]} follows imports at most ${formatInteger(maxHops)} hops deep, so ${quotePath(target)} is not loaded.`;
        context.report({
          artifact: file,
          span: reference.span,
          platforms,
          guidance: `import ${quotePath(target)} directly from ${quotePath(from)}, or from a file fewer hops away`,
          ...(uncertainty === undefined
            ? { message }
            : {
                severity: 'info' as const,
                message: `${message} ${uncertaintyNote(uncertainty)}`,
              }),
        });
      }

      // Only cycles closed by an import the agent processes, in a file within its hop limit.
      const processed = graph.reach(roots, dialect, maxHops);
      for (const cycle of findCycles(graph, roots, dialect)) {
        const hop = processed.hops.get(cycle.file);
        if (hop === undefined || hop >= maxHops) continue;
        if (!once(cycle.file, cycle.reference)) continue;
        context.report({
          artifact: cycle.file,
          span: cycle.reference.span,
          platforms,
          severity: 'info',
          message: `This import closes a cycle: ${cycleText(cycle.members)}. The imported file is already loaded earlier in the chain, so the import adds no new instructions.`,
          guidance:
            'remove this import, unless an agent also loads this file by itself and needs the file it imports',
        });
      }
    }
  },
});
