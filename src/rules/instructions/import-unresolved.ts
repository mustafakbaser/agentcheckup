import { compareStrings } from '../../core/compare.js';
import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix, joinRelative } from '../../core/paths.js';
import type { Artifact, ReportDescriptor, Snapshot, Span } from '../../core/types.js';
import { replaceSpan } from '../../fix/edits.js';
import type { ImportDialect } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger, quote, quotePath } from '../shared/format.js';
import { byHand, editBlocker } from './fixes.js';
import { basename, FindingLimiter, relativePath } from './helpers.js';
import {
  DIALECT_PLATFORM,
  filesWithFollowedImports,
  ImportGraph,
  type ImportsUncertainty,
  inHtmlComment,
  targetedDialects,
  unresolvedImport,
} from './import-graph.js';
import { INSTRUCTION_SOURCES } from './sources.js';

const RULE_ID = 'instr/import-unresolved';

/**
 * Import paths a fix writes: characters both agents read as part of a path, no escapes, and no
 * `@` first, which Claude Code does not read as an import.
 */
const PLAIN_IMPORT_PATH = /^[\w.+-][\w.@+-]*(?:\/[\w.@+-]+)*$/;

/** Candidate files named in a manual step. */
const MAX_LISTED_CANDIDATES = 3;

interface Unresolved {
  readonly artifact: Artifact;
  readonly span: Span;
  /** The text after `@` as written. */
  readonly raw: string;
  /** The path as shown in the message. */
  readonly path: string;
  readonly dialects: Set<ImportDialect>;
  /** Gemini only: the existing file the path names without its trailing punctuation. */
  readonly withoutPunctuation?: string;
  /**
   * Why Claude Code's handling of this import is not documented: it reaches the file only
   * through a project rule, or through a symlink in another directory than its target.
   */
  readonly uncertainty: ImportsUncertainty | undefined;
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
  if (claude && found.uncertainty === 'project-rule') {
    return `Imported file ${quotePath(found.path)} does not exist. If Claude Code expands imports in project rules, which its documentation does not say, it cannot load it.`;
  }
  if (claude && found.uncertainty === 'link') {
    return `Imported file ${quotePath(found.path)} does not exist. Claude Code reads this through a symlink in another directory than the file it points to; if it resolves imports from the link's directory, which its documentation does not say, it cannot load it.`;
  }
  if (claude)
    return `Imported file ${quotePath(found.path)} does not exist, so Claude Code cannot load it.`;
  return `Imported file ${quotePath(found.path)} does not exist. Gemini CLI replaces the reference with an "Import failed" comment.`;
}

/** Files by name, built once per scan from every file path the walk listed. */
class FilesByName {
  readonly #snapshot: Snapshot;
  #index: Map<string, string[]> | undefined;

  constructor(snapshot: Snapshot) {
    this.#snapshot = snapshot;
  }

