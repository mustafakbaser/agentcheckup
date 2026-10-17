import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, ReportDescriptor, Snapshot } from '../../core/types.js';
import { renameFile } from '../../fix/edits.js';
import { pathProblem } from '../../fix/paths.js';
import { isLinked, linkedGuidance, pathTaken } from '../cursor/fixes.js';
import { defineRule } from '../define.js';
import { basename, joinPath } from '../instructions/helpers.js';
import { quotePath } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { copilotMisplacement, type Placement, placement } from './location.js';
import { COPILOT_SOURCES } from './sources.js';

const ID = 'copilot/instructions-misplaced';
const REPOSITORY_WIDE = 'copilot-instructions.md';
const PATH_SPECIFIC = 'instructions';

type Finding = Omit<ReportDescriptor, 'artifact'>;
type Remedy = Pick<ReportDescriptor, 'fix' | 'guidance'>;

function repositoryWide(path: string, where: Placement): Finding | undefined {
  switch (where.kind) {
    case 'expected':
      return undefined;
    case 'case':
      return {
        severity: 'warn',
        message: `${quotePath(path)} matches ".github/copilot-instructions.md" only when letter case is ignored. GitHub.com and Linux treat file names as case-sensitive, so GitHub Copilot does not load it there.`,
      };
    case 'nested':
      return {
        severity: 'warn',
        message: `On GitHub.com, GitHub Copilot reads .github/copilot-instructions.md only at the repository root, so it does not load this file. VS Code loads it only when you open ${quotePath(where.root)} as the workspace folder.`,
      };
    case 'elsewhere':
      return {
        message:
          'GitHub Copilot reads repository-wide instructions only from .github/copilot-instructions.md, so it does not load this file. Move it there.',
      };
  }
}

