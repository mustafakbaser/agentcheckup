# Reading context output

Commands on this page leave out the `npx agentcheckup@...` prefix. Run them with the exact
prefix that SKILL.md uses. Only plain `context` is pre-approved; the variants ask first.

## A plan

```text
Claude Code context · ./
Assumes instructions mode claude-md-or-agents-md (default), Claude Code 2.1.277 or later, ...
Not visible: managed settings, user settings (~/.claude, ~/.claude.json), ...

At session start                          bytes  ≈tokens
  1  CLAUDE.md                               33        9
  2  Skills listing (2 skills, metadata)    144       37
                                   Total    177     ≈ 45
  MCP, asks first:  github  stdio  npx -y @modelcontextprotocol/server-github@2025.4.8 (pinned)

On demand
  .claude/skills/guide/SKILL.md    body 13,431 bytes ≈ 3,358, when the model picks it
  .claude/skills/release/SKILL.md  body 21 bytes ≈ 6, when the model picks it

Skipped
  AGENTS.md                  a CLAUDE.md on the path is read instead  instr/agents-md-ignored-by-claude  fix: safe
  CLAUDE.md › docs/setup.md  the import does not resolve              instr/import-unresolved
```

- **Header**: the agent and the directory the session starts in; `./` is the repository root.
- **Assumes**: settings the repository cannot show, with where each value came from.
- **Not visible**: scopes outside the repository, such as user settings. agentcheckup never
  reads them, so the plan shows what the repository contributes, not everything the agent sees.
- **At session start**: what is in the model's context when the session starts, in the order
  the agent builds it. An import is indented under the file that imports it. The skills listing
  is one row: the names and descriptions of the skills.
- **MCP, Hooks**: servers and hooks that start with the session. "asks first" means the agent
  asks the user to approve them. "fails open" means a hook error lets the tool call go ahead.
- **On demand**: what can load later, and the trigger: a matching file path, the model picking
  a skill or rule by its description, or the user asking for it.
- **Skipped**: files and items the agent considers but does not load, the reason, and the rule
  that reports the problem. `fix: safe` or `fix: review` means `fix` can remove the skip. A skip
  without a rule id is expected behavior, such as a root `AGENTS.md` that a `CLAUDE.md` replaces.
- **Incomplete**: files the plan could not analyze, so entries may be missing.

`?` after a position or on a row marks behavior that neither documentation nor source code
confirms. `≈tokens` is characters divided by 4, an estimate.

## Options

- `context --agent codex`: one agent. The agents are `claude-code`, `codex`, `cursor`,
  `copilot-cli`, `copilot-vscode`, `copilot-cloud`, `gemini`, `windsurf` (Devin Local) and
  `cline`; `copilot` stands for its three surfaces and `all` for every agent. Separate several
  with commas.
- `context --cwd packages/api`: a session started in that directory, relative to the root,
  without `..`. Claude Code then reads `CLAUDE.md` files from the root down to it; Codex reads
  one `AGENTS.md` per directory from the project root down to it; Cursor treats it as the folder
  opened in Cursor.
- `context --matrix`: which agent reads which file, from the root.
- `context --format json`: the same as JSON.

`context` exits 0 whatever it finds. Exit 2 means an invalid option, such as an unknown agent or
a `--cwd` that is not a directory in the repository.
