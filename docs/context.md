# What each agent loads

`agentcheckup context` shows what Claude Code, Codex and Cursor load from a repository when a
session starts in a given directory: which instruction files, rules, skills, MCP servers and
hooks, when each one loads, in what order, how large it is, and what the agent skips and why.
The result for one agent and one working directory is a **load plan**.

Plans come from static analysis of the repository, using the loading behavior documented in
[What coding agents read](platforms.md). agentcheckup never starts an agent. The design is in
[ADR 0007](adr/0007-model-what-each-agent-loads.md).

```sh
npx agentcheckup context                       # every modeled agent, session in the root
npx agentcheckup context --agent claude-code    # one agent
npx agentcheckup context --cwd packages/api     # a session started in packages/api
npx agentcheckup context --matrix               # which agent reads which file
npx agentcheckup context --format markdown      # the same, as Markdown tables
```

The examples on this page come from a small pnpm monorepo: a root `CLAUDE.md` and `AGENTS.md`,
an `AGENTS.md` in `packages/api` and `packages/web`, a Claude Code skill in `.claude/skills`, a
skill in `.agents/skills`, a `.claude/rules/testing.md` with `paths`, two files in
`.cursor/rules`, a `.mcp.json` with one server, and a `PreToolUse` hook in
`.claude/settings.json`.

## Reading a load plan

