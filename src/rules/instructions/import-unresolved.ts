import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix, joinRelative, pathStatus } from '../../core/paths.js';
import type { Artifact, Span } from '../../core/types.js';
import type { ImportDialect } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { quote, quotePath } from '../shared/format.js';
import { FindingLimiter } from './helpers.js';
import {
  DIALECT_PLATFORM,
  filesWithFollowedImports,
  ImportGraph,
  inHtmlComment,
  looksLikeFilePath,
  targetedDialects,
  withoutTrailingPunctuation,
} from './import-graph.js';
import { INSTRUCTION_SOURCES } from './sources.js';

interface Unresolved {
  readonly artifact: Artifact;
  readonly span: Span;
  /** The path as shown in the message. */
  readonly path: string;
  readonly dialects: Set<ImportDialect>;
  /** Gemini only: the existing file the path names without its trailing punctuation. */
  readonly withoutPunctuation?: string;
  /** Claude Code reaches this file only through a project rule, whose imports are undocumented. */
  readonly ruleOnly: boolean;
}

function message(found: Unresolved): string {
  if (found.withoutPunctuation !== undefined) {
    const extra = found.path.slice(found.withoutPunctuation.length);
    return `Gemini CLI reads this import as ${quotePath(found.path)}, including the trailing ${quote(extra)}. No such file exists, so Gemini CLI replaces the reference with an "Import failed" comment.`;
  }
  const claude = found.dialects.has('claude');
  const gemini = found.dialects.has('gemini');
  if (claude && gemini) {
    return `Imported file ${quotePath(found.path)} does not exist. Claude Code cannot load it, and Gemini CLI replaces the reference with an "Import failed" comment.`;
  }
  if (claude && found.ruleOnly) {
    return `Imported file ${quotePath(found.path)} does not exist. If Claude Code expands imports in project rules, which its documentation does not say, it cannot load it.`;
  }
  if (claude)
    return `Imported file ${quotePath(found.path)} does not exist, so Claude Code cannot load it.`;
  return `Imported file ${quotePath(found.path)} does not exist. Gemini CLI replaces the reference with an "Import failed" comment.`;
}

export const importUnresolvedRule = defineRule({
  meta: {
    id: 'instr/import-unresolved',
    title: 'Imported file does not exist',
    rationale: [
      'Claude Code and Gemini CLI replace an `@path` import with the content of the file it names, resolved relative to the importing file. When that file does not exist, Claude Code has nothing to load, and Gemini CLI inserts an "Import failed" comment instead of the text.',
      "Claude Code expands imports in `CLAUDE.md`, `CLAUDE.local.md` and any `AGENTS.md` it reads; agentcheckup also checks `.claude/rules/` files, although Claude Code's documentation does not mention imports there, and reports what it finds there as information. Gemini CLI expands imports in `GEMINI.md`. To skip mentions such as `@octocat`, agentcheckup reports only paths that start with `./` or `../` or end in a file extension (for Gemini CLI also dotfiles and `@README`). Gemini CLI keeps trailing punctuation, so `@./guide.md.` fails even when `guide.md` exists. Paths in directories agentcheckup did not list, such as `node_modules`, are never reported.",
      'Fix the path, or put a mention you do not want imported in backticks.',
    ].join('\n\n'),
    category: 'correctness',
    severity: 'error',
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
    const { snapshot } = context;
    const found = new Map<string, Unresolved>();

    for (const dialect of targetedDialects(context)) {
      for (const { artifact, documented } of filesWithFollowedImports(graph, dialect)) {
        const doc = graph.markdown(artifact);
        const directory = dirnamePosix(artifact.path);
        for (const { reference, target } of graph.edges(artifact, dialect)) {
          if (reference.kind !== 'relative' || target === undefined) continue;
          if (dialect === 'claude' && inHtmlComment(doc, reference)) continue;
          const trimmed = withoutTrailingPunctuation(reference.path);
          if (dialect === 'claude' && !looksLikeFilePath(trimmed)) continue;
          if (pathStatus(snapshot, target) !== 'missing') continue;

          let path = reference.path;
          let withoutPunctuation: string | undefined;
          if (trimmed !== reference.path && trimmed !== '') {
            const trimmedTarget = joinRelative(directory, trimmed);
            if (trimmedTarget !== undefined && pathStatus(snapshot, trimmedTarget) !== 'missing') {
              // Whether Claude Code keeps trailing punctuation in an import path is not
              // documented; Gemini CLI's parser keeps it (it reads up to the next whitespace).
              if (dialect === 'claude') continue;
              withoutPunctuation = trimmed;
            } else if (dialect === 'claude') {
              path = trimmed;
            }
          }

          const key = `${artifact.path}\u0000${String(reference.span.offset)}`;
          const existing = found.get(key);
          if (existing !== undefined) {
            existing.dialects.add(dialect);
            continue;
          }
          found.set(key, {
            artifact,
            span: reference.span,
            path,
            dialects: new Set([dialect]),
            ruleOnly: dialect === 'claude' && !documented,
            ...(withoutPunctuation === undefined ? {} : { withoutPunctuation }),
          });
        }
      }
    }

    const limiter = new FindingLimiter();
    for (const unresolved of found.values()) {
      if (!limiter.allow(unresolved.artifact.path)) continue;
      const onlyUndocumented = unresolved.ruleOnly && !unresolved.dialects.has('gemini');
      context.report({
        artifact: unresolved.artifact,
        span: unresolved.span,
        ...(onlyUndocumented ? { severity: 'info' as const } : {}),
        platforms: [...unresolved.dialects].map((dialect) => DIALECT_PLATFORM[dialect]),
        message: message(unresolved),
      });
    }
  },
});
