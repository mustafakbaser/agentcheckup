# Source drift

Every rule cites its evidence in `meta.sources`, with the date a maintainer last checked it.
Sources change: a platform raises a limit, renames a field or moves a page. The Source drift
workflow notices when a cited source changes, so the rules that cite it get re-checked.

## What runs

`.github/workflows/source-drift.yml` runs every Wednesday at 06:23 UTC, and on demand from the
Actions tab. It has two jobs:

1. **Check cited sources** runs `pnpm drift:check`, with read access only. The script fetches
   every URL that a built-in rule cites, and every source in `src/platforms/sources.ts`, which
   load plans and the security inventory cite by key (listed as used by "context loaders"). It
   normalizes the content, hashes it with SHA-256 and compares the hash with
   `scripts/drift/baseline.json`. The JSON report, which holds URLs, hashes and fetch errors but
   no text of the sources, becomes the `source-drift-report` artifact.
2. **Open or update issues** can write issues, so it installs nothing: Node.js runs
   `scripts/drift/sync-issues.ts` itself, through `scripts/drift/ts-hooks.ts`, and the script
   imports only Node.js built-ins (a test checks that). It opens one issue per changed source and
   one per moved source, labeled `source-drift`, and one issue that lists the sources it could
   not fetch.

A re-run does not open duplicates. It looks for a marker in the open `source-drift` issues. If a
source changed or moved again, it updates the issue and adds a comment. When every source can be
fetched again, it closes the issue for unreachable sources.

URLs into this repository are not checked. They change through pull requests here.

## Moved sources

The check follows redirects. When the request for a source ends at another URL, the source is
reported as **moved**, not as changed, whatever its content: the cited URL needs an update
either way. The report and the issue name the new location and say whether the content also
changed since the baseline. Requests that carry the GitHub token never follow a redirect; a
renamed repository is reported as unreachable instead.

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
"Last updated" date. [Next](#next) proposes hashing the cited section only.

## Seeing what changed

The baseline holds hashes only, so it cannot show what changed. `pnpm drift:check` and
`pnpm drift:update` also keep the normalized text of every source they fetch in `.drift-cache/`,
one file per version of a source's text: `.drift-cache/<SHA-256 of the URL>/<SHA-256 of the
text>.txt`, and `url.txt` with the URL. A version is never overwritten, so the text behind the
baseline's hash stays there once this machine has fetched it.

```sh
pnpm drift:diff https://code.claude.com/docs/en/memory
```

fetches the source and prints a unified diff from the cached text with the baseline's hash to the
current text. Without that text, it diffs from the newest other cached version and says so. The
visible text of an HTML page is one long line after normalizing, so the diff breaks long lines
after each sentence. The cache is third-party content: `.drift-cache/` is gitignored, and no
report, artifact or issue includes any of it. Delete the directory to start over.

Run `pnpm drift:check` now and then, so the cache holds a version from before a source changes.

## When an issue opens

1. Re-read the source. For GitHub files, the issue links the file's commit history. For other
   sources, `pnpm drift:diff <url>` shows what changed when your cache has the earlier text.
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

For a moved source: check that the new location is the same document and still says what the
rules rely on, replace the URL in the rules' sources and bump their `checked` dates, then run
`pnpm drift:update --only <new url>`. A redirect to a general page, a login or another product
usually means the cited content is gone; handle it as a changed source.

For an unreachable source: if the page moved, update the URL in the rules' sources, re-read it,
and run `pnpm drift:update --only <new url>`. A temporary outage needs nothing.

The old URL stays in the baseline until a full `pnpm drift:update`, which drops entries no rule
cites; the report lists them as no longer cited.

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
| `pnpm drift:diff <url>`          | Prints what changed in one source's text since the baseline    |

Exit codes: 0 when nothing changed, 1 when a source changed, moved, is new or could not be
fetched, 2 for a usage error or an unreadable baseline. `drift:diff` exits 0 when it printed a
diff or found no change, and 1 when it cannot fetch the source or has no earlier text of it.

None of these commands is part of `pnpm check`, because they need the network. Tests for the
scripts run without it.

## Next

Hashing whole pages makes most issues noise: a change anywhere on a page opens an issue, and the
76 issues open on 2026-10-30 were never closed, 37 of them with "changed again" comments. A
proposal, not implemented:

- **Section fingerprints.** A source in `meta.sources` or `src/platforms/sources.ts` may name
  the part a rule relies on: `section`, a heading or an anchor such as `#import-additional-files`.
  The check hashes that section of the normalized text, from its heading to the next heading of
  the same level, and the baseline stores one hash per URL and section. A change elsewhere on
  the page does not open an issue, and the issue names the sections that changed. A section the
  page no longer has is reported as such, like a moved source.
- **Fact probes.** A source may also list `expects`: short phrases the cited text must contain,
  such as `"5 hops"` or `"32 KiB"`, matched after normalizing whitespace and case. A missing
  phrase opens an issue that names it, whether or not the hash changed, so a limit that changed
  inside an otherwise stable section is caught, and wording changes around it are not.
- **Quieter issues.** With section hashes, an issue that only saw changes outside the cited
  sections could be closed by the workflow, and the baseline updated for those pages in a
  pull request for a maintainer to approve.

The cost is metadata on every source and a parser for headings in Markdown and in the
normalized text of HTML pages, which has no headings today: normalizing would have to keep them.
