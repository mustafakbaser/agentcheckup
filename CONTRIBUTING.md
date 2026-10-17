# Contributing to agentcheckup

Thanks for helping. The most valuable contributions, in order:

1. **False-positive reports** with a minimal file that reproduces them.
2. **Evidence** that an agent loads a file differently than a rule assumes: a documentation link,
   a source code reference, or a reproduction.
3. **New rules** backed by that kind of evidence.
4. Fixes and features from the [issue tracker](https://github.com/mustafakbaser/agentcheckup/issues).

For anything larger than a small fix, open an issue or discussion first so we can agree on the
approach before you write code.

## Setup

You need Node.js 22.12 or newer and pnpm 12.

```sh
git clone https://github.com/mustafakbaser/agentcheckup.git
cd agentcheckup
corepack enable          # or: npm install --global pnpm@12
pnpm install
pnpm check               # format, lint, types, tests, build: what CI runs
```

Useful commands:

| Command                     | What it does                                                  |
| --------------------------- | ------------------------------------------------------------- |
| `pnpm test`                 | Run the test suite once                                       |
| `pnpm test:watch`           | Re-run tests on change                                        |
| `pnpm coverage`             | Tests with a coverage report in `coverage/`                   |
| `pnpm lint` / `pnpm format` | ESLint / Prettier                                             |
| `pnpm build`                | Bundle to `dist/`                                             |
| `pnpm docs:generate`        | Regenerate rule docs and the config schema from rule metadata |
| `pnpm smoke`                | Pack the package and run the packed CLI against test fixtures |
| `node dist/cli.js <path>`   | Run your local build                                          |

## How the code is organized

```text
src/
  core/        engine, config, scoring, baseline comparison, suppressions (pure)
  parse/       hardened YAML frontmatter, Markdown, imports, JSON          (pure)
  platforms/   which files each agent reads, and where                     (pure)
    load/      load plans: what one agent loads for one working directory  (pure)
  inventory/   MCP servers, hooks, permissions and env overrides           (pure)
  rules/       one file per rule, grouped by family                        (pure)
  fix/         plan, apply and verify fixes on a copy in memory            (pure)
  report/      stylish, JSON, SARIF, GitHub, Markdown, context, fix output (pure)
  io/          the only code that touches the file system; write-fix.ts is the only writer
  cli/         argument parsing and process handling
scripts/
  corpus/      the real-world corpus harness (see corpus/README.md)
  drift/       the weekly check of cited sources
```

"Pure" directories cannot import `node:fs`, `node:process` and similar modules. ESLint enforces
this. The boundary keeps the core usable in a browser or editor, and keeps file access in one
reviewed place. The reasoning is in [docs/adr](docs/adr/README.md).

agentcheckup scans repositories that may be hostile. When you touch parsing, file access or
output, read [ADR 0003](docs/adr/0003-treat-scanned-repositories-as-hostile.md) first, and
[ADR 0008](docs/adr/0008-write-fixes-to-the-scanned-repository.md) when you touch fixes.

## Adding a rule

Every rule needs evidence. A rule may be an `error` only if a platform's documented behavior
skips, ignores, truncates or breaks the file. Behavior you could not verify can only be `info`.
See [ADR 0004](docs/adr/0004-evidence-backed-rules.md).

1. **Find the evidence.** Link official documentation or source code. Note the date you checked
   it. Add it to `src/platforms/sources.ts` if it is not there yet.
2. **Write the rule** in `src/rules/<family>/<name>.ts` with `defineRule`. Use the parsed views
   on the context (`context.frontmatter(artifact)`, `context.markdown(artifact)`,
   `context.json(artifact)`); never parse raw text yourself.
3. **Write the message** as one or two sentences: what is wrong, then what the agent does as a
   result. For example: `AGENTS.md files on the path to this directory total 41,207 bytes. Codex
stops reading at 32,768 bytes, so the rest of this file is ignored.`
4. **Register it** in `src/rules/<family>/index.ts`.
5. **Test it** in `test/rules/<family>/<name>.test.ts` with the `lint()` helper. Include cases
   that must be reported, cases that must not (the false-positive guard), and edge cases:
   CRLF, BOM, non-ASCII text, empty files.
6. **Regenerate docs** with `pnpm docs:generate` and commit the result.

Rule ids are permanent. Never rename or reuse one; deprecate it instead.

## Adding a fix to a rule

A wrong edit costs more trust than a missed finding, so a fix needs the same care as the rule.
Rules only describe fixes: `src/fix` plans, applies and verifies them in memory, and
`src/io/write-fix.ts` writes them. See [Fixing findings](docs/fix.md) for what users see.

1. **Declare it** in the rule's metadata: `fix: { classes: ['safe'], summary: '...' }`. List
   every class the rule can attach. The summary is one sentence on what the fix does; the rule
   page, `explain` and [docs/fix.md](docs/fix.md#rules-with-fixes) show it.
2. **Attach it** to the finding with `context.report({ artifact, message, fix })`. A fix has an
   `id` (`<rule id>#<variant>`), a `class`, a one-line `title`, and `changes`:

   ```ts
   context.report({
     artifact,
     message,
     fix: {
       id: `${RULE_ID}#import`,
       class: 'safe',
       title: `Add "${line}" as line 1 of ${claude.path}`,
       changes: [insertLine(claude, 0, line, { blankAfter: true })],
     },
   });
   ```

3. **Build every change with the builders in `src/fix/edits.ts`:** `insertLine`, `replaceSpan`,
   `yamlSetScalar`, `yamlInsertKey`, `prependFrontmatter`, the `json*` builders, `renameFile`,
   `createFile` and `reencode`. Never compute offsets or parse raw text yourself. The builders
   take line endings, indentation and quote style from the neighboring lines. The YAML and JSON
   builders return `undefined` when an edit would not give exactly the intended value; then
   offer no fix. Text copied from the repository goes through `safeCopiedText` and is written
   with `quoteYaml` or `quoteJson`; names derived from content go through `skillSlug`.
4. **Choose the class.** `safe` only when the fix is deterministic, has one correct form and
   keeps the author's prose. A fix that activates or changes an MCP server, a hook, a permission
   or an env override is always `review`. Verification also treats a `safe` fix with such an
   effect as `review`, but do not rely on it.
5. **Give a manual step** when there is no fix: `guidance` on the finding, one line the message
   does not already say, such as `create "docs/setup.md" or correct the path`.
6. **Test it with golden fixtures.** Each case is a directory under `test/fixtures/fix/` named
   after the rule and the case, such as `cursor/md-file-ignored/no-frontmatter/`. It holds a
   `before/` tree and the `after/` tree that `fix --write --review --rule <rule>` must produce,
   byte for byte. The test also checks that the fix resolves the rule's findings, adds no error
   or warning, and that a second run plans nothing. Add cases that must not be fixed, such as a
   file reached through a symlink, and hostile input such as copied text with a line break or
   hidden Unicode. Check that every class the rule attaches is in `meta.fix.classes`.
7. **Regenerate docs** with `pnpm docs:generate`, update the table in
   [docs/fix.md](docs/fix.md#rules-with-fixes), and run the corpus fix replay below.

## Changing what an agent loads

`agentcheckup context` makes positive claims ("Codex loads this file"), so a wrong load plan
costs more trust than a missed finding. See [ADR 0007](docs/adr/0007-model-what-each-agent-loads.md).

1. **One implementation per behavior.** Each loading behavior lives in `src/platforms/` and is
   shared by the rule that reports problems and the loader in `src/platforms/load/<agent>.ts`
   that builds the plan. Do not copy the logic into either one.
2. **Cite it.** Every entry and skip carries `evidence` keys from `src/platforms/sources.ts`.
   Behavior that neither documentation nor source code confirms is `certainty: 'unverified'`.
3. **Never read outside the repository.** User and managed scopes go into `hidden`, settings the
   repository cannot show into `assumptions`.
4. **Test it** in `test/platforms/load/<agent>.test.ts`. `test/platforms/load/consistency.test.ts`
   checks that every skip caused by a problem has its finding and every loading finding has its
   skip; a new case it cannot match needs an explicit allowance in
   `src/platforms/load/consistency.ts`.
5. **Run the corpus checks** below before you open the pull request.

## The real-world corpus

`corpus/` pins 80 public repositories with agent configuration. The harness needs the
[GitHub CLI](https://cli.github.com/), logged in, and a local cache (`.corpus-cache/`, gitignored):

| Command                                           | What it does                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `npx tsx scripts/corpus/fetch.ts`                 | Download the pinned files into `.corpus-cache/` (resumable)                               |
| `npx tsx scripts/corpus/run.ts`                   | Scan everything; rewrite `corpus/SUMMARY.md` and the local `results.json` and `REPORT.md` |
| `npx tsx scripts/corpus/run.ts --write-golden`    | On `main`: record every finding in the local `corpus/golden.json`                         |
| `npx tsx scripts/corpus/run.ts --check-golden`    | On your branch: list every finding that differs from `golden.json`; exit 1 if any         |
| `... --check-golden --ignore-fingerprints`        | After a fingerprint scheme change: compare every field but the fingerprint                |
| `npx tsx scripts/corpus/run.ts --consistency`     | Plan every repository as `context --matrix` does and check the plans against the findings |
| `npx tsx scripts/corpus/run.ts --fix-replay`      | Apply every fix to each repository in memory and check what the fixes leave behind        |
| `npx tsx scripts/corpus/run.ts --only owner/name` | Print one repository's findings                                                           |

A refactor must leave `--check-golden` clean, and a loader change must leave `--consistency`
at zero mismatches. A change to a fix must pass `--fix-replay`: every fix resolves its findings,
adds no error or warning, and a second pass finds nothing left to fix. These checks need the
cache, so they are a manual step before merging, not part of CI. Commit `corpus/SUMMARY.md` when a rule or loader change moves its numbers; it
holds aggregate statistics only, never per-repository results
([ADR 0005](docs/adr/0005-scoring.md)). [corpus/README.md](corpus/README.md) has the details.

## Tests

- Every change needs tests. Coverage thresholds are enforced in CI.
- Tests must be deterministic: no network, no real clock, no dependence on the machine's locale
  or timezone. The test environment sets `TZ=UTC` and `LANG=C`.
- Regular expressions that run on file content must be linear-time. `eslint-plugin-regexp`
  checks literals, and dynamically built `RegExp` objects are not allowed.
- If you fix a crash or hang, add the input that caused it to the tests.

## Commits and pull requests

- Commit messages and pull request titles follow
  [Conventional Commits](https://www.conventionalcommits.org): `feat(rules): ...`,
  `fix(parse): ...`, `docs: ...`. The title becomes the changelog entry, so write it for users.
- Keep pull requests focused. One rule per pull request is ideal.
- Pull requests are squash-merged, and the pull request title becomes the commit message. Mark a
  breaking change with `!` after the type, for example `feat(cli)!: ...`.
- A maintainer reviews and approves every pull request before it is merged.
- CI must pass: formatting, lint, types, tests on Linux, macOS and Windows, a package smoke
  test, CodeQL, and workflow security checks.

## Releases

Releases are automated with release-please and published from CI with npm trusted publishing.
See [docs/maintainers/releasing.md](docs/maintainers/releasing.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree
to uphold it.
