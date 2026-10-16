/**
 * Applies a plan to a snapshot in memory. Pure: returns a new Snapshot and leaves the input as it
 * was; src/io/write-fix.ts is the only code that writes to disk.
 *
 * Encoding (docs/adr/0008-write-fixes-to-the-scanned-repository.md): edits apply to the decoded
 * text, which is encoded again with the file's own encoding and byte order mark. Line breaks in
 * new text take the file's line ending; in a file with mixed endings, the ending of the line the
 * edit is on, for an edit within a line or an insertion. The file keeps its final newline, or its
 * lack of one. Files with decoding errors, or whose bytes do not survive decoding and encoding
 * unchanged, are never edited.
 */
import { compareStrings } from '../core/compare.js';
import type { DecodedText, Snapshot, SourceFile, TextEdit } from '../core/types.js';
import { type CompiledFix, compileFix, conflictBetween, createWorkspace } from './compile.js';
import type { FixPlan } from './index.js';
import { parentDirectories } from './paths.js';
import {
  applyEdits,
  compareEdits,
  editProblem,
  eolNear,
  hasLineBreak,
  sameEdit,
  withEol,
  encodeChecked,
} from './text.js';

/**
 * A plan that cannot be applied as given: a fix that does not compile against the snapshot, two
 * fixes that conflict, or text that cannot be encoded in the file's encoding. Plans from
 * `planFixes` for the same snapshot never cause it.
 */
export class FixApplyError extends Error {
  /** The path concerned. */
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'FixApplyError';
    this.path = path;
  }
}

/** The changes of every fix to one existing file, merged. */
interface FileMerge {
  path: string;
  readonly edits: TextEdit[];
  reencode: boolean;
}

/** New text for an edit's line breaks, as the module comment describes. */
function editText(decoded: DecodedText, edit: TextEdit): string {
  switch (decoded.lineEnding) {
    case 'lf':
      return withEol(edit.text, '\n');
    case 'crlf':
      return withEol(edit.text, '\r\n');
    case 'mixed': {
      const replaced = decoded.text.slice(edit.offset, edit.offset + edit.length);
      return hasLineBreak(replaced) ? edit.text : withEol(edit.text, eolNear(decoded, edit.offset));
    }
    case 'none':
      return edit.text;
  }
}

/**
 * The file's text after `edits` (sorted, non-overlapping), with its line endings and final
 * newline kept. Edits that change nothing are dropped first, so the text of a no-op stays
 * identical.
 */
export function editedText(decoded: DecodedText, edits: readonly TextEdit[]): string {
  const original = decoded.text;
  const effective = edits
    .filter((edit) => original.slice(edit.offset, edit.offset + edit.length) !== edit.text)
    .map((edit) => ({ ...edit, text: editText(decoded, edit) }));
  if (effective.length === 0) return original;
  const text = applyEdits(original, effective);
  if (original.length === 0 || text.length === 0) return text;
  const had = original.endsWith('\n');
  const has = text.endsWith('\n');
  if (had && !has) return `${text}${original.endsWith('\r\n') ? '\r\n' : '\n'}`;
  if (!had && has) return text.slice(0, text.endsWith('\r\n') ? -2 : -1);
  return text;
}

function merge(compiled: readonly CompiledFix[]): {
  files: Map<string, FileMerge>;
  creates: Map<string, string>;
} {
  const files = new Map<string, FileMerge>();
  const creates = new Map<string, string>();
  for (const fix of compiled) {
    for (const file of fix.files) {
      let entry = files.get(file.origin);
      if (entry === undefined) {
        entry = { path: file.path, edits: [], reencode: false };
        files.set(file.origin, entry);
      }
      if (file.path !== file.origin) entry.path = file.path;
      entry.reencode ||= file.reencode;
      for (const edit of file.edits) {
        if (!entry.edits.some((known) => sameEdit(known, edit))) entry.edits.push(edit);
      }
    }
    for (const create of fix.creates) creates.set(create.path, create.text);
  }
  for (const entry of files.values()) entry.edits.sort(compareEdits);
  return { files, creates };
}

