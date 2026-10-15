# agentcheckup

TypeScript CLI that lints coding-agent configuration files. Node.js >= 22.12, pnpm 12, ESM only.

## Commands

- Install: `pnpm install --frozen-lockfile`
- Everything CI runs: `pnpm check`
- One test file: `pnpm vitest run test/rules/skill/name-format.test.ts`
- Regenerate rule docs and schemas after changing rule metadata: `pnpm docs:generate`

## Layout

- `src/core`, `src/parse`, `src/platforms`, `src/rules`, `src/report` must not import `node:fs`,
  `node:process` or other I/O modules. ESLint enforces it.
- File system access only in `src/io`. Process handling only in `src/cli`.
- Rules: `src/rules/<family>/<name>.ts`, tests in `test/rules/<family>/<name>.test.ts`.

## Rules for changes

- Rules read files only through `context.frontmatter()`, `context.markdown()` and
  `context.json()`. Do not parse raw text in a rule.
- A rule may use severity `error` only when cited documentation or source code shows the agent
  skips, ignores, truncates or breaks the file. Cite sources in `meta.sources`.
- Use `pathStatus()` from `src/core/paths.ts` for existence checks. Report a missing file only
  when it returns `missing`.
- No dynamic `RegExp`, no `localeCompare`, no `toLocaleLowerCase`. Regex literals must pass
  `eslint-plugin-regexp`.
- Never change a released rule id.
- Tests must include at least one input that must not be reported.
- Commit messages follow Conventional Commits.

Files under `test/fixtures/` are intentionally broken test inputs. Do not fix them.
