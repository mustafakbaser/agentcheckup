import { compareStrings } from '../../core/compare.js';
import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix, pathStatus } from '../../core/paths.js';
import { lineText, positionAt } from '../../core/text.js';
import { skillDirectoryOf } from '../../platforms/location.js';
import type { Artifact, RelatedLocation, Snapshot, Span } from '../../core/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { codexSeesBlank, textOffsetAtByte } from './codex.js';
import { formatInteger, plural, quotePath } from '../shared/format.js';
import {
  basename,
  indexArtifacts,
  inPayloadFolder,
  joinPath,
  nearestGitRoot,
  selfAndAncestors,
} from './helpers.js';
import { INSTRUCTION_SOURCES } from './sources.js';

export interface CodexSizeBudgetOptions {
  /** Codex's `project_doc_max_bytes`. */
  readonly maxBytes: number;
}

const OVERRIDE_NAME = 'AGENTS.override.md';
const AGENTS_NAME = 'AGENTS.md';
/** Bounds the related locations listed on one finding. */
const MAX_RELATED = 20;

interface ChainFile {
  /** The path Codex opens (may be a symlink alias of `artifact`). */
  readonly path: string;
  readonly artifact: Artifact;
  readonly size: number;
}

interface Truncation {
  readonly file: ChainFile;
  /** Bytes of this file that Codex reads. */
  readonly cut: number;
  /** Bytes of every non-empty file up to and including this one. */
  readonly total: number;
  readonly before: readonly ChainFile[];
  readonly dropped: Map<string, ChainFile>;
}

interface NearLimit {
  readonly file: ChainFile;
  readonly total: number;
  readonly before: readonly ChainFile[];
}

type Selection =
  | { readonly kind: 'file'; readonly file: ChainFile }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown' };