```text
Claude Code context · ./
Assumes instructions mode claude-md-or-agents-md (default), Claude Code 2.1.277 or later,
  interactive session, trusted workspace
Not visible: managed settings, user settings (~/.claude, ~/.claude.json), claude.ai connectors,
  installed plugins

At session start                         bytes  ≈tokens
  1  CLAUDE.md                             198       50
  2  Skills listing (1 skill, metadata)    105       27
                                  Total    303     ≈ 76
  MCP, asks first:    github  stdio  npx -y @modelcontextprotocol/server-github@2025.4.8 (pinned)
  Hooks, asks first:  PreToolUse Bash → scripts/hooks/block-prod-db.sh (fails open)

On demand
  .claude/skills/release/SKILL.md  body 187 bytes ≈ 47, when the model picks it
  .claude/rules/testing.md         168 bytes ≈ 42, when Claude opens **/*.test.ts

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
  `fix --write --review` or `fix -i`. Markdown output has a Fix column instead, and JSON a
  `fix` field. A line after the plans counts them, such as
  `3 of 3 skips can be fixed: agentcheckup fix`.
- **Incomplete:** files the plan could not analyze, so entries may be missing. For example,
  `.codex/config.toml` is not parsed, so Codex servers and hooks declared there are not listed.
- **Ignored by configuration:** how many files the plan leaves out because the `ignore` of
  `agentcheckup.config.json` matches them. See [Files the configuration ignores](#files-the-configuration-ignores).

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

| Trigger          | Meaning                                                                                  | Examples                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `startup`        | In the prompt when the session starts                                                    | Root `CLAUDE.md` and its imports; `.claude/rules` files without `paths`; Codex's `AGENTS.md` chain; the skills listing |
| `on-path`        | When the agent reads or edits a matching file. The plan shows the globs or the directory | Nested `CLAUDE.md`; `.claude/rules` with `paths`; Cursor rules with `globs`; nested `AGENTS.md` in Cursor              |
| `model-selected` | When the model picks it from its description                                             | A skill body; a Cursor rule with only a `description`; a subagent                                                      |
| `manual`         | Only when the user asks for it, with an `@`-mention or a `/command`                      | A Cursor rule without `alwaysApply`, `globs` or `description`; a slash command                                         |
| `on-approval`    | After the user accepts a trust or approval prompt                                        | `.mcp.json` servers in Claude Code; `.codex/hooks.json` hooks                                                          |
| `unknown`        | The agent reads the file, but its documentation does not say when. Always unverified     | A Cursor rule whose frontmatter is not valid YAML                                                                      |

### Certainty and "?"

Every entry and every skip cites its sources, and has a certainty:

- `documented`: the agent's official documentation states it.
- `source-code`: the agent's published source code shows it.
- `unverified`: neither confirms it.

Text and Markdown output mark unverified rows with "?". In the session-start table, `2?` means
the entry is the second one and is unverified. A row without a number has no documented
position: Cursor, for example, does not document where it puts the skills listing. JSON output
has the `certainty` field and the `evidence` keys, which point into `context.sources`.

### Sizes and ≈tokens

- `bytes`: the size of the file on disk.
- characters: the code points the agent receives, after documented transforms such as Codex's
  byte cut and Claude Code's removal of block HTML comments. JSON calls them `chars`.
- `≈tokens`: characters divided by 4, rounded up. This is an estimate, not a tokenizer count. It
  is rough for code and for non-Latin text, and it never causes a finding or changes the score.

For a skill, the session-start size is its listing entry (name and description). The body loads
when the model uses the skill and is shown as `body ... bytes ≈ ...` under On demand. A file that
a limit cuts shows where: `services/billing/AGENTS.md (cut at byte 3,359, line 50)`.

## Assumptions and what is not visible

The repository does not show everything that decides what an agent loads. Each plan states what
it assumed, and where the value came from:

| Origin        | Meaning                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| `default`     | The agent's documented default                                               |
| `rule-option` | An agentcheckup rule option, such as `maxBytes` of `instr/codex-size-budget` |
| `repository`  | A value read from a file in the repository                                   |
| `flag`        | A command-line flag, such as `--context-window`                              |

Today's assumptions:

- **Claude Code:** the default instructions mode (`AGENTS.md` only when no `CLAUDE.md` is on the
  path), Claude Code 2.1.277 or later, an interactive session, a trusted workspace.
- **Codex:** the 32,768-byte `project_doc_max_bytes`, `.git` as the project root marker, no
  fallback file names, a trusted project, and an unknown context window unless you pass one.
- **Cursor:** Agent mode, third-party configs turned on, a trusted workspace.

If you changed one of these, for example raised Codex's `project_doc_max_bytes`, set the matching
rule option in `agentcheckup.config.json` and the plan uses your value:

```json
{
  "rules": {
    "instr/codex-size-budget": ["error", { "maxBytes": 65536 }]
  }
}
```

"Not visible" lists the scopes that can add instructions, skills, servers or hooks from outside
the repository: managed settings, `~/.claude`, `~/.codex`, `$CODEX_HOME/AGENTS.md`,
`~/.agents/skills`, `~/.cursor`, Cursor Team Rules and User Rules, claude.ai connectors and
installed plugins. agentcheckup never reads them ([ADR 0003](adr/0003-treat-scanned-repositories-as-hostile.md)),
so a plan describes what the repository contributes, not everything the agent sees. Text output
summarizes these scopes; JSON and Markdown list every location.

## The working directory: `--cwd`

What an agent loads depends on where the session starts. `--cwd` takes a directory relative to
the scanned path, without `..`, that exists in the scan. The default is the root.

```text
$ npx agentcheckup context --cwd packages/api --agent codex
Codex context · packages/api
…
At session start                         bytes  ≈tokens
  1  AGENTS.md                             786      197
  2  packages/api/AGENTS.md                198       50
  3  Skills listing (1 skill, metadata)    163       41
                                  Total  1,147    ≈ 287
