/**
 * Fix helpers shared by the Cursor and GitHub Copilot rules: renames that must not collide with
 * another file, the symlink guard of ADR 0008, the links that still name a renamed file, and the
 * glob patterns a fix joins into one string. Frontmatter edits use the builders in
 * src/fix/edits.ts, which check their own result.
 */
import { dirnamePosix, joinRelative, pathStatus } from '../../core/paths.js';
import type { Artifact, FileChange, ParseServices, Snapshot, TextEdit } from '../../core/types.js';
import { safeCopiedText } from '../../fix/edits.js';
import { foldPath, pathProblem } from '../../fix/paths.js';
import { compareEdits } from '../../fix/text.js';
import { joinNames, plural, quotePath } from '../shared/format.js';

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/**
 * True when the artifact's file is reached through a symlink, or other paths link to it. Such
 * files are never renamed or edited by a fix (ADR 0008): the change would break the link or
 * reach a file the user did not name.
 */
export function isLinked(artifact: Artifact): boolean {
  return artifact.file.symlinkTarget !== undefined || artifact.aliases.length > 0;
}

/** The manual step for a file {@link isLinked} refuses. */
export function linkedGuidance(artifact: Artifact, action: string): string {
  const target = artifact.file.symlinkTarget;
  if (target !== undefined) {
    return `${quotePath(artifact.path)} is a symbolic link to ${quotePath(target)}: ${action} by hand`;
  }
  const alias = artifact.aliases[0] ?? artifact.path;
  return `${quotePath(alias)} links to this file: ${action} by hand and update the link`;
}

const foldedIndexes = new WeakMap<Snapshot, ReadonlySet<string>>();

/** Every path of the snapshot, files and directories, case-folded. Built once per snapshot. */
function foldedPaths(snapshot: Snapshot): ReadonlySet<string> {
  const cached = foldedIndexes.get(snapshot);
  if (cached !== undefined) return cached;
  const folded = new Set<string>();
  for (const path of snapshot.paths) {
    folded.add(foldPath(path.endsWith('/') ? path.slice(0, -1) : path));
  }
  for (const path of snapshot.ignoredFiles) folded.add(foldPath(path));
  foldedIndexes.set(snapshot, folded);
  return folded;
}

/**
 * True when a file may not be created or renamed to `path`: it is not a valid fix target, or a
 * path equal to it ignoring letter case exists or may exist (macOS and Windows compare names
 * that way, so `Style.mdc` takes the place of `style.mdc`).
 */
export function pathTaken(snapshot: Snapshot, path: string): boolean {
  if (pathProblem(path) !== undefined) return true;
  return foldedPaths(snapshot).has(foldPath(path)) || pathStatus(snapshot, path) !== 'missing';
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** The root-relative file a Markdown link in `from` points to, or undefined for other links. */
function linkTarget(from: string, url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === '' || trimmed.startsWith('#') || SCHEME.test(trimmed)) return undefined;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || trimmed.startsWith('~')) {
    return undefined;
  }
  const end = trimmed.search(/[?#]/);
  const raw = end === -1 ? trimmed : trimmed.slice(0, end);
  if (raw === '') return undefined;
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return joinRelative(dirnamePosix(from), path);
}

/** Most referring files a note names. */
const MAX_NAMED_REFERRERS = 3;

/**
 * Finds the Markdown links to files that a fix renames, so the fix can name them as manual
 * follow-ups. Built on first use: only the link targets `wanted` accepts are kept.
 */
export class LinkReferences {
  readonly #parse: Pick<ParseServices, 'markdown'>;
  readonly #artifacts: readonly Artifact[];
  readonly #wanted: (path: string) => boolean;
  #index: Map<string, string[]> | undefined;

  constructor(
    parse: Pick<ParseServices, 'markdown'>,
    artifacts: readonly Artifact[],
    wanted: (path: string) => boolean,
  ) {
    this.#parse = parse;
    this.#artifacts = artifacts;
    this.#wanted = wanted;
  }

  #build(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const artifact of this.#artifacts) {
      if (artifact.path.toLowerCase().endsWith('.json')) continue;
      for (const link of this.#parse.markdown(artifact).links) {
        const target = linkTarget(artifact.path, link.url);
        if (target === undefined || target === artifact.path || !this.#wanted(target)) continue;
        const referrers = index.get(target) ?? [];
        if (!referrers.includes(artifact.path)) referrers.push(artifact.path);
        index.set(target, referrers);
      }
    }
    return index;
  }

  /** A note asking to update the links to `path`, or undefined when no file links to it. */
  note(path: string): string | undefined {
    this.#index ??= this.#build();
    const referrers = this.#index.get(path) ?? [];
    if (referrers.length === 0) return undefined;
    const named = referrers.slice(0, MAX_NAMED_REFERRERS).map(quotePath);
    const rest = referrers.length - named.length;
    const where =
      rest > 0 ? `${named.join(', ')} and ${plural(rest, 'other file')}` : joinNames(named);
    return `Update the links to ${quotePath(path)} in ${where}: they still point to the old name.`;
  }
}

/** An edit change moved to the path a preceding rename gave its file. */
export function editAt(path: string, change: FileChange): FileChange {
  return change.kind === 'edit' ? { ...change, path } : change;
}

/** Merges the edits of several changes to one file into one change on `artifact`. */
export function mergeEdits(
  artifact: Artifact,
  changes: readonly (FileChange | undefined)[],
): FileChange | undefined {
  const edits: TextEdit[] = [];
  for (const change of changes) {
    if (change?.kind !== 'edit' || change.path !== artifact.path) return undefined;
    edits.push(...change.edits);
  }
  edits.sort(compareEdits);
  for (let index = 1; index < edits.length; index++) {
    const previous = edits[index - 1];
    const edit = edits[index];
    if (previous === undefined || edit === undefined) continue;
    if (edit.offset < previous.offset + previous.length || edit.offset === previous.offset) {
      return undefined;
    }
  }
  return { kind: 'edit', path: artifact.path, edits };
}

// ---------------------------------------------------------------------------------------------
// Glob patterns
// ---------------------------------------------------------------------------------------------

/** Longest pattern a fix copies, in code points. Longer ones are left to the user. */
const MAX_PATTERN_LENGTH = 1000;
/** Most patterns a fix joins. */
const MAX_PATTERNS = 200;

/**
 * The items of a YAML list of glob patterns joined into one string with `separator`, or
 * undefined when the list is empty or too long, or an item is not a one-line string without
 * surrounding spaces, control or invisible characters, or a comma. Cursor and GitHub Copilot
 * split the string at commas, so a pattern with a comma (`src/{a,b}/**`) would change meaning.
 */
export function joinPatterns(value: unknown, separator: string): string | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATTERNS) {
    return undefined;
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.includes(',')) return undefined;
    if (safeCopiedText(item, MAX_PATTERN_LENGTH) !== item) return undefined;
    items.push(item);
  }
  return items.join(separator);
}
