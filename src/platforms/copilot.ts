/**
 * Where GitHub Copilot reads instruction files and when it applies a path-specific one, shared by
 * the copilot/* rules and the Copilot load plans. Sources: GitHub's repository instructions page
 * and support matrix (SOURCES.copilotRepoInstructions, SOURCES.copilotInstructionsSupport) and
 * VS Code's custom instructions page (SOURCES.vscodeInstructions).
 */
import { pathStatus } from '../core/paths.js';
import type { Artifact, ParseServices, Snapshot } from '../core/types.js';
import type { FrontmatterResult } from '../parse/types.js';
import { globList } from './cursor-rules.js';
import { inPayloadFolder, joinPath } from './paths.js';
import { yamlSyntaxError } from './yaml.js';

// ---------------------------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------------------------

/** Where a path sits relative to the `.github/<subdirectory>` folder Copilot reads. */
export type Placement =
  /** Exactly where Copilot looks. */
  | { readonly kind: 'expected' }
  /** The right place when ignoring letter case. */
  | { readonly kind: 'case' }
  /** Inside `<root>/.github/...` of a subdirectory that is not a repository root. */
  | { readonly kind: 'nested'; readonly root: string }
  | { readonly kind: 'elsewhere' };

/**
 * Classifies `path` against `.github/<inside>` at the repository root. A `.github` folder in a
 * subdirectory that has its own `.git` (a nested repository or submodule) counts as a root.
 */
export function placement(snapshot: Snapshot, path: string, inside: string): Placement {
  const segments = path.split('/');
  const lower = segments.map((segment) => segment.toLowerCase());
  const insideSegments = inside.split('/');
  for (let start = 0; start + insideSegments.length < segments.length + 1; start++) {
    if (lower[start] !== '.github') continue;
    const matches = insideSegments.every(
      (segment, index) => lower[start + 1 + index] === segment.toLowerCase(),
    );
    if (!matches) continue;
    const exact =
      segments[start] === '.github' &&
      insideSegments.every((segment, index) => segments[start + 1 + index] === segment);
    if (!exact) return { kind: 'case' };
    if (start === 0) return { kind: 'expected' };
    const root = segments.slice(0, start).join('/');
    if (pathStatus(snapshot, joinPath(root, '.git')) === 'exists') return { kind: 'expected' };
    return { kind: 'nested', root };
  }
  return { kind: 'elsewhere' };
}

/**
 * Whether Copilot could plausibly be meant to read `path` from where it is: inside a `.github`
 * tree, but not in `.github/workflows` (agentic workflow imports use the same suffix), and not
 * inside a template, example or fixture project whose `.github` folder is copied elsewhere.
 * Files outside any `.github` folder are often copy-paste collections or shared sources.
 */
export function inPlausibleGithubTree(path: string): boolean {
  const lower = path.toLowerCase().split('/');
  const index = lower.indexOf('.github');
  if (index === -1) return false;
  if (lower[index + 1] === 'workflows') return false;
  return !inPayloadFolder(lower.slice(0, index + 1).join('/'));
}

/** Frontmatter keys that only Copilot instruction files use. */
const COPILOT_KEYS = ['applyTo', 'excludeAgent', 'description'] as const;

/**
 * Whether a `*.instructions.md` file is meant for Copilot: it lives under a `.github` folder
 * (except `.github/workflows`, where agentic workflows keep imports with the same suffix) or its
 * frontmatter uses Copilot's fields. Other files with that suffix may be ordinary docs.
 */
export function meantForCopilot(
  parse: Pick<ParseServices, 'frontmatter'>,
  artifact: Artifact,
): boolean {
  const segments = artifact.path.toLowerCase().split('/');
  const github = segments.indexOf('.github');
  if (github !== -1) return segments[github + 1] !== 'workflows';
  const frontmatter = parse.frontmatter(artifact);
  return (
    frontmatter.kind === 'valid' &&
    COPILOT_KEYS.some((key) => Object.hasOwn(frontmatter.data.values, key))
  );
}

// ---------------------------------------------------------------------------------------------
// Activation of path-specific instructions
// ---------------------------------------------------------------------------------------------

/** What the `applyTo` field of a `*.instructions.md` file holds. */
export type CopilotApplyTo =
  /** No `applyTo` key, or no frontmatter Copilot can read. */
  | { readonly kind: 'missing' }
  /** `applyTo:` without a value: it matches no files. */
  | { readonly kind: 'null' }
  /** A string with only white space: it matches no files. */
  | { readonly kind: 'blank' }
  /** One string of comma-separated patterns, the documented form. */
  | { readonly kind: 'patterns'; readonly patterns: readonly string[] }
  /** A non-empty YAML list of strings. GitHub does not document this form. */
  | { readonly kind: 'list'; readonly patterns: readonly string[] }
  /** Any other value, such as a number, a mapping or an empty list. */
  | { readonly kind: 'invalid'; readonly value: unknown };

