import { compareStrings } from '../../core/compare.js';
import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix } from '../../core/paths.js';
import { lineText, positionAt } from '../../core/text.js';
import { skillDirectoryOf } from '../../platforms/location.js';
import type { Artifact, RelatedLocation, Span } from '../../core/types.js';
import {
  CODEX_DEFAULT_MAX_BYTES,
  CODEX_FILE_NAMES,
  type CodexChainFile,
  codexChain,
  codexMaxBytes,
} from '../../platforms/load/codex-chain.js';
import { viewOf } from '../../platforms/load/view.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { textOffsetAtByte } from './codex.js';
import { formatInteger, plural, quotePath } from '../shared/format.js';
import { basename, inPayloadFolder } from './helpers.js';
import { INSTRUCTION_SOURCES } from './sources.js';

export interface CodexSizeBudgetOptions {
  /** Codex's `project_doc_max_bytes`. */
  readonly maxBytes: number;
}

/** Bounds the related locations listed on one finding. */
const MAX_RELATED = 20;

interface Truncation {
  readonly file: CodexChainFile;
  /** Bytes of this file that Codex reads. */
  readonly cut: number;
  /** Bytes of every non-empty file up to and including this one. */
  readonly total: number;
  readonly before: readonly CodexChainFile[];
  readonly dropped: Map<string, CodexChainFile>;
}

interface NearLimit {
  readonly file: CodexChainFile;
  readonly total: number;
  readonly before: readonly CodexChainFile[];
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
  defaultOptions: { maxBytes: CODEX_DEFAULT_MAX_BYTES },
  check(context) {
    const maxBytes = codexMaxBytes(context.options.maxBytes);
    const view = viewOf(context);
    const { snapshot, index } = view;

    const directories = new Set<string>();
    for (const path of index.keys()) {
      if (!CODEX_FILE_NAMES.includes(basename(path))) continue;
      const directory = dirnamePosix(path);
      // Nobody runs Codex inside .codex/, .github/ or .claude/; files there are templates. An
      // AGENTS.md inside a skill folder is the skill's reference document.
      if (directory.split('/').some((segment) => segment.startsWith('.'))) continue;
      if (skillDirectoryOf(snapshot, path) !== undefined || inPayloadFolder(path)) continue;
      directories.add(directory);
    }

    const truncations = new Map<string, Truncation>();
    const nearLimits = new Map<string, NearLimit>();

    for (const directory of [...directories].sort(compareStrings)) {
      const chain = codexChain(view, directory, { maxBytes });
      const before: CodexChainFile[] = [];
      for (const file of chain.files) {
        if (file.status === 'read') {
          const total = file.offset + file.size;
          if (
            total * 5 >= maxBytes * 4 &&
            file.offset * 5 < maxBytes * 4 &&
            !nearLimits.has(file.path)
          ) {
            nearLimits.set(file.path, { file, total, before: [...before] });
          }
          before.push(file);
          continue;
        }
        if (file.status !== 'cut' && file.status !== 'cut-blank') continue;
        // Chains that share this prefix cut the same file at the same byte: one finding, listing
        // the files each of them drops.
        const key = `${file.path}\u0000${String(file.cutAt)}`;
        let truncation = truncations.get(key);
        if (truncation === undefined) {
          truncation = {
            file,
            cut: file.cutAt,
            total: file.offset + file.size,
            before: [...before],
            dropped: new Map(),
          };
          truncations.set(key, truncation);
        }
        if (file.status === 'cut') {
          for (const later of chain.dropped) truncation.dropped.set(later.path, later);
        }
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
