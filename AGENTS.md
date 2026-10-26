# agentcheckup

TypeScript CLI that shows what coding agents load from a repository, lints their configuration
files and fixes what it can. Node.js >= 22.12, pnpm 12, ESM only.

## Commands

- Install: `pnpm install --frozen-lockfile`
- Everything CI runs: `pnpm check`
- One test file: `pnpm vitest run test/rules/skill/name-format.test.ts`
- Regenerate rule docs and schemas after changing rule metadata: `pnpm docs:generate`
- Corpus checks, need the local `.corpus-cache/` (see `corpus/README.md`):
  `npx tsx scripts/corpus/run.ts --check-golden` after a refactor (no finding may change),
  `npx tsx scripts/corpus/run.ts --consistency` after a loader change (zero mismatches),
  `npx tsx scripts/corpus/run.ts --fix-replay` after a fix change.

## Layout

- `src/core`, `src/parse`, `src/platforms`, `src/inventory`, `src/agents`, `src/rules`,
  `src/fix`, `src/tasks`, `src/policy`, `src/report` must not import `node:fs`, `node:process` or
  other I/O modules. ESLint enforces it.
- File system access only in `src/io`. Process handling only in `src/cli`. Only
  `src/io/write-fix.ts` writes to the scanned repository, for `fix` and `skill install`.
- Rules: `src/rules/<family>/<name>.ts`, tests in `test/rules/<family>/<name>.test.ts`.
- Fixes: planned, applied and verified in memory in `src/fix`; edit builders in
  `src/fix/edits.ts`.
- Load plans: `src/platforms/load/<agent>.ts`, tests in `test/platforms/load/`. Loading behavior
  shared by a rule and a loader lives in `src/platforms/`, once.
- Security inventory (MCP servers, hooks, permissions, env overrides): `src/inventory/`, tests in
  `test/inventory/`.
- Agent definitions and the models they use (`agentcheckup agents`): `src/agents/`, tests in
  `test/agents/`.
- Tasks for coding agents (`agentcheckup tasks`): `src/tasks/`, tests in `test/tasks/`.
  Organization policy (`--policy`): `src/policy/`, tests in `test/policy/`.
- The agentcheckup skill: `skills/agentcheckup/`, shipped in the package and installed by
  `src/cli/skill.ts`; tests in `test/skill/`.

## Rules for changes

- Rules read files only through `context.frontmatter()`, `context.markdown()`,
  `context.json()` and `context.toml()`. Do not parse raw text in a rule.
- A rule may use severity `error` only when cited documentation or source code shows the agent
  skips, ignores, truncates or breaks the file. Cite sources in `meta.sources`.
- A rule declares its fix classes in `meta.fix` (`{ classes, summary }`) and attaches a fix with
  `context.report({ fix })`. Build every change with the `src/fix/edits.ts` builders; never
  compute offsets or parse raw text for a fix. Without a fix, give `guidance`.
- A fix is `safe` only when it is deterministic, has one correct form and keeps the author's
  prose. A fix that activates or changes an MCP server, hook, permission or env override is
  `review`. Fixes never delete files, rename directories, make case-only renames or run git.
- A fix that needs the user's words has `input` and no `changes`; declare it in
  `meta.fix.input`. Only `moveSections` moves text, whole sections into new files; keep a
  section in place when moving it would hide it from a rule. See ADR 0010.
- Fix tests: golden cases in `test/fixtures/fix/<rule>/<case>/before/` and `after/`, byte for
  byte; a second run must plan nothing. See CONTRIBUTING.md.
- Every load-plan entry and skip cites `evidence`; behavior no source confirms is `unverified`.
  Never read home-directory or user scopes: list them in `hidden`.
- Inventory items and reports never hold credential values.
- Use `pathStatus()` from `src/core/paths.ts` for existence checks. Report a missing file only
  when it returns `missing`.
- No dynamic `RegExp`, no `localeCompare`, no `toLocaleLowerCase`. Regex literals must pass
  `eslint-plugin-regexp`.
- Never change a released rule id.
- Tests must include at least one input that must not be reported.
- `corpus/SUMMARY.md` holds aggregate statistics only. Never commit per-repository corpus results.
- Commit messages follow Conventional Commits.

Files under `test/fixtures/` are intentionally broken test inputs. Do not fix them.