  /** Paths of the files named `name`, in code-point order. */
  named(name: string): readonly string[] {
    if (this.#index === undefined) {
      this.#index = new Map();
      for (const path of this.#snapshot.paths) {
        if (path.endsWith('/') || this.#snapshot.ignoredFiles.has(path)) continue;
        const key = basename(path);
        const list = this.#index.get(key);
        if (list === undefined) this.#index.set(key, [path]);
        else list.push(path);
      }
      for (const list of this.#index.values()) list.sort(compareStrings);
    }
    return this.#index.get(name) ?? [];
  }
}

/** The import path for `target` from `importer`, in the style of the path it replaces. */
function importPathTo(
  importer: Artifact,
  target: string,
  written: string,
  dialects: Set<ImportDialect>,
): string {
  const relative = relativePath(dirnamePosix(importer.path), target);
  if (relative.startsWith('../')) return relative;
  // Keep a leading "./" the author wrote; Gemini CLI also needs one before a name that does not
  // start with a letter.
  const first = relative.charCodeAt(0);
  const letter = (first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a);
  return written.startsWith('./') || (dialects.has('gemini') && !letter)
    ? `./${relative}`
    : relative;
}

/**
 * Points the import at the only file in the repository with the name it asks for. Anything else
 * (no such file, several, a path the agents would read differently) is a manual step.
 */
function repoint(
  graph: ImportGraph,
  files: FilesByName,
  found: Unresolved,
): Pick<ReportDescriptor, 'fix' | 'guidance'> {
  const { artifact } = found;
  if (found.withoutPunctuation !== undefined) {
    const extra = found.path.slice(found.withoutPunctuation.length);
    return { guidance: `end the path before ${quote(extra)}, for example with a space` };
  }
  const name = basename(found.path);
  const missing = joinRelative(dirnamePosix(artifact.path), found.path) ?? found.path;
  const candidates =
    name === '' || name === '.' || name === '..'
      ? []
      : files.named(name).filter((path) => path !== artifact.path);
  if (candidates.length === 0) {
    return {
      guidance: `create ${quotePath(missing)} or correct the path; no file named ${quote(name)} exists`,
    };
  }
  const [only] = candidates;
  if (candidates.length > 1 || only === undefined) {
    const listed = candidates.slice(0, MAX_LISTED_CANDIDATES).map(quotePath).join(', ');
    const more =
      candidates.length > MAX_LISTED_CANDIDATES
        ? ` and ${formatInteger(candidates.length - MAX_LISTED_CANDIDATES)} more`
        : '';
    return { guidance: `correct the path; files named ${quote(name)}: ${listed}${more}` };
  }
  const action = `point the import at ${quotePath(only)}`;
  // Only the path as written changes, so it must be written without escapes; trailing sentence
  // punctuation that Claude Code drops stays after it.
  if (found.uncertainty === 'link' || !found.raw.startsWith(found.path)) {
    return { guidance: action };
  }
  const resolvesFromOwnDirectory = [...found.dialects].every((dialect) => {
    const from = graph.rootPath(artifact, dialect) ?? artifact.path;
    return dirnamePosix(from) === dirnamePosix(artifact.path);
  });
  const blocker = editBlocker(artifact);
  if (blocker !== undefined) return { guidance: byHand(action, blocker) };
  const path = importPathTo(artifact, only, found.raw, found.dialects);
  if (!resolvesFromOwnDirectory || !PLAIN_IMPORT_PATH.test(path)) return { guidance: action };
  return {
    fix: {
      id: `${RULE_ID}#repoint`,
      class: 'review',
      title: `Change the import "@${found.path}" in ${artifact.path} to "@${path}"`,
      changes: [
        replaceSpan(artifact, { offset: found.span.offset + 1, length: found.path.length }, path),
      ],
      notes: [
        `${only} is the only file named ${name} that agentcheckup found; check that it is the file you meant.`,
      ],
    },
  };
}

export const importUnresolvedRule = defineRule({
  meta: {
    id: RULE_ID,
    title: 'Imported file does not exist',
    rationale: [
      'Claude Code and Gemini CLI replace an `@path` import with the content of the file it names, resolved relative to the importing file. When that file does not exist, Claude Code has nothing to load, and Gemini CLI inserts an "Import failed" comment instead of the text.',
      "Claude Code expands imports in `CLAUDE.md`, `CLAUDE.local.md` and any `AGENTS.md` it reads; agentcheckup also checks `.claude/rules/` files, although Claude Code's documentation does not mention imports there, and reports what it finds there as information. Gemini CLI expands imports in `GEMINI.md`. A file that a `CLAUDE.md` or `GEMINI.md` symlink points to is checked as that file, with imports resolved from the link's directory, as Gemini CLI does. Where the link sits in another directory than its target, Claude Code's documentation does not say which directory it uses, so findings that depend on it are information. To skip mentions such as `@octocat`, agentcheckup reports only paths that start with `./` or `../` or end in a file extension (for Gemini CLI also dotfiles and `@README`). Gemini CLI keeps trailing punctuation, so `@./guide.md.` fails even when `guide.md` exists. Paths in directories agentcheckup did not list, such as `node_modules`, are never reported.",
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
      INSTRUCTION_SOURCES.claudeSymlinkImportsUndocumented,
      INSTRUCTION_SOURCES.geminiImportBaseSource,
    ],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      summary:
        'Points the import at the only file in the repository with the name it asks for. Without exactly one such file, the path is left to you.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    const graph = new ImportGraph(context);
    const found = new Map<string, Unresolved>();

    for (const dialect of targetedDialects(context)) {
      for (const { artifact, documented, uncertainty } of filesWithFollowedImports(
        graph,
        dialect,
      )) {
        const doc = graph.markdown(artifact);
        for (const edge of graph.edges(artifact, dialect)) {
          const { reference } = edge;
          if (dialect === 'claude' && inHtmlComment(doc, reference)) continue;
          const unresolved = unresolvedImport(graph, artifact, edge, dialect);
          if (unresolved === undefined) continue;

          const key = `${artifact.path}\u0000${String(reference.span.offset)}`;
          const existing = found.get(key);
          if (existing !== undefined) {
            existing.dialects.add(dialect);
            continue;
          }
          found.set(key, {
            artifact,
            span: reference.span,
            raw: reference.raw,
            path: unresolved.path,
            dialects: new Set([dialect]),
            uncertainty: dialect === 'claude' && !documented ? uncertainty : undefined,
            ...(unresolved.withoutPunctuation === undefined
              ? {}
              : { withoutPunctuation: unresolved.withoutPunctuation }),
          });
        }
      }
    }

    const limiter = new FindingLimiter();
    const files = new FilesByName(context.snapshot);
    for (const unresolved of found.values()) {
      if (!limiter.allow(unresolved.artifact.path)) continue;
      const onlyUndocumented =
        unresolved.uncertainty !== undefined && !unresolved.dialects.has('gemini');
      context.report({
        artifact: unresolved.artifact,
        span: unresolved.span,
        ...(onlyUndocumented ? { severity: 'info' as const } : {}),
        platforms: [...unresolved.dialects].map((dialect) => DIALECT_PLATFORM[dialect]),
        message: message(unresolved),
        ...repoint(graph, files, unresolved),
      });
    }
  },
});
