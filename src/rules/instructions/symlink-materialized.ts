import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix, joinRelative } from '../../core/paths.js';
import type { Artifact, ReportDescriptor, Snapshot } from '../../core/types.js';
import { replaceSpan } from '../../fix/edits.js';
import { classify } from '../../platforms/classify.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { quotePath } from '../shared/format.js';
import { byHand, editBlocker } from './fixes.js';
import { fileExists, targetedReaders } from './helpers.js';
import { INSTRUCTION_SOURCES } from './sources.js';

const RULE_ID = 'instr/symlink-materialized';

/** Symlink targets are paths; a one-line file longer than this is not one. */
const MAX_TARGET_LENGTH = 1024;
const WHITESPACE = /\s/;

/**
 * Targets that both agents read as an import path when written after `@`: no character their
 * parsers stop at or reject, and no trailing `.`, which Claude Code may strip as punctuation.
 */
const IMPORTABLE_TARGET = /^[\w.-][\w./-]*(?<!\.)$/;

/** How to get the real symlink back. agentcheckup never runs git itself. */
const ENABLE_SYMLINKS =
  'run "git config core.symlinks true" and check the file out again; on Windows, creating symlinks needs Developer Mode or Administrator rights';

export interface Materialized {
  /** The path the file holds. */
  readonly target: string;
  /** The target relative to the scan root. */
  readonly resolved: string;
  readonly offset: number;
}

/**
 * Recognizes the text file Git writes for a symlink when `core.symlinks` is off: the whole file
 * is one relative path, without spaces, to an existing Markdown or instruction file.
 */
export function materialized(snapshot: Snapshot, artifact: Artifact): Materialized | undefined {
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

/** The import that replaces the path: `@AGENTS.md` for Claude Code, `@./AGENTS.md` for Gemini CLI. */
function importLine(artifact: Artifact, target: string): string | undefined {
  if (artifact.caseMismatch !== undefined || !IMPORTABLE_TARGET.test(target)) return undefined;
  if (artifact.kind === 'claude-md' || artifact.kind === 'claude-local-md') return `@${target}`;
  if (artifact.kind !== 'gemini-md') return undefined;
  // Gemini CLI reads an import only when the path starts with ".", "/" or a letter.
  return target.startsWith('./') || target.startsWith('../') ? `@${target}` : `@./${target}`;
}

/** The fix for a CLAUDE.md or GEMINI.md, the manual step for every other file. */
function repair(
  artifact: Artifact,
  found: Materialized,
): Pick<ReportDescriptor, 'fix' | 'guidance'> {
  const line = importLine(artifact, found.target);
  if (line === undefined) return { guidance: ENABLE_SYMLINKS };
  const blocker = editBlocker(artifact);
  if (blocker !== undefined) {
    return { guidance: byHand(`replace the path with the line "${line}"`, blocker) };
  }
  return {
    fix: {
      id: `${RULE_ID}#import`,
      class: 'review',
      title: `Replace the path in ${artifact.path} with the import "${line}"`,
      changes: [replaceSpan(artifact, { offset: found.offset, length: found.target.length }, line)],
      notes: [
        'Git then records this file as a regular file instead of a symlink, and agents read the linked instructions through the import.',
      ],
    },
  };
}

export const symlinkMaterializedRule = defineRule({
  meta: {
    id: RULE_ID,
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
    fix: {
      classes: ['review'],
      summary:
        'Replaces the path in a CLAUDE.md or GEMINI.md with an import of the file it links to; other files need symlinks enabled in Git.',
    },
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
        ...repair(artifact, found),
      });
    }
  },
});
