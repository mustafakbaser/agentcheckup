# What each agent loads

`agentcheckup context` shows what nine coding agents load from a repository when a session starts
in a given directory: which instruction files, rules, skills, MCP servers and hooks, when each
one loads, in what order, how large it is, and what the agent skips and why. The result for one
agent and one working directory is a **load plan**.

Plans come from static analysis of the repository, using the loading behavior documented in
[What coding agents read](platforms.md). agentcheckup never starts an agent. The design is in
[ADR 0007](adr/0007-model-what-each-agent-loads.md), and for Copilot, Gemini CLI, Devin Local,
Cline and Codex's `config.toml` in
[ADR 0009](adr/0009-coverage-of-copilot-gemini-devin-cline-and-codex-toml.md).

```sh
npx agentcheckup context                       # every agent among the targets, session in the root
npx agentcheckup context --agent claude-code    # one agent
npx agentcheckup context --agent copilot        # Copilot's three surfaces
npx agentcheckup context --cwd packages/api     # a session started in packages/api
npx agentcheckup context --matrix               # which agent reads which file
npx agentcheckup context --format markdown      # the same, as Markdown tables
```

The examples on this page come from a small pnpm monorepo: a root `CLAUDE.md` and `AGENTS.md`,
an `AGENTS.md` in `packages/api` and `packages/web`, a Claude Code skill in `.claude/skills`, a
skill in `.agents/skills`, a `.claude/rules/testing.md` with `paths`, two files in
`.cursor/rules`, a `.mcp.json` with one server, a `PreToolUse` hook in `.claude/settings.json`,
a `.github/copilot-instructions.md`, a `.codex/config.toml` with one MCP server, and a
`.gemini/settings.json` that adds `AGENTS.md` to Gemini CLI's context files.

## Agents

| Agent               | Id               | Platform      | The working directory is                                   |
| ------------------- | ---------------- | ------------- | ---------------------------------------------------------- |
| Claude Code         | `claude-code`    | `claude-code` | where the session starts                                   |
| Codex               | `codex`          | `codex`       | where the session starts                                   |
| Cursor              | `cursor`         | `cursor`      | the folder opened in Cursor                                |
| Copilot CLI         | `copilot-cli`    | `copilot`     | where the session starts                                   |
| Copilot in VS Code  | `copilot-vscode` | `copilot`     | the folder opened in VS Code, with the Local agent harness |
| Copilot cloud agent | `copilot-cloud`  | `copilot`     | the directory the agent works in                           |
| Gemini CLI          | `gemini`         | `gemini`      | where the session starts                                   |
| Devin Local         | `windsurf`       | `windsurf`    | the folder opened in Devin Desktop                         |
| Cline               | `cline`          | `cline`       | the folder opened in VS Code                               |

- **Copilot is three agents.** Copilot CLI, Copilot in VS Code and the Copilot cloud agent on
  GitHub.com read different files from the same repository, so each has a plan of its own. They
  share the platform `copilot`. Copilot Chat and code review on GitHub.com are not planned.
- **Devin Local is `windsurf`.** Windsurf became Devin Desktop, whose default agent is Devin
  Local. The id is the platform id the rules already used for Windsurf. The older Cascade agent
  is not planned.