function addParents(paths: Set<string>, path: string): void {
  for (const directory of parentDirectories(path)) paths.add(directory);
}

/**
 * Applies every fix of `plan` with status `planned` to `snapshot` and returns the new snapshot:
 * edited files get new bytes, renamed files a new path, created files are added, and `paths`
 * lists the new paths and their directories. Files a plan does not change keep their
 * SourceFile objects, byte for byte. A changed file loses its `identity` (it no longer matches
 * the bytes on disk) and a renamed one its `imported` flag. Directories are never removed.
 *
 * Throws {@link FixApplyError} for a plan that does not fit the snapshot.
 */
export function applyPlan(snapshot: Snapshot, plan: Pick<FixPlan, 'fixes'>): Snapshot {
  const planned = plan.fixes.filter((item) => item.status === 'planned');
  if (planned.length === 0) return snapshot;
  const workspace = createWorkspace(snapshot);
  const compiled: CompiledFix[] = [];
  for (const item of planned) {
    const outcome = compileFix(item.fix, workspace);
    if (!outcome.ok) throw new FixApplyError(outcome.path, `${item.fix.id}: ${outcome.guidance}`);
    for (const other of compiled) {
      const conflict = conflictBetween(outcome.compiled, other);
      if (conflict !== undefined) {
        throw new FixApplyError(
          conflict.path,
          `${item.fix.id}: ${conflict.kind} on ${conflict.path}`,
        );
      }
    }
    compiled.push(outcome.compiled);
  }
  const { files: merged, creates } = merge(compiled);

  const paths = new Set(snapshot.paths);
  const gitignoredConfig =
    snapshot.gitignoredConfig === undefined ? undefined : new Set(snapshot.gitignoredConfig);
  const files: SourceFile[] = [];
  for (const file of snapshot.files) {
    const change = merged.get(file.path);
    if (change === undefined) {
      files.push(file);
      continue;
    }
    const entry = workspace.file(file.path);
    if (entry === undefined)
      throw new FixApplyError(file.path, `${file.path} is not in the snapshot`);
    const { decoded } = entry;
    const problem = editProblem(decoded.text, change.edits);
    if (problem !== undefined) throw new FixApplyError(file.path, `${file.path}: ${problem}`);
    const text = editedText(decoded, change.edits);
    const renamed = change.path !== file.path;
    if (text === decoded.text && !change.reencode && !renamed) {
      files.push(file);
      continue;
    }
    const encoding = change.reencode ? 'utf-8' : decoded.encoding;
    const bom = change.reencode ? false : decoded.hasBom;
    const bytes =
      text === decoded.text && !change.reencode ? file.bytes : encodeChecked(text, encoding, bom);
    if (bytes === undefined) {
      throw new FixApplyError(
        file.path,
        `${file.path}: the new text cannot be encoded as ${encoding}`,
      );
    }
    files.push({
      path: change.path,
      bytes,
      ...(file.imported === true && !renamed ? { imported: true } : {}),
    });
    if (renamed) {
      paths.delete(file.path);
      paths.add(change.path);
      addParents(paths, change.path);
      if (gitignoredConfig?.delete(file.path) === true) gitignoredConfig.add(change.path);
    }
  }
  for (const [path, text] of creates) {
    const bytes = encodeChecked(text, 'utf-8', false);
    if (bytes === undefined)
      throw new FixApplyError(path, `${path}: the text cannot be encoded as utf-8`);
    files.push({ path, bytes });
    paths.add(path);
    addParents(paths, path);
  }
  files.sort((a, b) => compareStrings(a.path, b.path));
  return {
    ...snapshot,
    files,
    paths,
    ...(gitignoredConfig === undefined ? {} : { gitignoredConfig }),
  };
}
