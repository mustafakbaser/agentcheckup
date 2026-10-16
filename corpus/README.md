# Real-world corpus

agentcheckup is only credible if it stays quiet on configurations that work. This directory pins
80 public GitHub repositories that ship agent configuration (skill collections, plugin
marketplaces, and well-known projects with `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, Copilot
instructions, `.mcp.json` and hooks, including monorepos with nested `AGENTS.md`). The harness
scans each one at a fixed commit with every built-in rule, so the false-positive rate of the rule
set can be measured and compared across changes.

| File                     | Committed | What it is                                                                                                           |
| ------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------- |
| [repos.json](repos.json) | yes       | The corpus: `{ repo, sha, why }` per repository, sorted by `repo`                                                    |
| [SUMMARY.md](SUMMARY.md) | yes       | Aggregate statistics: what agents load, artifacts, findings by rule, scores                                          |
| `results.json`           | no        | Per repository: artifacts, score, finding counts by rule and severity                                                |
| `REPORT.md`              | no        | Per-rule sample findings (repository, path, line, message) for FP review                                             |
| `golden.json`            | no        | Every finding per repository, for checking that a refactor changes none                                              |
| `scripts/corpus/`        | yes       | `fetch.ts`, `run.ts`, `golden.ts`, `pin.ts`, `consistency.ts`, `context-stats.ts`, and the walk emulation they share |

Publication policy: following [ADR 0005](../docs/adr/0005-scoring.md), only aggregate statistics
are committed (`SUMMARY.md`); per-repository results (`results.json`, `REPORT.md`, `golden.json`)
are gitignored local review artifacts, so this repository never publishes a ranking of other
people's projects.

## Running it

Requires the [GitHub CLI](https://cli.github.com/), logged in (`gh auth login`). Nothing is
cloned.

```sh
npx tsx scripts/corpus/fetch.ts && npx tsx scripts/corpus/run.ts
```

- `fetch.ts` downloads into `.corpus-cache/` (gitignored). It is resumable: files already cached
  and verified are skipped, so a second run makes no requests. Options: `--only owner/name`
  (repeatable), `--trees-only` (no file contents, prints candidate counts per kind), and
  `--reserve N` (default 1000): when fewer than `N` REST or GraphQL requests are left in the
  hourly quota, it waits for the reset instead of using up a quota shared with everything else
  logged in to `gh`.
- `run.ts` rewrites `SUMMARY.md`, `results.json` and `REPORT.md`. It exits 1 when a rule threw on any
  repository (a crash on real input is a bug in the rule; the crashes are listed) and 2 when the
  cache is incomplete. `--only owner/name` prints that repository's findings instead and writes
  nothing.
- Without options, `run.ts` also plans every repository as `agentcheckup context --matrix` does
  and builds the inventory, for the "What agents load" section of `SUMMARY.md`
  ([context-stats.ts](../scripts/corpus/context-stats.ts)). That section adds counts up across the
  corpus and names no repository, path or server. A loader that throws makes `run.ts` exit 1, like
  a rule crash.
- `run.ts --consistency` plans every repository the same way and checks the plans against the
  findings, as `test/platforms/load/consistency.test.ts` does on fixtures: every file a plan
  skips because of a problem must have its finding, and every loading finding its skip. It prints
  the mismatches grouped by rule, writes nothing, and exits 1 if there is any mismatch or a loader
  crash. It combines with `--only` and `--check-golden`.
- `run.ts --write-golden` scans the whole corpus and writes only `golden.json`: for each
  repository, every finding as rule id, path, range, severity, fingerprint and a hash of the
  message, sorted. `run.ts --check-golden` scans again, compares with `golden.json` and writes
  nothing. It prints each difference grouped by repository and rule (`-` only in `golden.json`,
  `+` only in the new scan, with its message) and exits 1 if there is any, 2 if `golden.json` does
  not exist. With `--only owner/name` it compares only those repositories.
- `run.ts --check-golden --ignore-fingerprints` compares every field except the fingerprint, and
  counts by rule the findings whose fingerprint alone changed. Use it for a deliberate change of
  the fingerprint scheme (`FINGERPRINT_VERSION` in `src/core/meta.ts`): it must report no other
  difference. Then write `golden.json` again on the new scheme with `--write-golden`.

A full fetch takes about 5 minutes and costs about 190 REST requests (one tree per repository,
plus per-directory listings for the two trees GitHub truncates) and about 300 GraphQL queries
(file contents and symlink texts, 40 per query).

### Checking that a refactor changes no finding

Write the golden file on the base commit, then check the change against it:

```sh
git switch main && npx tsx scripts/corpus/run.ts --write-golden
git switch my-refactor && npx tsx scripts/corpus/run.ts --check-golden
```

A difference is either a bug in the refactor or an intended change that belongs in its own pull
request. The check takes under a minute. It needs the local cache, so it is a manual step before
merging, not part of CI. In CI, `test/core/golden.test.ts` compares complete JSON reports of two
committed fixtures instead.

## How it works

1. `fetch.ts` reads the recursive git tree at the pinned commit
   (`repos/{repo}/git/trees/{sha}?recursive=1`). When GitHub truncates the listing (over 100 000
   entries), each directory level is listed separately; directories the walker never enters
   (`node_modules`, `vendor`, ...) are not descended into.
2. It replays `src/io/walk.ts` over that listing
   ([virtual-walk.ts](../scripts/corpus/virtual-walk.ts), using the walker's own policies from
   `src/io/filters.ts` and `src/io/submodules.ts`) and downloads only what the walker would read:
   paths `defaultIsCandidate()` accepts, outside hard-excluded directories, up to 1 MiB each, plus
   the root `.gitmodules` and the text of every symlink the walk reaches. The files the walker's
   import pass reads (`src/io/imports.ts`: imported README.md and similar) depend on the bytes of
   the files that import them, so they are fetched afterwards in rounds, one hop deeper each. Contents are fetched by object id in batches of 40 through GraphQL and verified
   against the git object id, so the bytes are exact (BOM, encoding and line endings included);
   anything that is not valid UTF-8 is re-fetched as base64 through the REST blob endpoint.
3. `run.ts` builds the same `Snapshot` the CLI would build from a checkout: `files` are the
   downloaded blobs, `paths` every listed path plus its parent directories (with a trailing
   `/`), `opaqueDirectories` the hard-excluded directories that exist, and symlinks (mode
   `120000`) are resolved inside the tree like `src/io/resolve.ts` does, setting `symlinkTarget`
   and never following anything outside the repository. The import pass is replayed with the
   walker's planner and caps; imported files missing from an older cache are listed as a warning
   and stay unread (run `fetch.ts` again to add them). It then calls `scanSnapshot` with
   `builtinRules`, every platform targeted and inline suppressions ignored (`--untrusted`).

Differences from scanning a checkout, all deliberate:

- `.gitignore` is not applied (`ignoredFiles` is empty) and `gitignoreApplied` is `true`: every
  file in the tree is committed, which is what rules about gitignored files check.
- A submodule (gitlink) is never checked out from a tree, so it is always opaque; paths declared
  in the root `.gitmodules` otherwise get the walker's treatment (`src/io/submodules.ts`).
- Absolute symlink targets count as outside the repository, because the checkout location is
  not known.
- If GitHub cannot list a directory completely, the snapshot records a `file-limit` skip, so
  missing paths are "unknown" rather than "missing", as after a walk cut short by its limits.

Cache layout, per repository: `.corpus-cache/<owner>__<name>@<sha>/` holds `tree.json` (the path
list), `links.json` (symlink texts), `files/<path>` (blobs at their repository path), and
`files.json` (index of verified blobs). A path that would collide with another one on a
case-insensitive file system is stored as `blobs/<object id>` instead.

## Safety

The cache is untrusted third-party content. The harness only writes and reads it as bytes: it
never executes, imports or renders anything from it, and never runs `git` in it. `gh` is started
with `execFile` and an argument array (no shell); GraphQL variables travel in a JSON request
body. Tree paths are checked component by component before anything is written, so a hostile
path cannot escape the cache directory. Text that ends up in `REPORT.md`, `results.json`,
`golden.json` or the terminal goes through agentcheckup's own output sanitizers (`forMarkdown`,
`forJsonOutput`, `forTerminal`).

## Licensing

Only repository names and commit SHAs (`repos.json`) and aggregate statistics (`SUMMARY.md`) are
committed here. No third-party file content is stored in this repository or
redistributed; it is fetched on demand into the gitignored cache. Permissive licenses were
preferred when choosing repositories, but the corpus does not depend on them.

## Maintaining the corpus

- Add a repository: add `{ "repo": "owner/name", "sha": "", "why": "..." }` to `repos.json` and
  run `npx tsx scripts/corpus/pin.ts`, which pins entries with an empty `sha` to the default
  branch's current HEAD and keeps the file sorted.
- Re-pin: `npx tsx scripts/corpus/pin.ts --all` (or `--only owner/name`). This changes results,
  so do it in its own commit, separately from rule changes.
- Review: after a rule change, run both scripts, read the diff of `results.json`, and go through
  the samples in `REPORT.md` under "Top suspects for false positives". A finding on a
  configuration that works as intended is a false positive: fix the rule (and add the case to
  its tests as an input that must not be reported).