function maxBytesOption(options: CodexSizeBudgetOptions): number {
  const value: unknown = options.maxBytes;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Option "maxBytes" must be a positive integer, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * The file Codex reads in `directory`: the first of AGENTS.override.md and AGENTS.md that exists
 * as a file, even when it is empty. A candidate that exists but was not read (gitignored, too
 * large) or might exist makes the choice unknown.
 */
function selectFile(
  snapshot: Snapshot,
  index: ReadonlyMap<string, Artifact>,
  directory: string,
): Selection {
  for (const name of [OVERRIDE_NAME, AGENTS_NAME]) {
    const path = joinPath(directory, name);
    const artifact = index.get(path);
    if (artifact !== undefined) {
      return { kind: 'file', file: { path, artifact, size: artifact.file.bytes.length } };
    }
    if (pathStatus(snapshot, path) !== 'missing') return { kind: 'unknown' };
  }
  return { kind: 'none' };
}

/** Directories from `root` down to `directory`, inclusive. */
function chainDirectories(root: string, directory: string): string[] {
  const upward = selfAndAncestors(directory);
  const end = upward.indexOf(root);
  return upward.slice(0, end === -1 ? upward.length : end + 1).reverse();
}

function filesAbove(count: number): string {
  return count === 1
    ? 'the AGENTS.md file above it'
    : `the ${plural(count, 'AGENTS.md file')} above it`;
}

function lineSpan(artifact: Artifact, offset: number): { span: Span; line: number } {
  const { line } = positionAt(artifact.decoded, offset);
  const lineStart = artifact.decoded.lineStarts[line - 1] ?? 0;
  const lineEnd = lineStart + lineText(artifact.decoded, line).length;
  return { span: { offset, length: Math.max(0, lineEnd - offset) }, line };
}

export const codexSizeBudgetRule = defineRule<CodexSizeBudgetOptions>({
  meta: {
    id: 'instr/codex-size-budget',
    title: 'AGENTS.md files exceed the Codex size limit',
    rationale: [
      "Codex reads one instruction file per directory, from the project root down to the working directory: `AGENTS.override.md` if it exists, otherwise `AGENTS.md`. It reads at most `project_doc_max_bytes` (32,768 bytes by default) across the whole chain: the file that crosses the limit is cut at that byte, and later files are dropped. Whitespace-only files and the global `~/.codex/AGENTS.md` do not count. Codex's configuration pages call the key a per-file limit; the `AGENTS.md` page and the source code apply it to the chain.",
      "agentcheckup starts each chain at the nearest directory with a `.git` entry (a directory, or a file in submodules and worktrees). Without one, Codex reads only the working directory's file, so agentcheckup judges each file alone. It warns at 80% of the limit, and skips skills and directories that start with a dot or hold templates, examples or fixtures.",
      'Move instructions for one part of the repository into an `AGENTS.md` in that directory, or cut content. If you raised `project_doc_max_bytes`, set the `maxBytes` option to the same value.',
    ].join('\n\n'),
    category: 'budget',
    severity: 'error',
    appliesTo: ['agents-md', 'agents-override-md'],
    platforms: ['codex'],
    sources: [
      SOURCES.codexAgentsMd,
      SOURCES.codexAgentsMdSource,
      INSTRUCTION_SOURCES.codexDefaults,
      INSTRUCTION_SOURCES.codexFindUp,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: { maxBytes: 32_768 },
  check(context) {
    const maxBytes = maxBytesOption(context.options);
    const { snapshot } = context;
    const index = indexArtifacts(context.allArtifacts);

    const directories = new Set<string>();
    for (const path of index.keys()) {
      const name = basename(path);
      if (name !== OVERRIDE_NAME && name !== AGENTS_NAME) continue;
      const directory = dirnamePosix(path);
      // Nobody runs Codex inside .codex/, .github/ or .claude/; files there are templates. An
      // AGENTS.md inside a skill folder is the skill's reference document.
      if (directory.split('/').some((segment) => segment.startsWith('.'))) continue;
      if (skillDirectoryOf(snapshot, path) !== undefined || inPayloadFolder(path)) continue;
      directories.add(directory);
    }

    const blankCache = new Map<Artifact, boolean>();
    const isBlankFile = (artifact: Artifact): boolean => {
      let blank = blankCache.get(artifact);
      if (blank === undefined) {
        blank = codexSeesBlank(artifact.file.bytes);
        blankCache.set(artifact, blank);
      }
      return blank;
    };

    const truncations = new Map<string, Truncation>();
    const nearLimits = new Map<string, NearLimit>();

    for (const directory of [...directories].sort(compareStrings)) {
      // Without a project root marker Codex reads only the working directory's file.
      const root = nearestGitRoot(snapshot, directory) ?? directory;
      let remaining = maxBytes;
      let total = 0;
      const before: ChainFile[] = [];
      let truncation: Truncation | undefined;

      for (const dir of chainDirectories(root, directory)) {
        const selection = selectFile(snapshot, index, dir);
        if (selection.kind === 'unknown') break;
        if (selection.kind === 'none') continue;
        const { file } = selection;
        if (isBlankFile(file.artifact)) continue;

        if (remaining === 0 && truncation !== undefined) {
          truncation.dropped.set(file.path, file);
          continue;
        }
        if (file.size > remaining) {
          const key = `${file.path}\u0000${String(remaining)}`;
          truncation = truncations.get(key);
          if (truncation === undefined) {
            truncation = {
              file,
              cut: remaining,
              total: total + file.size,
              before: [...before],
              dropped: new Map(),
            };
            truncations.set(key, truncation);
          }
          // Codex keeps the first `remaining` bytes. When those are only whitespace it skips the
          // file and the budget carries over to the next one.
          if (remaining === 0 || !codexSeesBlank(file.artifact.file.bytes.subarray(0, remaining))) {
            remaining = 0;
          }
          continue;
        }

        const previous = total;
        remaining -= file.size;
        total += file.size;
        truncation = undefined;
        if (
          total * 5 >= maxBytes * 4 &&
          previous * 5 < maxBytes * 4 &&
          !nearLimits.has(file.path)
        ) {
          nearLimits.set(file.path, { file, total, before: [...before] });
        }
        before.push(file);
      }
    }

    for (const truncation of truncations.values()) {
      const { file, cut, before, dropped } = truncation;
      const { artifact } = file;
      const { span, line } = lineSpan(artifact, textOffsetAtByte(artifact, cut));
      const head =
        before.length === 0
          ? `This file is ${formatInteger(file.size)} bytes.`
          : `This file and ${filesAbove(before.length)} total ${formatInteger(truncation.total)} bytes.`;
      const lost =
        cut === 0
          ? 'so it reads none of this file'
          : `so it stops at line ${formatInteger(line)}${before.length > 0 ? ' of this file' : ''} and ignores the rest`;
      const droppedFiles = [...dropped.values()];
      const alsoDropped =
        droppedFiles.length === 0
          ? ''
          : `, and it never reads ${plural(droppedFiles.length, 'AGENTS.md file')} in subdirectories`;
      const via =
        file.path === artifact.path ? '' : `Codex reads this file as ${quotePath(file.path)}. `;
      const related: RelatedLocation[] = [
        ...before.map((previous) => ({
          path: previous.artifact.path,
          message: `Read by Codex first: ${formatInteger(previous.size)} bytes.`,
        })),
        ...droppedFiles.map((later) => ({
          path: later.artifact.path,
          message: 'Codex does not read this file: the limit is used up before it.',
        })),
      ].slice(0, MAX_RELATED);
      context.report({
        artifact,
        span,
        message: `${via}${head} Codex reads at most ${formatInteger(maxBytes)} bytes of AGENTS.md content, ${lost}${alsoDropped}.`,
        related,
      });
    }

    for (const near of nearLimits.values()) {
      const { file, total, before } = near;
      const percent = Math.floor((total * 100) / maxBytes);
      const head =
        before.length === 0
          ? `This file is ${formatInteger(total)} bytes`
          : `This file and ${filesAbove(before.length)} total ${formatInteger(total)} bytes`;
      const via =
        file.path === file.artifact.path
          ? ''
          : `Codex reads this file as ${quotePath(file.path)}. `;
      context.report({
        artifact: file.artifact,
        severity: 'warn',
        message: `${via}${head}, ${String(percent)}% of the ${formatInteger(maxBytes)} bytes Codex reads from AGENTS.md files. Codex cuts off anything past that limit.`,
        related: before.slice(0, MAX_RELATED).map((previous) => ({
          path: previous.artifact.path,
          message: `Read by Codex first: ${formatInteger(previous.size)} bytes.`,
        })),
      });
    }
  },
});
