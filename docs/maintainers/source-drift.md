# Source drift

Every rule cites its evidence in `meta.sources`, with the date a maintainer last checked it.
Sources change: a platform raises a limit, renames a field or moves a page. The Source drift
workflow notices when a cited source changes, so the rules that cite it get re-checked.

## What runs

`.github/workflows/source-drift.yml` runs every Wednesday at 06:23 UTC, and on demand from the
Actions tab. It:

1. runs `pnpm drift:check`. The script fetches every URL that a built-in rule cites, and every
   source in `src/platforms/sources.ts`, which load plans and the security inventory cite by key
   (listed as used by "context loaders"). It normalizes the content, hashes it with SHA-256 and
   compares the hash with `scripts/drift/baseline.json`;
2. opens one issue per changed source, labeled `source-drift`, and one issue that lists the
   sources it could not fetch.

A re-run does not open duplicates. It looks for a marker in the open `source-drift` issues. If a
source changed again, it updates the issue and adds a comment. When every source can be fetched
again, it closes the issue for unreachable sources.

URLs into this repository are not checked. They change through pull requests here.

## How sources are read

- **GitHub files** (`github.com/<owner>/<repo>/blob/<branch>/<path>`): the file at the head of
  the branch. With `GITHUB_TOKEN` set, through the REST API; otherwise from
  raw.githubusercontent.com. Both return the same bytes.
- **Documentation sites that publish Markdown**, such as Claude Code, Codex, Cursor, Gemini CLI
  and GitHub Docs: the Markdown version of the page. RFCs: the plain-text version. The hosts are
  listed in `scripts/drift/resolve.ts`. If one of them stops serving Markdown, its sources are
  reported as unreachable, not as changed.
- **github.blog**: the post's title and body from the WordPress REST API, without the lists of
  recent and related posts around it.
- **Other pages**: the visible text. Script, style, navigation, header and footer content is
  dropped, tags are removed and whitespace is collapsed. When a page has exactly one `<main>`
  element, only its content counts.

Each request has a 30-second timeout. Timeouts, network errors and server errors get up to 3
attempts.

The hash covers the whole page, not only the part a rule relies on, so a change anywhere on the
page opens an issue. Some pages change more often than the part a rule cites: the ECMAScript
page includes the table of contents of the whole specification, and Google Cloud pages show a
"Last updated" date.

## When an issue opens

1. Re-read the source. For GitHub files, the issue links the file's commit history.
2. Compare it with each rule the issue lists: its message, rationale, severity and tests. For
   "context loaders", compare it with the loaders in `src/platforms/load` and the inventory in
   `src/inventory` that cite the source.
3. If the behavior changed, update the rule and its tests, then run `pnpm docs:generate`. If it
   did not, bump the `checked` date of that source in the rule's metadata.
4. In the same pull request, run `pnpm drift:update --only <url>` and commit
   `scripts/drift/baseline.json`.
5. Reference the issue in the pull request, so that merging it closes the issue.

`--only` limits the update to the sources you re-read. Without it, `pnpm drift:update` records
the current hash of every source, including sources nobody has re-read. The script never
changes `checked` dates.

For an unreachable source: if the page moved, update the URL in the rules' sources, re-read it,
and run `pnpm drift:update --only <new url>`. A temporary outage needs nothing.

## Adding a source

A URL that is not in the baseline yet is reported as changed, with no baseline hash. Run
`pnpm drift:update --only <url>` in the pull request that adds the source, or handle the issue
the next weekly run opens.

## Commands

| Command                          | What it does                                                   |
| -------------------------------- | -------------------------------------------------------------- |
| `pnpm drift:check`               | Checks every source and prints a report                        |
| `pnpm drift:check --format json` | The same report as JSON                                        |
| `pnpm drift:check --only <url>`  | Checks one source; repeat `--only` for more                    |
| `pnpm drift:update --only <url>` | Records the current hash of one source                         |
| `pnpm drift:update`              | Records every current hash and drops entries no rule cites now |

Exit codes: 0 when nothing changed, 1 when a source changed, is new or could not be fetched,
2 for a usage error or an unreadable baseline.

Neither command is part of `pnpm check`, because both need the network. Tests for the script
run without it.
