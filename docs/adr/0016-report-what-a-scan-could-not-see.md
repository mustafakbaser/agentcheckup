# 0016. Report what a scan could not see

- Status: Accepted
- Date: 2026-11-14
- Amends: [0003](0003-treat-scanned-repositories-as-hostile.md), whose per-file limit was below
  what agents load and whose exclusions were silent, and
  [0007](0007-model-what-each-agent-loads.md), whose gate passed changes it could not see

## Context

A review of the walk's limits and exclusions on 2026-11-14 found scans that looked clean while
agent configuration went unchecked:

- **Entry limit.** The walk stops after 200,000 directory entries. Past it, `.claude/settings.json`
  with a `SessionStart` hook in a directory not yet listed passed `--gate security`: the inventory
  listed nothing incomplete.
- **File size.** Files over 1 MiB were skipped. Claude Code loads a `CLAUDE.md` of up to 4 MiB in
  full, so `--gate unicode` could not see hidden Unicode in a 1.2 MB file, and a 900 KB
  `AGENTS.md` got `instr/codex-size-budget` while a 1.1 MB one got nothing. Two 5 MB instruction
  files printed "No agent configuration files found." and `--format github` printed nothing.
- **Parser limits.** A settings file nested 513 levels deep, which `JSON.parse` reads, was
  listed as invalid JSON, so the gate treated its hooks as inert and passed them.
- **`.gitignore` and `--untrusted`.** `--untrusted` listed an ignored directory only when its
  own path was an agent configuration directory, so `packages/app/.mcp.json` below an ignored
  `packages/` stayed hidden, although the documentation promised the opposite.
- **Build and vendor directories.** `vendor/.mcp.json` and `build/.claude/skills/x/SKILL.md` were
  never listed, in any mode and without a word.
- **Trusted scans** hid gitignored agent configuration with no hint.

## Decision

A scan that could not see something never looks like a clean scan.

- **What could not be analyzed is an inventory entry** (`src/inventory/incomplete.ts`):
  `file-limit:<path>` where the walk stopped, `unlisted:<dir>/` for a directory it could not list,
  `unread:<path>` for an agent configuration file it did not read, `excluded:<path>` for one it
  left out on purpose, besides the existing plain paths and `invalid-json:`/`invalid-toml:`.
- **The gate fails closed on them**, labeled "Not analyzed". `file-limit:` and `unlisted:` trip
  every class whatever the baseline says, because anything may have been added there. `unread:`
  and `excluded:` trip `unicode` and the classes the file declares when they are new. A policy
  reports each entry as `unanalyzed-config`.
- **A parser limit is never a syntax error**, for JSON as for TOML: the file is not analyzed.
- **Every format says what the scan did not check** (`src/report/coverage.ts`): a note in
  stylish, Markdown and the `context` and `tokens` views, a warning or notice annotation in
  GitHub output, a SARIF tool notification, and `unscannedConfig` in JSON. Stylish says "No
  agent configuration files were checked" instead of "found" when it found some.
- **The per-file limit is 4 MiB**, the largest file an agent documents loading in full. The total
  budget stays 64 MiB, and read-ahead keeps its 1 MiB per file, so memory held by read-aheads
  does not grow.
- **`--untrusted` lists every directory**, ignored ones included, and reads the agent
  configuration in them; other ignored files stay unread. It also lists build output and
  vendored code (`vendor`, `dist`, `build`, `out`, `target`, `coverage`). Dependency, cache and
  version control directories (`node_modules`, `.venv`, `.git`, ...) stay unlisted in every
  mode: package managers write them, they are large in a working copy, and the documentation
  names them.
- **A trusted scan counts what it leaves out:** after the walk, a survey lists the gitignored and
  build directories, at most 20,000 entries, without reading a file or following a symlink, and
  records the agent configuration paths it finds.
- **The walk does not reorder itself** to reach agent configuration first. Nested configuration
  is found only by listing ordinary directories, so a priority pass would help the root alone,
  which breadth-first order already reaches early, and a stopped walk fails the gate anyway.

## Consequences

- A repository past 200,000 directory entries, or with a directory deeper than 32 levels, always
  fails `--gate`. The message names the limit; such repositories are far beyond the corpus.
- An untrusted scan of a working copy reads its gitignored and build directories: on a checkout
  with an 80-repository cache in a gitignored directory it took 15 to 30 s instead of 2 s. On a
  fresh checkout, where `--untrusted` belongs, those directories hold only committed files.
- The survey costs a trusted scan up to the time of listing 20,000 entries: 1 s on the same
  working copy, nothing measurable on the corpus.
- A baseline from before this change shows some entries as new once: see
  [Baselines and the gate](../context.md#baselines-and-the-gate).
- A change inside a file that was already not analyzed in the baseline does not trip the gate,
  as before: the entry carries no digest of what it cannot read.
