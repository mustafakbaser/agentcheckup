/**
 * Turns a Fix into what it does to the snapshot: for each existing file, edits on its original
 * text, a new path and whether it is re-encoded; and the files it creates. The planner uses this
 * to refuse paths and find conflicts between fixes, the applier to merge the fixes of a plan.
 * Pure.
 *
 * A fix's changes apply in order: offsets of an edit index the text after the fix's earlier
 * changes, and a change after a rename names the new path. Compiling composes them into edits on
 * the text the scan read, so fixes can be compared with each other.
 */
import { compareStrings } from '../core/compare.js';
import { pathStatus } from '../core/paths.js';
import { decode } from '../core/text.js';
import type {
  DecodedText,
  FileChange,
  Fix,
  Snapshot,
  SourceFile,
  TextEdit,
} from '../core/types.js';
import { blockedDirectories, foldPath, parentDirectories, pathProblem } from './paths.js';
import { applyEdits, composeEdits, editProblem, roundTrips } from './text.js';

/** A file of the snapshot with its decoded text. */
export interface WorkspaceFile {
  readonly file: SourceFile;
  readonly decoded: DecodedText;
}

/** The snapshot as compiling reads it, with decoded texts and path indexes built once. */
export interface Workspace {
  readonly snapshot: Snapshot;
  file(path: string): WorkspaceFile | undefined;
  /** Paths in the snapshot, files and directories (without trailing `/`), case-folded. */
  readonly folded: ReadonlySet<string>;
  readonly blocked: ReadonlySet<string>;
}

/**
 * Builds a workspace. `decoded` supplies texts already decoded (the analysis' artifacts), so the
 * planner sees exactly the text the rules saw.
 */
export function createWorkspace(
  snapshot: Snapshot,
  decoded: (path: string) => DecodedText | undefined = () => undefined,
): Workspace {
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  const cache = new Map<string, WorkspaceFile>();
  const folded = new Set<string>();
  for (const path of snapshot.paths)
    folded.add(foldPath(path.endsWith('/') ? path.slice(0, -1) : path));
  for (const path of snapshot.ignoredFiles) folded.add(foldPath(path));
  return {
    snapshot,
    folded,
    blocked: blockedDirectories(snapshot),
    file(path) {
      const hit = cache.get(path);
      if (hit !== undefined) return hit;
      const file = files.get(path);
      if (file === undefined) return undefined;
      const entry = { file, decoded: decoded(path) ?? decode(file.bytes) };
      cache.set(path, entry);
      return entry;
    },
  };
}

/** What a fix does to one file the scan read. */
export interface CompiledFile {
  /** The file's path in the snapshot. */
  readonly origin: string;
  /** Its path after the fix: `origin` unless the fix renames it. */
  readonly path: string;
  /** Edits on the text the scan read: sorted, non-overlapping, at most one insertion per offset. */
  readonly edits: readonly TextEdit[];
  /** The fix re-encodes the file as UTF-8 without a byte order mark. */
  readonly reencode: boolean;
}

/** A file a fix creates, with its final text. */
export interface CompiledCreate {
  readonly path: string;
  readonly text: string;
}

export interface CompiledFix {
  /** Sorted by origin. */
  readonly files: readonly CompiledFile[];
  /** Sorted by path. */
  readonly creates: readonly CompiledCreate[];
}

/**
 * Why a fix cannot be compiled.
 * - `refused-path`: a path is not normalized or names something the fix may not touch: a file
 *   the scan did not read, a file reached through a symlink, a file whose bytes do not decode
 *   and encode back unchanged, or a create or rename target that exists or lies below a
 *   possible symlink. `guidance` is a manual step.
 * - `invalid`: the edits do not fit the text (out of range, overlapping, splitting a CRLF or a
 *   surrogate pair), or the fix changes a path it removed. A bug in the rule.
 */
export type CompileResult =
  | { readonly ok: true; readonly compiled: CompiledFix }
  | {
      readonly ok: false;
      readonly kind: 'refused-path' | 'invalid';
      readonly path: string;
      readonly guidance: string;
    };

interface State {
  readonly origin: string | undefined;
  text: string;
  edits: TextEdit[];
  reencode: boolean;
}

class CompileError extends Error {
  readonly kind: 'refused-path' | 'invalid';
  readonly path: string;

  constructor(kind: 'refused-path' | 'invalid', path: string, guidance: string) {
    super(guidance);
    this.kind = kind;
    this.path = path;
  }
}

function refuse(path: string, guidance: string): never {
  throw new CompileError('refused-path', path, guidance);
}

function checkTarget(workspace: Workspace, states: ReadonlyMap<string, State>, path: string): void {
  const problem = pathProblem(path);
  if (problem !== undefined) refuse(path, `${problem}; make this change by hand`);
  const folded = foldPath(path);
  const taken =
    workspace.folded.has(folded) ||
    [...states.keys()].some((key) => foldPath(key) === folded) ||
    pathStatus(workspace.snapshot, path) !== 'missing';
  if (taken) refuse(path, `${path} already exists or may exist; choose another name by hand`);
  for (const directory of parentDirectories(path)) {
    const name = directory.slice(0, -1);
    if (workspace.blocked.has(directory)) {
      refuse(
        path,
        `${directory} may be a symbolic link or was not scanned; make this change by hand`,
      );
    }
    if (workspace.snapshot.paths.has(name) || states.has(name)) {
      refuse(path, `${name} is a file, not a directory; make this change by hand`);
    }
  }
}

