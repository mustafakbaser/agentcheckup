import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, ReportDescriptor } from '../../core/types.js';
import { defineRule } from '../define.js';
import { quotePath } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { inPlausibleGithubTree, type Placement, placement } from './location.js';
import { COPILOT_SOURCES } from './sources.js';

type Finding = Omit<ReportDescriptor, 'artifact'>;

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

function check(artifact: Artifact, where: (path: string) => Placement): Finding | undefined {
  // Every path that reaches the file counts: a symlink in .github/instructions makes Copilot see it.
  const paths = [artifact.path, ...artifact.aliases];
  const placements = paths.map((path) => ({ path, where: where(path) }));
  if (placements.some((entry) => entry.where.kind === 'expected')) return undefined;
  const candidate = placements.find((entry) => inPlausibleGithubTree(entry.path));
  if (candidate === undefined) return undefined;
  return artifact.kind === 'copilot-instructions'
    ? repositoryWide(candidate.path, candidate.where)
    : pathSpecific(candidate.path, candidate.where);
}

export const instructionsMisplacedRule = defineRule({
  meta: {
    id: 'copilot/instructions-misplaced',
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
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const inside =
        artifact.kind === 'copilot-instructions' ? 'copilot-instructions.md' : 'instructions';
      const finding = check(artifact, (path) => placement(context.snapshot, path, inside));
      if (finding !== undefined) context.report({ artifact, ...finding });
    }
  },
});