```

- **Claude Code** reads `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` from the root
  down to the working directory, root first. Files in directories below it load on demand.
  Skills come from `.claude/skills` in the working directory and each directory above it.
- **Codex** reads one file per directory, from the project root (the nearest directory with
  `.git`) down to the working directory: `AGENTS.override.md` if it exists, otherwise
  `AGENTS.md`, within 32,768 bytes across the chain. Without a `.git` it reads only the working
  directory's file. Codex does not load `AGENTS.md` files below the working directory at all.
- **Cursor** treats `--cwd` as the folder you open in Cursor: that folder is its project root,
  and files outside it are not part of the workspace.

## The context window: `--context-window`

Some limits depend on the model's context window, which the repository does not show. Pass it in
tokens, for example `--context-window 200000`:

- Claude Code lists skills within 1% of the context window. Without the flag, that limit is
  unknown (`null` in the JSON `limits`); each skill's listing entry is still cut at 1,536
  characters.
- Codex lists skills within 2% of the context window, or 8,000 characters when it does not know
  the window.

The flag is recorded as an assumption with origin `flag`. On a regular scan it needs
`--context`.

## The matrix

`--matrix` plans every agent in the root directory, plus Codex in each directory that has an
`AGENTS.md` or `AGENTS.override.md`, because the files Codex reads depend on where the session
starts. It then shows one row per configuration file and one column per agent:

```text
Files by agent              Claude Code   Codex       Cursor
.agents/skills/db-migrate   —             listed      listed
.claude/rules/testing.md    on-path       —           —
.claude/settings.json       startup       —           startup
.claude/skills/release      listed        —           listed
.cursor/rules/react.mdc     —             —           on-path
.cursor/rules/testing.md    —             —           skipped
.mcp.json                   startup       —           —
AGENTS.md                   skipped       startup     startup
CLAUDE.md                   startup       —           startup
packages/api/AGENTS.md      skipped       start-dir   on-path
packages/web/AGENTS.md      skipped       start-dir   on-path
```

Rows are instruction files, rule files, skills (by skill directory) and the files that declare
MCP servers and hooks. Commands, subagents and imported files such as a `README.md` do not get
rows. Rows that no agent reads are left out, and so are files the configuration ignores (see
[Files the configuration ignores](#files-the-configuration-ignores)); the plans above the matrix
count them. Directories with an ignored `AGENTS.md` get no Codex plan of their own.

| Cell             | Meaning                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `startup`        | Loaded at session start. MCP servers and hooks the agent asks about first count here: they start with the session |
| `on-path`        | Loaded when the agent opens a file the entry covers                                                               |
| `start-dir`      | Loaded only when a session starts in that directory or below it, as Codex does with a nested `AGENTS.md`          |
| `listed`         | A skill in the skills listing; its body loads when the model uses it                                              |
| `model-selected` | Loaded when the model picks it                                                                                    |
| `manual`         | Loaded only when you ask for it                                                                                   |
| `partial`        | Loaded, but a limit cuts it                                                                                       |
| `skipped`        | The agent skips it; the plan says why                                                                             |
| `unknown`        | Not documented, or the file could not be analyzed                                                                 |
| `—`              | Not read by this agent (`not-read` in JSON)                                                                       |

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
| `context.agents`                    | The planned agents, in a fixed order                                                                                                            |
| `context.plans[]`                   | One plan per agent and working directory: `agent`, `cwd` (`""` is the root)                                                                     |
| `plans[].entries[]`                 | `id`, `role`, `trigger`, `position` (startup only), `path`, `realPath`, `size`, `deferred`, `truncated`, `certainty`, `evidence`, `inventoryId` |
| `plans[].skipped[]`                 | `id`, `role`, `path`, `code` (why), `ruleId` (the rule that reports it, when one does), `size`, `fix`, `certainty`, `evidence`                  |
| `plans[].assumptions[]`, `hidden[]` | What the plan assumed, and the scopes it cannot see                                                                                             |
| `plans[].limits[]`                  | Usage of each documented limit: `key`, `unit`, `limit` (`null` when it depends on an unknown context window), `used`, `subject`, `effect`       |
| `plans[].totals`                    | `startup` and `onDemand` sizes                                                                                                                  |
| `plans[].incomplete[]`              | What could not be analyzed, such as `unparsed:.codex/config.toml`                                                                               |
| `plans[].ignored`                   | How many files the plan leaves out because the configuration's `ignore` matches them; absent when none                                          |
| `context.matrix.rows[]`             | With `--matrix`: `path`, `kind`, and `cells`, where `cells[i]` belongs to `context.agents[i]`                                                   |
| `context.sources`                   | Every source an `evidence` key points to: title, URL, the date it was checked                                                                   |
| `inventory`                         | Every MCP server, hook, permission and env override, whether or not an agent loads it. Every report has it                                      |
| `baseline`                          | With `--baseline`: the comparison described below                                                                                               |
| `pathBase`                          | The prefix added to every path when the scanned directory is not the current directory                                                          |

Output is deterministic: the same files give byte-identical JSON. Paths are relative and never
absolute. JSON paths are relative to the current directory, as in a scan; text and Markdown
output use paths relative to the scanned directory.

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

### Gate classes

`--gate` takes a comma-separated list of classes, `security` for all of them, or `none`. It
needs `--baseline`. Only additions and changes trip it; removals never do.

| Class          | Trips when                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mcp`          | An MCP server is added or changed, or a new MCP config file appears that agentcheckup cannot analyze, such as a `.mcp.json` with invalid JSON, a `.codex/config.toml` or a `.vscode/mcp.json`                                                                                                                                                                                  |
| `mcp-unpinned` | An added or changed MCP server runs a package that is not pinned to an exact version or a digest, or runs a local command whose version cannot be told. Remote servers reached by URL never trip it                                                                                                                                                                            |
| `permissions`  | An entry that lets an agent do more without asking is added, or now takes effect or is now broad: any `permissions.allow` or `permissions.additionalDirectories` entry, a skill's `allowed-tools`, an `enabledMcpjsonServers` entry, `enableAllProjectMcpServers` or Gemini CLI `trust` set to `true`, or `defaultMode` set or changed. `deny` and `ask` entries never trip it |
| `hooks`        | A hook is added or changed, on any event                                                                                                                                                                                                                                                                                                                                       |
| `env`          | An env override that sets an endpoint, a credential, TLS behavior or code execution is added or changed. Overrides of other variables never trip it                                                                                                                                                                                                                            |
| `unicode`      | A new [risk/hidden-unicode](rules/risk/hidden-unicode.md) finding appears                                                                                                                                                                                                                                                                                                      |

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