function load(
  workspace: Workspace,
  states: Map<string, State>,
  removed: ReadonlySet<string>,
  path: string,
): State {
  const known = states.get(path);
  if (known !== undefined) return known;
  if (removed.has(path))
    throw new CompileError('invalid', path, `the fix changes ${path} after moving it`);
  const problem = pathProblem(path);
  if (problem !== undefined) refuse(path, `${problem}; make this change by hand`);
  const entry = workspace.file(path);
  if (entry === undefined)
    refuse(path, `${path} was not read by the scan; make this change by hand`);
  if (entry.file.symlinkTarget !== undefined) {
    refuse(
      path,
      `${path} is reached through a symbolic link; edit ${entry.file.symlinkTarget} by hand`,
    );
  }
  if (!roundTrips(entry.file.bytes, entry.decoded)) {
    refuse(path, `${path} does not decode cleanly; fix its encoding first`);
  }
  const state: State = { origin: path, text: entry.decoded.text, edits: [], reencode: false };
  states.set(path, state);
  return state;
}

function applyChange(
  workspace: Workspace,
  states: Map<string, State>,
  removed: Set<string>,
  change: FileChange,
): void {
  switch (change.kind) {
    case 'edit': {
      const state = load(workspace, states, removed, change.path);
      const problem = editProblem(state.text, change.edits);
      if (problem !== undefined) throw new CompileError('invalid', change.path, problem);
      if (state.origin !== undefined) {
        const original = workspace.file(state.origin)?.decoded.text ?? '';
        state.edits = composeEdits(original, state.edits, change.edits);
      }
      state.text = applyEdits(state.text, change.edits);
      return;
    }
    case 'create': {
      checkTarget(workspace, states, change.path);
      states.set(change.path, { origin: undefined, text: change.text, edits: [], reencode: false });
      return;
    }
    case 'rename': {
      const state = load(workspace, states, removed, change.from);
      if (foldPath(change.from) === foldPath(change.to)) {
        refuse(change.to, `rename ${change.from} to ${change.to} by hand: only the case differs`);
      }
      checkTarget(workspace, states, change.to);
      states.delete(change.from);
      removed.add(change.from);
      states.set(change.to, state);
      return;
    }
    case 'encoding': {
      const state = load(workspace, states, removed, change.path);
      state.reencode = state.origin !== undefined;
      return;
    }
  }
}

/** Compiles `fix` against the workspace's snapshot. Never throws for a malformed fix. */
export function compileFix(fix: Fix, workspace: Workspace): CompileResult {
  const states = new Map<string, State>();
  const removed = new Set<string>();
  try {
    for (const change of fix.changes) applyChange(workspace, states, removed, change);
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    return { ok: false, kind: error.kind, path: error.path, guidance: error.message };
  }
  const files: CompiledFile[] = [];
  const creates: CompiledCreate[] = [];
  for (const [path, state] of states) {
    if (state.origin === undefined) creates.push({ path, text: state.text });
    else files.push({ origin: state.origin, path, edits: state.edits, reencode: state.reencode });
  }
  files.sort((a, b) => compareStrings(a.origin, b.origin));
  creates.sort((a, b) => compareStrings(a.path, b.path));
  return { ok: true, compiled: { files, creates } };
}

/** True when `a` and `b` touch the same file at the same place in a way order cannot settle. */
export type ConflictKind =
  'overlapping-edits' | 'same-offset-inserts' | 'same-target' | 'renamed-source';

function editConflict(
  a: readonly TextEdit[],
  b: readonly TextEdit[],
): 'overlapping-edits' | 'same-offset-inserts' | undefined {
  for (const x of a) {
    const xEnd = x.offset + x.length;
    for (const y of b) {
      if (x.offset === y.offset && x.length === y.length && x.text === y.text) continue;
      const yEnd = y.offset + y.length;
      if (x.length === 0 && y.length === 0 && x.offset === y.offset) return 'same-offset-inserts';
      if (x.offset < yEnd && y.offset < xEnd) return 'overlapping-edits';
    }
  }
  return undefined;
}

/** Paths a fix moves or creates something to, with what lands there. */
function targets(fix: CompiledFix): { path: string; identity: string }[] {
  return [
    ...fix.files
      .filter((file) => file.path !== file.origin)
      .map((file) => ({ path: file.path, identity: `rename\u0000${file.origin}` })),
    ...fix.creates.map((create) => ({ path: create.path, identity: `create\u0000${create.text}` })),
  ];
}

/**
 * Keys under which a fix can meet another in {@link conflictBetween}: the files it changes and,
 * case-folded, the paths it creates or moves files to. Fixes without a shared key never conflict.
 */
export function conflictKeys(fix: CompiledFix): string[] {
  return [
    ...fix.files.map((file) => `file\u0000${file.origin}`),
    ...targets(fix).map((target) => `target\u0000${foldPath(target.path)}`),
  ];
}

/**
 * The first reason `a` and `b` cannot both apply, with the path it concerns, or undefined when
 * they can. Identical edits, identical creates and identical renames are compatible: they merge.
 */
export function conflictBetween(
  a: CompiledFix,
  b: CompiledFix,
): { readonly kind: ConflictKind; readonly path: string } | undefined {
  const others = new Map(b.files.map((file) => [file.origin, file]));
  for (const file of a.files) {
    const other = others.get(file.origin);
    if (other === undefined) continue;
    const moves = file.path !== file.origin;
    const otherMoves = other.path !== other.origin;
    if ((moves || otherMoves) && file.path !== other.path) {
      return { kind: 'renamed-source', path: file.origin };
    }
    const kind = editConflict(file.edits, other.edits);
    if (kind !== undefined) return { kind, path: file.path };
  }
  const theirs = targets(b);
  for (const mine of targets(a)) {
    const folded = foldPath(mine.path);
    for (const other of theirs) {
      if (foldPath(other.path) !== folded) continue;
      if (other.path === mine.path && other.identity === mine.identity) continue;
      return { kind: 'same-target', path: mine.path };
    }
  }
  return undefined;
}