function pathSpecific(path: string, where: Placement): Finding | undefined {
  switch (where.kind) {
    case 'expected':
      return undefined;
    case 'case':
      return {
        severity: 'warn',
        message: `${quotePath(path)} is inside ".github/instructions" only when letter case is ignored. GitHub.com and Linux treat file names as case-sensitive, so GitHub Copilot does not load it there.`,
      };
    case 'nested':
      return {
        severity: 'warn',
        message: `On GitHub.com, GitHub Copilot reads .github/instructions only at the repository root, so it does not load this file. VS Code loads it only when you open ${quotePath(where.root)} as the workspace folder.`,
      };
    case 'elsewhere':
      return {
        severity: 'warn',
        message:
          "GitHub Copilot reads path-specific instructions only from .github/instructions, so it does not load this file. Only VS Code's deprecated chat.instructionsFilesLocations setting can add another directory, for its Local harness.",
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Fixes and manual steps
// ---------------------------------------------------------------------------------------------

/** A path as one shell word: bare when it is plain, else in single quotes. */
function shellWord(path: string): string {
  return /^[\w./@+-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

/** `path` with its `.github/<inside>` segments in the letter case Copilot expects. */
function expectedCase(path: string, inside: string): string {
  const segments = path.split('/');
  const lower = path.toLowerCase().split('/');
  const start = lower.findIndex(
    (segment, index) => segment === '.github' && lower[index + 1] === inside,
  );
  if (start === -1) return path;
  return [...segments.slice(0, start), '.github', inside, ...segments.slice(start + 2)].join('/');
}

/**
 * A case-only rename is never made by the tool (ADR 0008): on macOS and Windows a plain rename
 * does not change what git records, so the manual step renames through a temporary name.
 */
function caseGuidance(path: string, inside: string): Remedy {
  const expected = expectedCase(path, inside);
  const temporary = `${path}.tmp`;
  return {
    guidance: `rename it to ${quotePath(expected)} in two steps, so that git also records the new letter case on macOS and Windows: git mv ${shellWord(path)} ${shellWord(temporary)} && git mv ${shellWord(temporary)} ${shellWord(expected)}`,
  };
}

/** The manual step for a file in the `.github` folder of a subdirectory. */
function nestedGuidance(wide: boolean, root: string): Remedy {
  return {
    guidance: wide
      ? 'to use it on GitHub.com, merge it into .github/copilot-instructions.md at the repository root by hand'
      : `to use it on GitHub.com, move it into .github/instructions/ at the repository root by hand and limit its "applyTo" to ${quotePath(`${root}/**`)}`,
  };
}

/**
 * Moves a file found elsewhere in a `.github` folder to where Copilot looks in that folder. For
 * review: Copilot starts loading it. Manual when the file is linked, the `.github` folder differs
 * in letter case or is not at a repository root, or the target exists.
 */
function moveFix(snapshot: Snapshot, artifact: Artifact, path: string, wide: boolean): Remedy {
  if (isLinked(artifact) || path !== artifact.path) {
    return { guidance: linkedGuidance(artifact, 'move it') };
  }
  const segments = path.split('/');
  const github = segments.findIndex((segment) => segment.toLowerCase() === '.github');
  const folder = joinPath(segments.slice(0, Math.max(0, github)).join('/'), '.github');
  const target = joinPath(folder, wide ? REPOSITORY_WIDE : `${PATH_SPECIFIC}/${basename(path)}`);
  if (segments[github] !== '.github') {
    return { guidance: `move it to ${quotePath(target)} by hand` };
  }
  const where = placement(snapshot, target, wide ? REPOSITORY_WIDE : PATH_SPECIFIC);
  if (where.kind === 'nested') return nestedGuidance(wide, where.root);
  const problem = pathProblem(target);
  if (problem !== undefined) return { guidance: `move it by hand: ${problem}` };
  if (pathTaken(snapshot, target)) {
    return {
      guidance: wide
        ? `${quotePath(target)} already exists: merge this file into it by hand`
        : `${quotePath(target)} already exists: move this file into ${quotePath(`${folder}/${PATH_SPECIFIC}/`)} under another name by hand`,
    };
  }
  return {
    fix: {
      id: `${ID}#move`,
      class: 'review',
      title: `Move ${path} to ${target}`,
      changes: [renameFile(artifact, target)],
      notes: [
        wide
          ? 'GitHub Copilot then adds these instructions to every request in this repository.'
          : 'GitHub Copilot then applies these instructions to the files their "applyTo" matches.',
      ],
    },
  };
}

function remedy(
  snapshot: Snapshot,
  artifact: Artifact,
  path: string,
  where: Placement,
  wide: boolean,
): Remedy {
  switch (where.kind) {
    case 'expected':
      return {};
    case 'case':
      return caseGuidance(path, wide ? REPOSITORY_WIDE : PATH_SPECIFIC);
    case 'nested':
      return nestedGuidance(wide, where.root);
    case 'elsewhere':
      return moveFix(snapshot, artifact, path, wide);
  }
}

function check(snapshot: Snapshot, artifact: Artifact): Finding | undefined {
  // Every path that reaches the file counts: a symlink in .github/instructions makes Copilot see it.
  // The Copilot load plans skip the file for the same reason (src/platforms/copilot.ts).
  const candidate = copilotMisplacement(snapshot, artifact);
  if (candidate === undefined) return undefined;
  const wide = artifact.kind === 'copilot-instructions';
  const finding = wide
    ? repositoryWide(candidate.path, candidate.where)
    : pathSpecific(candidate.path, candidate.where);
  if (finding === undefined) return undefined;
  return { ...finding, ...remedy(snapshot, artifact, candidate.path, candidate.where, wide) };
}

export const instructionsMisplacedRule = defineRule({
  meta: {
    id: ID,
    title: 'GitHub Copilot instructions file is not where Copilot looks for it',
    rationale: [
      'GitHub Copilot reads repository-wide instructions from `.github/copilot-instructions.md` and path-specific instructions from `*.instructions.md` files in `.github/instructions/` and its subdirectories, both at the repository root. A `copilot-instructions.md` anywhere else in `.github` is not loaded. In VS Code, the deprecated `chat.instructionsFilesLocations` setting can add other directories for the Local harness, so a misplaced `*.instructions.md` file is a warning.',
      'A `.github` directory inside a subdirectory is not read on GitHub.com; VS Code reads it when you open that subdirectory as the workspace folder. A subdirectory with its own `.git` counts as a repository root. Only files inside a `.github` directory are checked, except `.github/workflows` and the `.github` directories of templates, examples and fixtures. A file that is also reachable through a symlink in the right place is not reported.',
      'Move the file to `.github/copilot-instructions.md` or into `.github/instructions/`.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: ['copilot-instructions', 'copilot-path-instructions'],
    platforms: ['copilot'],
    sources: [SOURCES.copilotRepoInstructions, COPILOT_SOURCES.vscodeInstructions],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      summary:
        'Moves a file found elsewhere in a .github folder to .github/copilot-instructions.md or into .github/instructions/. A letter-case difference, a .github folder in a subdirectory and an existing target are left to the user, with the commands to run.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const finding = check(context.snapshot, artifact);
      if (finding !== undefined) context.report({ artifact, ...finding });
    }
  },
});
