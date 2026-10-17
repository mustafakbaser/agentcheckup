# 0008. Write fixes to the scanned repository

- Status: Accepted
- Date: 2026-10-16
- Amended by: [0010](0010-fixes-beyond-deterministic-edits.md), which adds fixes that need the
  user's words, moved content, a guard against losing risk findings and `skill install`

## Context

Many findings have one correct repair that users now make by hand: add `@AGENTS.md` to a
`CLAUDE.md`, rename a Cursor rule to `.mdc`, add `"type"` to an MCP server. `agentcheckup fix`
makes these repairs for the user.

Until now agentcheckup only read. [ADR 0003](0003-treat-scanned-repositories-as-hostile.md)
assumes the scanned repository is hostile and relies on reading only.
[ADR 0006](0006-scope-for-the-first-release.md) limited the first release to static analysis,
and [ADR 0007](0007-model-what-each-agent-loads.md) left autofix out of scope. Once
agentcheckup writes, a hostile repository can try to control where it writes and what. The
threats:

- Path escape: a symlinked file or directory (`CLAUDE.md` → `~/.bashrc`, `.claude` → `/etc`), a
  name derived from file content (`name: ../../.ssh/x`), `..`, absolute paths, NUL, Windows
  device names (`aux.md`) and trailing dots.
- Writing through a FIFO, a device or a hard link.
- A file or directory swapped between the scan and the write.
- Content injection: copied text that breaks YAML, JSON or Markdown (a newline followed by
  `allowed-tools: Bash`), or that carries hidden Unicode.
- A privilege change disguised as a fix: activating an MCP server, a hook, a permission or an
  environment override.
- Diff output that injects terminal escapes or workflow commands, or leaks a credential.
- Resource exhaustion.

## Decision

- **One writer.** Only `agentcheckup fix --write` and `agentcheckup fix -i` write, and only
  through `src/io/write-fix.ts`. Scans, `context` and the `scan()` API stay read-only. Without
  `--write`, `fix` is a dry run that prints the diff and exits 1 when it would change anything.
- **Confinement.** Targets are normalized paths relative to the root. Each path component,
  checked with `lstat` from the real root, must be a directory and not a symlink. The target
  must be absent (create, rename), or a regular file whose device and inode match what the
  walk recorded (`SourceFile.identity`). Missing parent directories are created one at a time;
  if one appears in the meantime, it must be a real directory. Windows reserved names are
  refused.
- **Integrity.** Just before writing, the SHA-256 of the file's current bytes must equal that of
  the scanned bytes. Otherwise the fix is skipped as "changed since the scan".
- **Atomic writes.** The new content goes to a temporary file in the target directory, opened
  with `O_CREAT | O_EXCL | O_NOFOLLOW` and given the original mode bits, then written and
  synced with `fsync`. Identity and hash are checked again, `rename()` replaces the file, and
  the directory is synced, as `writeOutputFile` does for reports.
- **No overwrites.** Creates and renames use `link()`, which fails when the target exists, and
  then `unlink()`. Where `link()` is not supported, the fix is refused.
- **Atomic per fix.** If one step of a multi-file fix fails, the completed steps are rolled
  back from the original contents held in memory.
- **Not in this version:** deletions, directory renames, case-only renames and git operations.
- **Nothing runs.** agentcheckup runs no git, hooks, formatters, package managers or editors.
  It prints commands such as `git mv` for the user to run.
- **Untrusted input.** `--untrusted` allows only a dry run, and the GitHub Action never writes.
- **Encoding.** Edits apply to the decoded text, which is encoded again with the file's own
  encoding, byte order mark, line endings and final newline. A new line in a file with mixed
  endings takes its neighbor's. Files with decoding errors, or whose bytes do not survive
  decoding and encoding unchanged, are never edited.
- **Copied content.** Text copied from the repository must be one line, bounded in length, and
  free of control, bidirectional and tag characters. It is written as a quoted YAML or JSON
  string. Names derived from content must match `[a-z0-9-]{1,64}`.
- **Two classes.** A fix is `safe` when it is deterministic, has one correct form, keeps the
  author's prose, passes a new scan with no new error or warning, and adds or changes no item
  that a `--gate` class flags. `--write` applies only safe fixes. Every other fix is `review`,
  applied with `--write --review` or when accepted in `-i`. A fix that activates or changes an
  MCP server, hook, permission or environment override is always `review`. A finding without a
  fix is left to the user, with a manual step where the rule can name one.
- **Credentials.** Fixes for `mcp/literal-secret` apply only when the user names the rule or
  accepts the fix in `-i`, never in pull request suggestions, and come with a warning to
  rotate the credential.
- **Verification.** Fixes are first applied to an in-memory copy, which is scanned again, for
  up to 3 rounds. Each fix must remove its findings and add no new error or warning; a fix that
  fails is dropped. After `--write`, the files are walked and scanned again from disk.
- **Output.** Diffs and JSON output go through the existing sanitizers. Credential values are
  redacted everywhere, and paths are never absolute.
- **Bounds.** At most 3 rounds, 1,000 fixes per run and 1 MiB per written file.
- **Contract.** Rules attach a `Fix` to a finding: a class, a title and a list of file changes
  (`edit`, `create`, `rename`, `encoding`). They never write. `RuleMeta.fix` lists the classes
  a rule can produce. The report's `fix` field changes shape within schema version 1, which was
  never published, and `fix --format json` follows `schemas/fix.schema.json`.

## Consequences

- Node.js has no `openat()` or `renameat2()`. A local process that swaps a directory between
  the final check and the rename can still redirect the write. This is out of scope, the same
  limit the walker documents.
- A wrong edit costs more trust than a missed finding. The dry run is the default, every fix is
  checked by a new scan, and a replay over the corpus checks that fixes resolve their findings,
  add none, and leave nothing to fix on a second run.
- A safe fix still changes behavior, for example how many tokens an agent loads at session
  start. Every fix prints its effect, and suppressing a finding keeps its fix from being
  applied.
- Some git behavior is outside our control: symlink checkout mode, case-only renames and line
  ending conversion. agentcheckup keeps the line endings it finds on disk, and prints git
  commands such as `git mv` for the user instead of running them.
- On Windows, `link()` fails on FAT and some network drives, so creates and renames are
  refused there. Editors and antivirus software can hold files open and make a write fail.
- Rules that offer fixes need tests that the fix is correct, that a second run changes nothing,
  and that hostile input cannot steer it.