- The platform is what [`targets`](configuration.md#fields) and `--targets` take, and what a
  finding names. A finding for `copilot` can stand for a skip in any of the three Copilot plans.

### Choosing agents: `--agent`

`--agent` takes a comma-separated list of:

- agent ids from the table, such as `codex` or `copilot-cli`;
- platform ids, for every agent of the platform: `copilot` stands for `copilot-cli`,
  `copilot-vscode` and `copilot-cloud`, and every other platform id is also an agent id;
- `all`, for every agent.

Without `--agent`, `context` plans the agents of the configured targets: all nine unless
`targets` names fewer platforms. Plans always come in the order of the table. Any other value is
a usage error, with exit code 2:

```text
$ npx agentcheckup context --agent devin
Unknown agent "devin". --agent takes an agent (claude-code, codex, cursor, copilot-cli, copilot-vscode, copilot-cloud, gemini, windsurf, cline), a platform (copilot) or all.

Run "agentcheckup context --help" for usage.
```

## Reading a load plan

```text
$ npx agentcheckup context --agent claude-code
Claude Code context · ./
Assumes instructions mode claude-md-or-agents-md (default), Claude Code 2.1.277 or later,
  interactive session, trusted workspace
Not visible: managed settings, user settings (~/.claude, ~/.claude.json), claude.ai connectors,
  installed plugins

At session start                         bytes  ≈tokens
  1  CLAUDE.md                             191       48
  2  Skills listing (1 skill, metadata)     98       25
                                  Total    289     ≈ 73
  MCP, asks first:    github  stdio  npx -y @modelcontextprotocol/server-github@2025.4.8 (pinned)
  Hooks, asks first:  PreToolUse Bash → scripts/hooks/block-prod-db.sh (fails open)

On demand
  .claude/skills/release/SKILL.md  body 199 bytes ≈ 50, when the model picks it
  .claude/rules/testing.md         124 bytes ≈ 31, when Claude opens **/*.test.ts

Skipped
  AGENTS.md               a CLAUDE.md on the path is read instead  instr/agents-md-ignored-by-claude  fix: safe
  packages/api/AGENTS.md  a CLAUDE.md on the path is read instead  instr/agents-md-ignored-by-claude  fix: review
  packages/web/AGENTS.md  a CLAUDE.md on the path is read instead  instr/agents-md-ignored-by-claude  fix: review

3 of 3 skips can be fixed: agentcheckup fix
≈tokens = characters ÷ 4
```

- **Header:** the agent and the working directory (`./` is the scanned directory).
- **Assumes:** settings the repository cannot show, with where each value came from. See
  [Assumptions and what is not visible](#assumptions-and-what-is-not-visible).
- **Not visible:** scopes outside the repository that can add to the plan. agentcheckup never
  reads them.
- **At session start:** what is in the model's context when the session starts, in the order the
  agent assembles it. An import is indented under the file that imports it (`└ @AGENTS.md`).
  The skills listing is one row: the names and descriptions of the skills the model can pick
  from. `Total` adds up the rows.
- **MCP and hooks:** the servers and hooks the agent starts with the session. "asks first" means
  the agent asks the user to approve or trust them before they run. Each server shows its
  transport, its command or URL origin, and whether its package is pinned. A tool-gating hook
  shows "fails open" when an error or timeout in the hook lets the tool call go ahead.
- **On demand:** what can join the context later, and what makes it load.
- **Skipped:** files and items the agent would consider but does not load, the reason, and the
  rule that reports the problem. A skip without a rule id is one no rule reports, usually
  expected behavior, such as a root `AGENTS.md` that a `CLAUDE.md` in the working directory
  replaces. A skip that [`agentcheckup fix`](fix.md) can remove ends with the class of its fix:
  `fix: safe` for a fix that `fix --write` applies, `fix: review` for one that needs
  `fix --write --review` or `fix -i`, and `needs your words (fix -i)` for one that needs your
  words first, which only `fix -i` asks for. Markdown output has a Fix column instead, and JSON
  a `fix` field (`safe`, `review` or `input`). A line after the plans counts them, such as
  `3 of 3 skips can be fixed: agentcheckup fix`.
- **Not read by:** files the agent does not read at all and no rule reports, in one line, such
  as `Not read by Cline: packages/api/AGENTS.md`. Cline reads only the root `AGENTS.md`.
- **Incomplete:** files the plan could not analyze, so entries may be missing. For example, a
  `.codex/config.toml` in UTF-16, which agentcheckup does not parse, so Codex servers and hooks
  declared there are not listed; or a Cline hook script, whose format no source documents.
- **Ignored by configuration:** how many files the plan leaves out because the `ignore` of
  `agentcheckup.config.json` matches them. See [Files the configuration ignores](#files-the-configuration-ignores).

A skip whose fix needs your words, here a skill whose empty `description` Codex rejects:

```text
Skipped
  .agents/skills/notes/SKILL.md  no description  skill/description-missing  needs your words (fix -i)
```

A plan in which the agent loads nothing, skips nothing and leaves nothing unanalyzed is one
line, and consecutive such plans share one block:

```text
Gemini CLI context · ./: loads nothing from this repository
```

### Files the configuration ignores

Files that match `ignore` in [the configuration](configuration.md#fields) do not appear in load
plans or in the matrix, just as no rule checks them. Agents still load them, so each plan says
how many files it left out, in one line after the plan:

```text
Ignored by configuration: 22 files are not shown; Cursor may still load them
```

The count covers the files that plan would otherwise have listed: an import of an ignored file,
a nested `AGENTS.md` or a skill in an ignored directory. A plan that leaves nothing out has no
such line. The plan does not list the files: `ignore` usually covers whole directories, such as
test fixtures, and listing them would bury the real configuration. In JSON the count is
`plans[].ignored`. The startup positions of the remaining entries are numbered again without
gaps; the totals do not change, because agentcheckup never read the ignored files.

Only a file's own path counts: a file that is not ignored keeps its entries, skips and
findings. `--untrusted` ignores the repository's configuration, so its plans and matrix show
every file: a pull request cannot hide agent configuration by adding it to `ignore`.

### Triggers

Every entry has a trigger: when the agent adds it to the model's context.

| Trigger          | Meaning                                                                                  | Examples                                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startup`        | In the prompt when the session starts                                                    | Root `CLAUDE.md` and its imports; `.claude/rules` files without `paths`; Codex's `AGENTS.md` chain; `.github/copilot-instructions.md`; a Devin rule with `trigger: always_on`; the skills listing |
| `on-path`        | When the agent reads or edits a matching file. The plan shows the globs or the directory | Nested `CLAUDE.md`; `.claude/rules` with `paths`; Cursor rules with `globs`; nested `AGENTS.md` in Cursor; Copilot's `*.instructions.md` with `applyTo`; Cline rules with `paths`                 |
| `model-selected` | When the model picks it from its description                                             | A skill body; a Cursor rule with only a `description`; a Devin rule with `trigger: model_decision`; a subagent                                                                                    |
| `manual`         | Only when the user asks for it, with an `@`-mention or a `/command`                      | A Cursor rule without `alwaysApply`, `globs` or `description`; a Devin rule with `trigger: manual`; a Cline workflow; a slash command                                                             |
| `on-approval`    | After the user accepts a trust or approval prompt                                        | `.mcp.json` servers in Claude Code; `.codex/hooks.json` hooks and inline hooks in `.codex/config.toml`; Gemini CLI project hooks                                                                  |
| `unknown`        | The agent reads the file, but its documentation does not say when. Always unverified     | A Cursor rule whose frontmatter is not valid YAML; a Devin rule without `trigger`                                                                                                                 |

### Why an agent skips a file

Each skip has a code, shown in text and Markdown as a short reason and in JSON as `code`.

| Code                                                             | Shown as                                             | For example                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `shadowed-by-claude-md`                                          | a CLAUDE.md on the path is read instead              | Claude Code and a root `AGENTS.md`                                                        |
| `shadowed-by-override`                                           | AGENTS.override.md in this directory is read instead | Codex                                                                                     |
| `empty-override`                                                 | an empty AGENTS.override.md in this directory wins   | Codex                                                                                     |
| `over-byte-budget`                                               | past the byte limit                                  | Codex past `project_doc_max_bytes`; a `CLAUDE.md` over 4 MiB                              |
| `blank-file`                                                     | the file is blank                                    | An empty `AGENTS.md`                                                                      |
| `not-mdc`                                                        | only .mdc files are read here                        | Cursor and `.cursor/rules/*.md`                                                           |
| `no-frontmatter`, `invalid-frontmatter`, `bom`, `no-description` | no frontmatter, and so on                            | Skills that Codex or Gemini CLI does not list                                             |
| `invalid-subagent`                                               | invalid subagent definition                          | Claude Code subagents                                                                     |
| `import-unresolved`, `import-too-deep`, `import-outside-root`    | the import does not resolve, and so on               | `@path` imports in Claude Code, Gemini CLI and Copilot CLI                                |
| `url-without-type`                                               | "url" without "type"                                 | Claude Code and a remote server in `.mcp.json`                                            |
| `unknown-event`                                                  | unknown hook event                                   | A hook event name the agent does not fire                                                 |
| `invalid-json`, `not-utf8`                                       | not valid JSON, not valid UTF-8                      | A settings or hooks file the agent cannot read                                            |
| `case-mismatch`                                                  | the file name has the wrong case                     | `agents.md` on a case-sensitive file system                                               |
| `materialized-symlink`                                           | a symlink checked out as a text file                 | A symlinked `CLAUDE.md` in a Windows clone                                                |
| `wrong-location`                                                 | not in a location this agent reads                   | Copilot instructions outside `.github/`                                                   |
| `no-apply-to`                                                    | no valid "applyTo"                                   | A `*.instructions.md` the Copilot cloud agent never applies                               |
| `shadowed-by-preferred`                                          | a preferred file is read instead                     | `.windsurf/global_rules.md` when `.devin/global_rules.md` exists                          |
| `disabled`                                                       | turned off in the configuration                      | Devin's `read_config_from`; `enabled = false` on a Codex server; `features.hooks = false` |
| `never-active`                                                   | its settings keep it from ever applying              | A Cline rule with `paths: []`                                                             |
| `invalid-toml`                                                   | not valid TOML                                       | A `.codex/config.toml` Codex cannot parse                                                 |
| `not-read`                                                       | not read by this agent                               | Listed under "Not read by" in text output                                                 |

The plans of Copilot, Devin Local, Cline and Codex's `config.toml` added `wrong-location`,
`no-apply-to`, `shadowed-by-preferred`, `disabled`, `never-active` and `invalid-toml`.

### Certainty and "?"

Every entry and every skip cites its sources, and has a certainty:

- `documented`: the agent's official documentation states it.
- `source-code`: the agent's published source code shows it.
- `unverified`: neither confirms it.

Text and Markdown output mark unverified rows with "?". In the session-start table, `2?` means
the entry is the second one and is unverified. A row without a number has no documented
position: Cursor, for example, does not document where it puts the skills listing. JSON output
has the `certainty` field and the `evidence` keys, which point into `context.sources`.

### Order that no source documents

Startup numbers give the order in which the agent assembles its context. Where no source gives
that order, the plan says so instead of guessing:

| Agent                          | Startup order                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code, Codex             | Documented                                                                                                                               |
| Gemini CLI                     | The source's order: paths sorted, which puts the root first                                                                              |
| Cline                          | The source's search order: `AGENTS.md`, `.clinerules/`, `.cline/rules/`, the legacy files. The place of the skills listing is `?`        |
| Copilot, on all three surfaces | Not documented. The plan lists files per directory from the root down, then the skills listing, and marks every position `?`             |
| Devin Local                    | Not documented. Startup rows have no number                                                                                              |
| Cursor                         | Not documented. Instruction files first, then rules, each by path; the skills listing has no number. Read the numbers as a listing order |

Copilot CLI and Devin Local in the example repository:

```text
Copilot CLI context · ./
…
At session start                           bytes  ≈tokens
  1?  .github/copilot-instructions.md         82       21
  2?  AGENTS.md                              698      175
  3?  CLAUDE.md                              191       48
  4?  Skills listing (2 skills, metadata)    234       59
                                    Total  1,205    ≈ 302

Devin Local context · ./
…
At session start                          bytes  ≈tokens
     AGENTS.md                              698      175
     CLAUDE.md                              191       48
     Skills listing (2 skills, metadata)    234       59
                                   Total  1,123    ≈ 281
```

Totals do not depend on the order. A `--baseline` comparison shows a change of position only in
the JSON plans.

### Sizes and ≈tokens

- `bytes`: the size of the file on disk.
- characters: the code points the agent receives, after documented transforms such as Codex's
  byte cut and Claude Code's removal of block HTML comments. JSON calls them `chars`.
- `≈tokens`: characters divided by 4, rounded up. This is an estimate, not a tokenizer count. It
  is rough for code and for non-Latin text, and it never causes a finding or changes the score.

For a skill, the session-start size is its listing entry (name and description). The body loads
when the model uses the skill and is shown as `body ... bytes ≈ ...` under On demand. A file that
a limit cuts shows where: `services/billing/ledger/AGENTS.md (cut at byte 6,316, line 97)`.

## Assumptions and what is not visible

The repository does not show everything that decides what an agent loads. Each plan states what
it assumed, and where the value came from:

| Origin        | Meaning                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `default`     | The agent's documented default                                                                    |
| `rule-option` | An agentcheckup rule option, such as `maxBytes` of `instr/codex-size-budget`                      |
| `repository`  | A value read from a file in the repository, such as `context.fileName` in `.gemini/settings.json` |
| `flag`        | A command-line flag, such as `--context-window`                                                   |

Today's assumptions:

- **Claude Code:** the default instructions mode (`AGENTS.md` only when no `CLAUDE.md` is on the
  path), Claude Code 2.1.277 or later, an interactive session, a trusted workspace.
- **Codex:** the 32,768-byte `project_doc_max_bytes` and no fallback file names, unless a
  `.codex/config.toml` on the path sets them; `.git` as the project root marker; a trusted
  project; an unknown context window unless you pass one.
- **Cursor:** Agent mode, third-party configs turned on, a trusted workspace.
- **Copilot CLI:** a trusted folder.
- **Copilot in VS Code:** the Local agent harness; the settings that read
  `.github/copilot-instructions.md`, `AGENTS.md` and `CLAUDE.md` files on; nested `AGENTS.md`
  files and Claude Code hooks off; a trusted workspace. VS Code documents that the last two are
  off by default; the defaults of the first three are not confirmed.
- **Copilot cloud agent:** nothing beyond the surface itself.
- **Gemini CLI:** the context file names from `context.fileName` in the working directory's
  `.gemini/settings.json`, plus `GEMINI.md`; folder trust off; access through a paid API key or
  a Gemini Code Assist license, since Google moved other users to Antigravity CLI, which is not
  modeled.
- **Devin Local:** Devin Local, not Cascade; Restricted Mode off; every other agent's files that
  `read_config_from` covers imported, unless `.devin/config.json` turns a source off.
- **Cline:** the VS Code extension, with every rule toggle in the Rules panel on.

A value from the repository wins. A Codex plan reads `project_doc_max_bytes` and
`project_doc_fallback_filenames` from the closest `.codex/config.toml`:

```text
Assumes AGENTS.md budget 65,536 bytes (from the repository), root marker .git,
  no fallback file names, trusted project, context window unknown
```

If you changed a setting outside the repository, for example raised Codex's
`project_doc_max_bytes` in `~/.codex/config.toml`, set the matching rule option in
`agentcheckup.config.json` and the plan uses your value where the repository sets none:

```json
{
  "rules": {
    "instr/codex-size-budget": ["error", { "maxBytes": 65536 }]
  }
}
```

"Not visible" lists the scopes that can add instructions, skills, servers or hooks from outside
the repository: managed and system settings; user scopes such as `~/.claude`, `~/.codex`,
`$CODEX_HOME/AGENTS.md`, `~/.agents`, `~/.cursor`, `~/.copilot`, `~/.gemini`, `~/.config/devin`,
`~/.devin`, `~/.codeium`, `~/.cline` and `~/Documents/Cline`; Cursor Team Rules and User Rules;
VS Code profile instructions; personal and organization instructions and the cloud agent's MCP
configuration on GitHub.com; Devin organization permissions and MCP allowlists; claude.ai
connectors, Gemini CLI extensions and installed plugins. agentcheckup never reads them
([ADR 0003](adr/0003-treat-scanned-repositories-as-hostile.md)), so a plan describes what the
repository contributes, not everything the agent sees. Text output summarizes these scopes;
JSON and Markdown list every location.

## The working directory: `--cwd`

What an agent loads depends on where the session starts. `--cwd` takes a directory relative to
the scanned path, without `..`, that exists in the scan. The default is the root.

```text
$ npx agentcheckup context --cwd packages/api --agent codex
Codex context · packages/api
…
At session start                         bytes  ≈tokens
  1  AGENTS.md                             698      175
  2  packages/api/AGENTS.md                196       49
  3  Skills listing (1 skill, metadata)    174       44
                                  Total  1,068    ≈ 267
  MCP:  sentry  stdio  npx -y @sentry/mcp-server@0.18.0 (pinned)
```

- **Claude Code** reads `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` from the root
  down to the working directory, root first. Files in directories below it load on demand.
  Skills come from `.claude/skills` in the working directory and each directory above it.
- **Codex** reads one file per directory, from the project root (the nearest directory with
  `.git`) down to the working directory: `AGENTS.override.md` if it exists, otherwise
  `AGENTS.md`, within 32,768 bytes across the chain. Without a `.git` it reads only the working
  directory's file. Codex does not load `AGENTS.md` files below the working directory at all. It
  reads the `.codex/config.toml` of the same directories, the closest winning.
- **Copilot CLI** reads its instruction files in the root, the working directory and the
  directories between them, and those in directories below when it works on files there. It
  reads `.mcp.json` in every directory from the working directory up to the repository root.
- **Gemini CLI** reads its context files from the project root down to the working directory,
  and the same names below it when a tool accesses a path there. Its settings, and so its
  context file names, come from `.gemini/settings.json` in the working directory, and so do its
  skills folders. In the example repository a session in `packages/api` loads nothing: without
  a `packages/api/.gemini/settings.json`, Gemini CLI looks only for `GEMINI.md`, and that
  directory has no skills folder.
- **Cursor**, **Copilot in VS Code**, **Devin Local** and **Cline** treat `--cwd` as the folder
  you open in the editor: that folder is the workspace root, and files outside it are not part
  of the workspace. Devin Local also finds hook files in the directories above it, up to the
  repository root.
- **Copilot cloud agent** treats `--cwd` as the directory it works in: the `AGENTS.md` files from
  the root down to it load at startup, and deeper ones when it works on files there. GitHub
  documents that the nearest one takes precedence, not whether the others still load, so the
  positions are unverified.

## The context window: `--context-window`

Some limits depend on the model's context window, which the repository does not show. Pass it in
tokens, for example `--context-window 200000`:

- Claude Code lists skills within 1% of the context window. Without the flag, that limit is
  unknown (`null` in the JSON `limits`); each skill's listing entry is still cut at 1,536
  characters.
- Codex lists skills within 2% of the context window, or 8,000 characters when it does not know
  the window.

The other agents document no limit that depends on the context window. The flag is recorded as
an assumption with origin `flag`. On a regular scan it needs `--context`.

## The matrix

`--matrix` plans every agent in the root directory, plus Codex in each directory that has an
`AGENTS.md` or `AGENTS.override.md`, because the files Codex reads depend on where the session
starts. It then shows one row per configuration file and one column per agent:

```text
$ npx agentcheckup context --matrix
…
Files by agent              Claude Codex Cursor Copilot       Gemini Devin Cline
                                                CLI VSC Cloud
.agents/skills/db-migrate   —      L     L      L   L   L     L      L     L
.claude/rules/testing.md    P      —     —      —   P   —     —      —     —
.claude/settings.json       S      —     S      S   —   —     —      S     —
.claude/skills/release      L      —     L      L   L   L     —      L     L
.codex/config.toml          —      S     —      —   —   —     —      —     —
.cursor/rules/react.mdc     —      —     P      —   —   —     —      P     —
.cursor/rules/testing.md    —      —     X      —   —   —     —      U     —
.github/copilot-instructions.md
                            —      —     —      S   S   S     —      —     —
.mcp.json                   S      —     —      S   S   —     —      S     —
AGENTS.md                   X      S     S      S   S   S     S      S     S
CLAUDE.md                   S      —     S      S   S   S     —      S     —
packages/api/AGENTS.md      X      D     P      P   —   P     P      P     —
packages/web/AGENTS.md      X      D     P      P   —   P     P      P     —

S  startup    loaded at session start
P  on-path    loaded when the agent opens a file it covers
D  start-dir  loaded when a session starts in its directory
L  listed     in the skills listing; the body loads when used
U  manual     loaded only when you ask for it
X  skipped    not loaded; the plan says why
—  not-read   not read by this agent
```

Rows are instruction files, rule files, skills (by skill directory) and the files that declare
MCP servers and hooks. Commands, workflows, subagents and imported files such as a `README.md`
do not get rows. Rows that no agent reads are left out, and so are files the configuration
ignores (see [Files the configuration ignores](#files-the-configuration-ignores)); the plans
above the matrix count them. Directories with an ignored `AGENTS.md` get no Codex plan of their
own.

| Cell             | Letter | Meaning                                                                                                           |
| ---------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `startup`        | `S`    | Loaded at session start. MCP servers and hooks the agent asks about first count here: they start with the session |
| `on-path`        | `P`    | Loaded when the agent opens a file the entry covers                                                               |
| `start-dir`      | `D`    | Loaded only when a session starts in that directory or below it, as Codex does with a nested `AGENTS.md`          |
| `listed`         | `L`    | A skill in the skills listing; its body loads when the model uses it                                              |
| `model-selected` | `M`    | Loaded when the model picks it                                                                                    |
| `manual`         | `U`    | Loaded only when you ask for it                                                                                   |
| `partial`        | `C`    | Loaded, but a limit cuts it                                                                                       |
| `skipped`        | `X`    | The agent skips it; the plan says why                                                                             |
| `unknown`        | `?`    | Not documented, or the file could not be analyzed                                                                 |
| `—`              | `—`    | Not read by this agent (`not-read` in JSON)                                                                       |

The text layout depends only on how many columns there are, never on the terminal:

- Up to four agents show full names and full cell names, as
  `context --matrix --agent claude-code,codex,cline` does.
- More agents show one letter per cell under a two-row header that groups Copilot's surfaces
  (`CLI`, `VSC`, `Cloud`). The path column shrinks so that nine agents fit in 80 characters; a
  longer path gets a line of its own.
- A key under the matrix explains the cells it uses.
- Text and Markdown leave out the column of an agent that reads none of the files and name it
  under the rows, such as `Not shown: Gemini CLI reads none of these files`. JSON keeps every
  column. Markdown always uses full agent names.
- A repository where no agent reads a configuration file prints
  `Files by agent: no agent reads a configuration file here`.

A cell comes from the root plan first, then from the plans that start deeper, the shallowest
first. A file of MCP servers or hooks has one row: when the agent loads some of its items and
skips others, the cell shows what it loads and the plan lists the skips. `--matrix` cannot be
combined with `--cwd`.

## What each agent misses, in a scan

A regular scan in the `stylish`, `markdown` or `github` format plans each agent at the root as
well. `stylish` and `markdown` output start with the skips. On the small repository that
[Fixing findings](fix.md) uses:

```text
$ npx agentcheckup
What each agent misses
  Claude Code  MCP server docs is skipped: "url" without "type"                                 fix: review
               AGENTS.md is skipped: a CLAUDE.md on the path is read instead (≈82 tokens)       fix: safe
               docs/setup.md is skipped: CLAUDE.md imports it, but the import does not resolve  manual
  Codex        skill deploy is skipped: no description (≈13 tokens)                             fix: review
  Cursor       .cursor/rules/style.md is skipped: only .mdc files are read here (≈9 tokens)     fix: review
  Gemini CLI   skill deploy is skipped: no description (≈13 tokens)                             fix: review
```

A finding's `why` line (`Why:` in a GitHub annotation) comes from the same plans: how much the
agent misses, and which other agents still load the file. `--compact` leaves both out and does
not plan; `--verbose` adds each rule's docs URL, rationale and sources to `stylish` output. JSON
and SARIF include plans only with `--context`. See
[How much a scan shows](configuration.md#how-much-a-scan-shows).

## JSON

`agentcheckup context --format json` writes the same report as a scan, so one schema covers both:
[schemas/report.schema.json](../schemas/report.schema.json). The parts that matter here:

| Field                               | What it holds                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `context.agents`                    | The planned agents, by id, in the order of the [agents table](#agents)                                                                          |
| `context.plans[]`                   | One plan per agent and working directory: `agent` (`copilot-cli`, `windsurf`, …), `cwd` (`""` is the root)                                      |
| `plans[].entries[]`                 | `id`, `role`, `trigger`, `position` (startup only), `path`, `realPath`, `size`, `deferred`, `truncated`, `certainty`, `evidence`, `inventoryId` |
| `plans[].skipped[]`                 | `id`, `role`, `path`, `code` (why), `ruleId` (the rule that reports it, when one does), `size`, `fix`, `certainty`, `evidence`                  |
| `plans[].assumptions[]`, `hidden[]` | What the plan assumed, and the scopes it cannot see                                                                                             |
| `plans[].limits[]`                  | Usage of each documented limit: `key`, `unit`, `limit` (`null` when it depends on an unknown context window), `used`, `subject`, `effect`       |
| `plans[].totals`                    | `startup` and `onDemand` sizes                                                                                                                  |
| `plans[].incomplete[]`              | What could not be analyzed, such as `unread:.clinerules/style.txt` or `unparsed:.codex/config.toml`                                             |
| `plans[].ignored`                   | How many files the plan leaves out because the configuration's `ignore` matches them; absent when none                                          |
| `context.matrix.rows[]`             | With `--matrix`: `path`, `kind`, and `cells`, where `cells[i]` belongs to `context.agents[i]`; every agent has a cell                           |
| `context.sources`                   | Every source an `evidence` key points to: title, URL, the date it was checked                                                                   |
| `inventory`                         | Every MCP server, hook, permission and env override, whether or not an agent loads it. Every report has it                                      |
| `baseline`                          | With `--baseline`: the comparison described below                                                                                               |
| `pathBase`                          | The prefix added to every path when the scanned directory is not the current directory                                                          |

Output is deterministic: the same files give byte-identical JSON. Paths are relative and never
absolute. JSON paths are relative to the current directory, as in a scan; text and Markdown
output use paths relative to the scanned directory.

## Codex `config.toml`

Codex reads MCP servers, hooks and settings from `.codex/config.toml` in each directory from the
project root down to the working directory; see
[What coding agents read](platforms.md#project-configuration-configtoml). The Codex plan and the
inventory read every such file:

- **MCP servers** start with the session, as `MCP:` without "asks first", since the plan assumes
  a trusted project. A server with `enabled = false` is skipped as `disabled`. A server entry
  Codex rejects, such as one with both `command` and `url`, stays in the plan, marked unverified,
  and `codex/config-invalid` reports it.
- **Hooks** in `[hooks]` tables run after the user trusts them (`Hooks, asks first`).
  `features.hooks = false` skips them as `disabled`.
- **Settings:** `project_doc_max_bytes` and `project_doc_fallback_filenames` from the closest file
  become assumptions with origin `repository`.
- **A file that is not valid TOML** is skipped as `invalid-toml`: in a trusted project Codex
  stops at startup, and `codex/config-invalid` reports it as an error.
- **A file agentcheckup cannot read** (past its parser's limits of 1 MiB, 64 levels and 100,000
  values, or in UTF-16) makes the plan incomplete. TOML 1.1 syntax and a leading byte order mark
  are read, as Codex reads them.
- Keys Codex drops from a project file, such as `model_provider` or `profiles`, change nothing in
  the plan; `codex/ignored-project-key` reports them.

```text
$ npx agentcheckup context --agent codex --cwd packages/api
Codex context · packages/api
Assumes AGENTS.md budget 65,536 bytes (from the repository), root marker .git,
  no fallback file names, trusted project, context window unknown
…
  MCP:                sentry  stdio  npx -y @sentry/mcp-server@0.18.0 (pinned)
  Hooks, asks first:  PreToolUse shell → scripts/hooks/check.sh (fails open)

Skipped
  .codex/config.toml › legacy      turned off in the configuration
  packages/api/.codex/config.toml  not valid TOML                   codex/config-invalid
```

This example has its own repository: a root `.codex/config.toml` with `project_doc_max_bytes`,
the server `sentry`, the server `legacy` with `enabled = false` and a `PreToolUse` hook, and a
`packages/api/.codex/config.toml` with a syntax error.

## Baselines and the gate

A baseline is the JSON report of an earlier scan, usually of the base branch of a pull request.
Comparing with it shows what a change adds, and `--gate` fails the run on security-relevant
changes.

```sh
# The base commit
agentcheckup --untrusted --no-gitignore --context --format json --output base.json --fail-on none
# The pull request
agentcheckup --untrusted --no-gitignore --context --baseline base.json --gate security
```

Use `--context` on both scans, so the comparison also covers what each agent loads. The
`context` command takes `--baseline` and `--gate` too. The
[GitHub Action](https://github.com/mustafakbaser/agentcheckup-action) runs these two scans for
you and builds the baseline from the base commit, never from the pull request.

### How the two reports are matched

- **Paths.** Each report's `pathBase` is removed first, so both reports must scan the same
  directory, but they may have been run from different places.
- **Findings** match by fingerprint, as a multiset: each baseline finding matches at most one
  current finding. A current finding without a match is `new`; a baseline finding without a
  match is resolved. `--fail-on` counts new findings only. The score still covers every
  finding, and SARIF marks each result with its baseline state.
- **Fingerprints** are `<hash>:<occurrence>`. The hash covers the rule id, the file and what the
  finding points at. In a JSON file, that is the JSON path of the value, without array indices
  (`mcpServers.docs`, `permissions.allow[]`), and the value itself in canonical form: a string,
  number or boolean, or the content of an object in an array. An object under a key, such as an
  MCP server, counts by its key alone, so adding a field to the server keeps its findings. In
  any other file, or a JSON file that does not parse, it is the text of the finding's line with
  whitespace collapsed and trailing commas, semicolons and periods removed. A finding on a whole
  file does not depend on any line. So lines inserted above, re-indentation, a trailing comma
  added when a sibling is appended, and reordered keys keep a finding unchanged, while a
  finding about another value is new. Findings with the same hash are numbered in report order.
- **Fingerprint version.** Every report has a `fingerprintVersion`. A baseline with another
  version, or without the field (reports from before version 2), is refused with exit code 2:
  none of its findings could match. Create the baseline again with the same agentcheckup
  version, as the GitHub Action does on every run.
- **Inventory items** match by id: `mcp:<file>#<name>`, `hook:<file>#<event>:<hash of the
command>`, `perm:<file>#<key>=<value>`, `env:<file>#<key>`. An item is changed when its
  digest differs. The digest covers only what reports show: names, the command and redacted
  arguments, URL origins, pin status, env var names, and for env overrides the URL origin of an
  endpoint or the value of a TLS switch (`0`, `1`, `true`, `false`, `yes`, `no`). Credential
  values never enter it, so a new token value under the same name is not a change. Committed
  secrets are reported by [mcp/literal-secret](rules/mcp/literal-secret.md) instead.
- **Plan entries** match by id within the same agent and working directory, and only for plans
  present in both reports. An entry is changed when its trigger, its size in characters, its
  cut or its certainty differs. A change of position alone shows only in the JSON plans.
- **Rule sets.** A baseline from another rule set is accepted with a warning. Findings from
  rules the baseline did not run count as new.
- **Codex `config.toml`.** agentcheckup reads `.codex/config.toml` since its Codex TOML support.
  A baseline made before then lists the file only as not analyzed, so the first comparison shows
  every Codex MCP server, hook, permission and env override in it as added, and the gate trips
  for them. Create the baseline again to compare item by item.
- **Agents the baseline did not plan.** Plans are compared only for agents both reports plan,
  so the session-start line leaves out an agent the baseline has no plan for. A baseline made
  before agentcheckup read the MCP and hook files of Copilot and Devin Local, such as
  `.vscode/mcp.json`, `.github/hooks/*.json` or `.devin/mcp_config.json`, has no inventory
  items for them: the first comparison shows their servers and hooks as added, and the gate
  trips for them.

### Gate classes

`--gate` takes a comma-separated list of classes, `security` for all of them, or `none`. It
needs `--baseline`. Only additions and changes trip it; removals never do.

| Class          | Trips when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mcp`          | An MCP server is added or changed, or a new MCP config file appears that agentcheckup cannot analyze, such as a `.mcp.json` with invalid JSON or a `.codex/config.toml` with invalid TOML                                                                                                                                                                                                                                                                                                        |
| `mcp-unpinned` | An added or changed MCP server runs a package that is not pinned to an exact version or a digest, or runs a local command whose version cannot be told. Remote servers reached by URL never trip it                                                                                                                                                                                                                                                                                              |
| `permissions`  | An entry that lets an agent do more without asking is added, or now takes effect or is now broad: any `permissions.allow` or `permissions.additionalDirectories` entry, a skill's `allowed-tools`, an `enabledMcpjsonServers` entry, `enableAllProjectMcpServers` or Gemini CLI `trust` set to `true`, `defaultMode` set or changed, or one of the Codex settings below. `deny` and `ask` entries never trip it                                                                                  |
| `hooks`        | A hook is added or changed, on any event, or a new hooks file appears that agentcheckup cannot analyze: a `.codex/config.toml` it cannot read, a Copilot or Devin Local hook or settings file that does not parse (VS Code reads its files as JSONC, and the other readers' parsers are not documented), Cascade's `.devin/hooks.json`, or a file in Cline's hook and plugin folders. Claude Code, Codex and Gemini CLI run no hooks from a file that does not parse, so theirs does not trip it |
| `env`          | An env override that sets an endpoint, a credential, TLS behavior or code execution is added or changed. Overrides of other variables never trip it                                                                                                                                                                                                                                                                                                                                              |
| `unicode`      | A new [risk/hidden-unicode](rules/risk/hidden-unicode.md) finding appears                                                                                                                                                                                                                                                                                                                                                                                                                        |

The env classes come from the Claude Code and Node.js documentation. Examples: `endpoint`
covers `ANTHROPIC_BASE_URL`, the provider base URLs and proxy variables; `credential` covers
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_CUSTOM_HEADERS`; `tls` covers
`NODE_TLS_REJECT_UNAUTHORIZED` and `NODE_EXTRA_CA_CERTS`; `code-exec` covers `NODE_OPTIONS`,
`LD_PRELOAD` and Claude Code settings that run a command, such as `apiKeyHelper`. Following the
digest rules above, a new value for an existing `credential` or `code-exec` override is not a
change, while a new endpoint origin or TLS switch value is.

A narrow entry such as `Bash(curl:*)` trips `permissions` like a broad one: the reviewer should
see every command an agent may now run without asking. The summary marks the broad ones, which
grant everything of their kind:

```text
Permission widened: permissions.allow adds Bash(curl:*)
Permission widened: permissions.allow adds Bash (broad: runs any shell command)
Permission widened: permissions.additionalDirectories adds ~ (broad: the file system root or home directory)
```

In `.codex/config.toml` the inventory lists only settings that let Codex act without asking:
`approval_policy = "never"`, `sandbox_mode = "danger-full-access"`,
`sandbox_workspace_write.network_access = true`, each `sandbox_workspace_write.writable_roots`
entry, and MCP tool approval modes other than `prompt`. Values that only restrict Codex are not
listed, so they never trip the gate.

An added `permissions.allow` or `allowed-tools` entry does not trip it when the same change
removes, from the same key of the same file, an entry that provably allowed everything it
allows, such as `Bash` replaced by `Bash(git status *)`; anything agentcheckup cannot prove from
the [permission rule syntax](https://code.claude.com/docs/en/permissions) still trips.

Each gate hit has a one-line summary for the pull request. Endpoint values are shown as their
URL origin; credential values are never shown.

### Exit codes

| Code | When                                                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | No new findings at or above `--fail-on`, and no gate hit. `context` exits 0 unless `--gate` trips                                                                                  |
| 1    | New findings at or above `--fail-on`, a score below `--min-score`, or a gate hit                                                                                                   |
| 2    | `--gate` without `--baseline`, an unknown gate class, or a baseline that cannot be read or used (too large, a symlink, an unsupported schema version, another fingerprint version) |
| 3    | Internal error                                                                                                                                                                     |

### Who approves a gated change

The gate does not approve anything; it makes the change visible and fails the check. Pair it
with CODEOWNERS on agent-config paths and "Require review from Code Owners", so a person who owns
that configuration reviews each change. The
[Action's README](https://github.com/mustafakbaser/agentcheckup-action#requiring-the-check-and-codeowners)
has a CODEOWNERS file to start from.

## Examples

**Why does Claude Code not follow my `AGENTS.md`?**

```sh
npx agentcheckup context --agent claude-code
```

If `AGENTS.md` is under Skipped with "a CLAUDE.md on the path is read instead", add the line
`@AGENTS.md` to that `CLAUDE.md`. The plan then shows `└ @AGENTS.md` under it. When the
`CLAUDE.md` is in the same directory, the skip ends with `fix: safe`, and
`npx agentcheckup fix --write` adds the line for you.

**Does every Copilot surface see my instructions?**

```sh
npx agentcheckup context --agent copilot
```

Compare the three plans. In the example repository, Copilot in VS Code lists the nested
`AGENTS.md` files under "Not read by", because `chat.useNestedAgentsMdFiles` is off by default,
while the CLI and the cloud agent load them when they work on files there.

**How much does a session in this package start with?**

```sh
npx agentcheckup context --cwd packages/api --agent codex
```

The `Total` row is the session-start context from the repository. A row ending in `(cut at byte
…)` is where Codex stops reading.

**What changed in this pull request?**

```text
$ npx agentcheckup context --baseline base.json --gate security
…
Since the baseline
✖ 4 security-relevant changes need review
    New MCP server, not pinned: New MCP server browser (stdio, npx -y @acme/browser-mcp, not pinned)
    Permission widened: permissions.allow adds Bash(curl:*)
    New hook: New hook SessionStart → scripts/hooks/session-start.sh
    Env override: Env override ANTHROPIC_BASE_URL → https://llm-proxy.example.net
Findings: 0 new, 4 unchanged, 1 resolved
Session-start context: Claude Code ≈73 → ≈250 tokens (+177) · Codex unchanged · Cursor ≈281 → ≈284 tokens (+3) · Copilot CLI ≈302 → ≈305 tokens (+3) · Copilot in VS Code ≈302 → ≈305 tokens (+3) · Copilot cloud agent ≈302 → ≈305 tokens (+3) · Gemini CLI unchanged · Devin Local ≈281 → ≈284 tokens (+3) · Cline unchanged
```

Here the pull request adds an unpinned MCP server, a permission, a `SessionStart` hook and an
`ANTHROPIC_BASE_URL` override to the example repository, and adds `@AGENTS.md` to its
`CLAUDE.md`.

**A Markdown report for a wiki or a pull request comment:**

```sh
npx agentcheckup context --matrix --format markdown --output agent-context.md
```

## Limitations

- **Static analysis.** Plans apply documented loading behavior to the files in the repository.
  A remote flag, an experiment, a setting outside the repository or a bug in the agent can change
  what it actually loads.
- **Repository scope.** User, managed, team and account scopes are listed, never read. That
  includes the Copilot cloud agent's MCP servers, which live in the repository's settings on
  GitHub.com, not in a file.
- **Surfaces and agents not planned.** Copilot Chat and code review on GitHub.com, VS Code's
  harnesses other than Local, Devin Desktop's Cascade agent and Antigravity CLI have no plans.
  Rules still check the files they read.
- **Modes the plans assume away.** Plans assume trusted workspaces and folders, Devin Desktop
  outside Restricted Mode, where agents are unavailable and hooks do not run, and every Cline
  rule toggle on.
- **Estimates.** Token counts are characters divided by 4.
- **Codex project configuration.** Plans and the inventory read each `.codex/config.toml`
  from the project root down to the working directory, the closest one winning. A file named in
  `project_doc_fallback_filenames` is not followed: the AGENTS.md chain stops before its
  directory. Whether a server entry Codex rejects stops it at startup is not verified.
- **Files the scan does not read.** Cline rules ending in `.txt` or `.markdown`, the legacy
  `.clinerules` file, and Devin's `AGENTS.local.md`, `AGENT.md` and global rules files are listed
  as incomplete, without a size. Cline hook scripts and plugins have no documented format and
  are listed the same way.
- **Ordering.** Copilot, Devin Local and Cursor do not document the order in which they assemble
  instructions; see [Order that no source documents](#order-that-no-source-documents).
- **Behavior changes.** Agents change how they load files every few releases. Plans cite the
  sources they rely on with the date each was checked, and a weekly job reports when a cited
  source changes. Report a plan that disagrees with your agent as a bug, with the agent's version.
