# Context fixture

A monorepo that exercises how Claude Code, Codex and Cursor load agent configuration. Used by
`test/core/golden.test.ts`, which scans it as a checkout with a `.git` directory at this root.
Files here are intentionally wrong. Do not fix them.

- AGENTS.md at four depths. `packages/web/CLAUDE.md` imports `@AGENTS.md`;
  `packages/api/CLAUDE.md` shadows `packages/api/AGENTS.md` and, from above,
  `packages/api/src/handlers/AGENTS.md`.
- Import chain: `packages/web/CLAUDE.md` -> `packages/web/AGENTS.md` ->
  `.github/copilot-instructions.md` -> missing `docs/release-checklist.md`. The import in the HTML
  comment is not followed.
- Codex: `services/**/AGENTS.md` pass 80% of the 32 KiB budget at `services/billing`, cross it in
  `services/billing/ledger` and leave nothing for `ledger/export`. `packages/api` has an
  `AGENTS.override.md`; the one in `tools` is blank. `.codex/config.toml` is not parsed.
- `.claude/rules` with and without `paths`. `.cursor/rules`: alwaysApply, globs, description only,
  no frontmatter, a `.md` file and this kind of README.
- Skills in `.claude/skills` (`triage` has no frontmatter), `.agents/skills` (`db-migrate` starts
  with a BOM), `.cursor/skills` and the nested `packages/web/.claude/skills`.
- `.mcp.json`: unpinned `npx`, pinned `npx`, and a `url` without `type`. `.claude/settings.json`:
  a hook, an unknown hook event, a broad `Bash` permission and `ANTHROPIC_BASE_URL`.
  `.cursor/mcp.json` and `.cursor/hooks.json`.

`services/**/AGENTS.md` are numbered lines generated to reach those sizes.