/**
 * When a surface applies a path-specific instructions file:
 * - `on-path`: when a file its `applyTo` patterns match is in the request.
 * - `model-selected`: when its `description` matches the task (VS Code).
 * - `manual`: only when attached to a chat by hand (VS Code).
 * - `never`: the surface does not apply it.
 * - `unknown`: the form is not documented.
 */
export type CopilotTrigger = 'on-path' | 'model-selected' | 'manual' | 'never' | 'unknown';

export interface CopilotActivation {
  /**
   * - `absent`: no frontmatter.
   * - `valid`: YAML that parses.
   * - `tolerated`: YAML that does not parse for a reason lenient readers may accept, such as an
   *   unquoted `*` pattern or one of agentcheckup's own parser limits, so what Copilot reads
   *   cannot be told.
   * - `unreadable`: no closing `---` line, a format other than YAML, or YAML that does not parse.
   */
  readonly frontmatter: 'absent' | 'valid' | 'tolerated' | 'unreadable';
  readonly applyTo: CopilotApplyTo;
  /** The frontmatter has a `description` with text. */
  readonly described: boolean;
  /** The surface `excludeAgent` names, when it holds one of the documented values. */
  readonly excludeAgent?: 'code-review' | 'cloud-agent';
  /**
   * Copilot cloud agent and code review on GitHub.com: only through a valid `applyTo`. Whether
   * `excludeAgent` leaves the cloud agent out is in `excludeAgent`.
   */
  readonly cloud: CopilotTrigger;
  /** VS Code: through `applyTo`, else through `description`, else attached by hand. */
  readonly vscode: CopilotTrigger;
}

/** The documented `excludeAgent` values. */
export const EXCLUDE_AGENT_VALUES: ReadonlySet<string> = new Set(['code-review', 'cloud-agent']);

/** What `applyTo` holds, from the frontmatter's values. */
function applyToOf(values: Readonly<Record<string, unknown>>): CopilotApplyTo {
  if (!Object.hasOwn(values, 'applyTo')) return { kind: 'missing' };
  const value = values['applyTo'];
  if (value === null) return { kind: 'null' };
  if (typeof value === 'string') {
    return value.trim() === ''
      ? { kind: 'blank' }
      : { kind: 'patterns', patterns: globList(value) ?? [] };
  }
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) {
    return { kind: 'list', patterns: globList(value) ?? [] };
  }
  return { kind: 'invalid', value };
}

/** The cloud agent applies a file only through `applyTo` patterns it can read. */
function cloudTrigger(applyTo: CopilotApplyTo): CopilotTrigger {
  switch (applyTo.kind) {
    case 'patterns':
      return 'on-path';
    case 'list':
      return 'unknown';
    case 'missing':
    case 'null':
    case 'blank':
    case 'invalid':
      return 'never';
  }
}

/** VS Code: `applyTo` first, then `description`; a file with neither is attached by hand. */
function vscodeTrigger(applyTo: CopilotApplyTo, described: boolean): CopilotTrigger {
  switch (applyTo.kind) {
    case 'patterns':
      return 'on-path';
    case 'missing':
      return described ? 'model-selected' : 'manual';
    case 'list':
    case 'null':
    case 'blank':
    case 'invalid':
      return 'unknown';
  }
}

const MISSING: CopilotApplyTo = { kind: 'missing' };

/** When each surface applies a path-specific instructions file, from its parsed frontmatter. */
export function copilotActivation(frontmatter: FrontmatterResult): CopilotActivation {
  switch (frontmatter.kind) {
    case 'absent':
      return {
        frontmatter: 'absent',
        applyTo: MISSING,
        described: false,
        cloud: 'never',
        vscode: 'manual',
      };
    case 'unclosed':
    case 'unsupported':
      return {
        frontmatter: 'unreadable',
        applyTo: MISSING,
        described: false,
        cloud: 'never',
        vscode: 'unknown',
      };
    case 'invalid': {
      const readable = yamlSyntaxError(frontmatter.errors, { tolerateCommonMistakes: true });
      return {
        frontmatter: readable === undefined ? 'tolerated' : 'unreadable',
        applyTo: MISSING,
        described: false,
        cloud: readable === undefined ? 'unknown' : 'never',
        vscode: 'unknown',
      };
    }
    case 'valid': {
      const { values } = frontmatter.data;
      const applyTo = applyToOf(values);
      const description = values['description'];
      const described = typeof description === 'string' && description.trim() !== '';
      const exclude = values['excludeAgent'];
      return {
        frontmatter: 'valid',
        applyTo,
        described,
        ...(typeof exclude === 'string' && EXCLUDE_AGENT_VALUES.has(exclude)
          ? { excludeAgent: exclude as 'code-review' | 'cloud-agent' }
          : {}),
        cloud: cloudTrigger(applyTo),
        vscode: vscodeTrigger(applyTo, described),
      };
    }
  }
}
