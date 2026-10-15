# Contributing to agentcheck

Thanks for helping. The most valuable contributions, in order:

1. **False-positive reports** with a minimal file that reproduces them.
2. **Evidence** that an agent loads a file differently than a rule assumes: a documentation link,
   a source code reference, or a reproduction.
3. **New rules** backed by that kind of evidence.
4. Fixes and features from the [issue tracker](https://github.com/mustafakbaser/agentcheck/issues).

For anything larger than a small fix, open an issue or discussion first so we can agree on the
approach before you write code.

## Setup

You need Node.js 22.12 or newer and pnpm 12.

```sh
git clone https://github.com/mustafakbaser/agentcheck.git
cd agentcheck
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
  core/        engine, config, scoring, suppressions, text decoding     (pure)
  parse/       hardened YAML frontmatter, Markdown, imports, JSON        (pure)
  platforms/   which files each agent reads, and where                   (pure)
  rules/       one file per rule, grouped by family                      (pure)
  report/      stylish, JSON, SARIF, GitHub, Markdown output, sanitizers (pure)
  io/          the only code that touches the file system
  cli/         argument parsing and process handling
```

"Pure" directories cannot import `node:fs`, `node:process` and similar modules. ESLint enforces
this. The boundary keeps the core usable in a browser or editor, and keeps file access in one
reviewed place. The reasoning is in [docs/adr](docs/adr/README.md).

agentcheck scans repositories that may be hostile. When you touch parsing, file access or
output, read [ADR 0003](docs/adr/0003-treat-scanned-repositories-as-hostile.md) first.

## Adding a rule

Every rule needs evidence. A rule may be an `error` only if a platform's documented behavior
skips, ignores, truncates or breaks the file. Behavior you could not verify can only be `info`.
See [ADR 0004](docs/adr/0004-evidence-backed-rules.md).

1. **Find the evidence.** Link official documentation or source code. Note the date you checked
   it. Add it to `src/rules/sources.ts` if it is not there yet.
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
- Pull requests are squash-merged.
- CI must pass: formatting, lint, types, tests on Linux, macOS and Windows, a package smoke
  test, CodeQL, and workflow security checks.

## Releases

Releases are automated with release-please and published from CI with npm trusted publishing.
See [docs/maintainers/releasing.md](docs/maintainers/releasing.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree
to uphold it.
