import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix, joinRelative } from '../../core/paths.js';
import type { Artifact, Snapshot } from '../../core/types.js';
import { classify } from '../../platforms/classify.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { quotePath } from '../shared/format.js';
import { fileExists, targetedReaders } from './helpers.js';
import { INSTRUCTION_SOURCES } from './sources.js';

/** Symlink targets are paths; a one-line file longer than this is not one. */
const MAX_TARGET_LENGTH = 1024;
const WHITESPACE = /\s/;

interface Materialized {
  readonly target: string;
  readonly resolved: string;
  readonly offset: number;
}

/**
 * Recognizes the text file Git writes for a symlink when `core.symlinks` is off: the whole file
 * is one relative path, without spaces, to an existing Markdown or instruction file.
 */
function materialized(snapshot: Snapshot, artifact: Artifact): Materialized | undefined {
  const { text } = artifact.decoded;
  const target = text.trim();
  if (target.length === 0 || target.length > MAX_TARGET_LENGTH) return undefined;
  if (WHITESPACE.test(target)) return undefined;
  const first = target.charAt(0);
  if (first === '@' || first === '/' || first === '~' || first === '#') return undefined;
  if (target.includes('://') || target.includes('\\')) return undefined;

  const resolved = joinRelative(dirnamePosix(artifact.path), target);
  if (resolved === undefined || resolved === '' || resolved === artifact.path) return undefined;
  if (!fileExists(snapshot, resolved)) return undefined;
  const lower = resolved.toLowerCase();
  if (classify(resolved) === undefined && !lower.endsWith('.md') && !lower.endsWith('.mdc')) {
    return undefined;
  }
  return { target, resolved, offset: text.indexOf(target) };
}

export const symlinkMaterializedRule = defineRule({
  meta: {
    id: 'instr/symlink-materialized',
    title: 'Instruction file is a symlink checked out as plain text',
    rationale: [
      "When a repository commits a symlink such as `CLAUDE.md -> AGENTS.md`, Git checks it out as a one-line text file that holds the target path unless `core.symlinks` is enabled. This is common on Windows, where creating symlinks needs Administrator rights or Developer Mode. Agents then read the path instead of the instructions it points to. Claude Code's documentation warns about this for `CLAUDE.md`.",
      'For `CLAUDE.md`, replace the symlink with a file that contains the import `@AGENTS.md`, which works on every platform. Otherwise enable symlinks (`git config core.symlinks true`) and check the file out again.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: [
      'agents-md',
      'agents-override-md',
      'claude-md',
      'claude-local-md',
      'claude-rule',
      'claude-agent',
      'gemini-md',
      'windsurf-rule',
      'windsurf-legacy-rules',
      'cline-rule',
      'cursor-rule',
      'cursor-legacy-rules',
      'copilot-instructions',
      'copilot-path-instructions',
    ],
    platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini', 'windsurf', 'cline'],
    sources: [SOURCES.claudeMemory, INSTRUCTION_SOURCES.gitCoreSymlinks],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const platforms = targetedReaders(context, artifact);
      if (platforms.length === 0) continue;
      const found = materialized(context.snapshot, artifact);
      if (found === undefined) continue;
      context.report({
        artifact,
        platforms,
        span: { offset: found.offset, length: found.target.length },
        message: `This file contains only the path ${quotePath(found.target)}. Git checks out a committed symlink as a one-line text file when core.symlinks is off, so agents read this line instead of the instructions in ${quotePath(found.resolved)}.`,
        related: [{ path: found.resolved, message: 'The file this one links to.' }],
      });
    }
  },
});