**How much does a session in this package start with?**

```sh
npx agentcheckup context --cwd packages/billing --agent codex
```

The `Total` row is the session-start context from the repository. A row ending in `(cut at byte
…)` is where Codex stops reading.

**What changed in this pull request?**

```text
Since the baseline
✖ 4 security-relevant changes need review
    New MCP server, not pinned: New MCP server browser (stdio, npx -y @acme/browser-mcp, not pinned)
    Permission widened: permissions.allow adds Bash(curl:*)
    New hook: New hook SessionStart → scripts/hooks/session-start.sh
    Env override: Env override ANTHROPIC_BASE_URL → https://llm-proxy.example.net
Findings: 0 new, 4 unchanged, 1 resolved
Session-start context: Claude Code ≈76 → ≈276 tokens (+200)
```

**A Markdown report for a wiki or a pull request comment:**

```sh
npx agentcheckup context --matrix --format markdown --output agent-context.md
```

## Limitations

- **Static analysis.** Plans apply documented loading behavior to the files in the repository.
  A remote flag, an experiment, a setting outside the repository or a bug in the agent can change
  what it actually loads.
- **Repository scope.** User, managed, team and account scopes are listed, never read.
- **Three agents.** Load plans exist for Claude Code, Codex and Cursor. GitHub Copilot, Gemini
  CLI, Devin Desktop and Cline are covered by rules only; their plans will follow.
- **Estimates.** Token counts are characters divided by 4.
- **No TOML.** `.codex/config.toml` is reported as not analyzed; Codex MCP servers and hooks
  declared there are not listed and not compared.
- **Ordering.** Cursor does not document the order in which it assembles instructions and
  rules. Its plan lists instruction files first, then rules, each by path, so read Cursor's
  numbers as a listing order, not as the order in the prompt.
- **Behavior changes.** Agents change how they load files every few releases. Plans cite the
  sources they rely on with the date each was checked, and a weekly job reports when a cited
  source changes. Report a plan that disagrees with your agent as a bug, with the agent's version.
