# What agent configuration costs in context

`agentcheckup tokens` shows, for each coding agent, how many tokens the repository's
configuration puts in its context: what is there from the first message, the listings the model
picks skills and subagents from, the most later triggers can add, and what each subagent call
starts with in a context window of its own, with the model it runs on.

The numbers come from the same load plans as [`agentcheckup context`](context.md). They are
estimates, characters divided by 4, not tokenizer counts, and they never cause a finding.
agentcheckup reads only the repository: it does not start an agent or watch a session. For what a
session actually spends, see [Actual usage](#actual-usage).

```sh
npx agentcheckup tokens                          # every agent among the targets, session in the root
npx agentcheckup tokens --agent claude-code      # one agent
npx agentcheckup tokens --cwd packages/api       # a session started in packages/api
npx agentcheckup tokens --by-directory           # rank the directories a session can start in
npx agentcheckup tokens --format markdown        # the same, as Markdown tables
npx agentcheckup tokens --format json            # the report, with the summary as "tokens"
```

The examples on this page come from a small monorepo: a root `CLAUDE.md` and `AGENTS.md`, a
`CLAUDE.md` and an `AGENTS.md` in `packages/api`, a Claude Code skill `api-conventions`, two
subagents in `.claude/agents` (`reviewer` on `opus`, which preloads the skill, and `test-runner`
on `haiku`, with `omitClaudeMd: true`), and a Cursor agent `planner` in `.cursor/agents`.

## Reading the summary

```text
$ npx agentcheckup tokens --agent claude-code,codex,cursor
Context cost by agent · ./  ≈tokens
               At start  Listings  On demand  Subagents
  Claude Code        95        59         77          2
  Codex              17         0          0          0
  Cursor            126        73         55          3

Largest subagent calls, each in a context window of its own
  ≈tokens  Agent        Subagent     Model                   File
      101  Claude Code  reviewer     opus                    .claude/agents/reviewer.md
       23  Cursor       reviewer     opus (not documented)   .claude/agents/reviewer.md
       15  Cursor       planner      model not visible       .cursor/agents/planner.md
       14  Claude Code  test-runner  haiku                   .claude/agents/test-runner.md
       14  Cursor       test-runner  haiku (not documented)  .claude/agents/test-runner.md
…
```

| Column    | What it counts                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At start  | What is in the agent's context from the first message: instruction files, rules without paths, imports, and the listings. `?` marks a plan with unverified rows |
| Listings  | Of At start: the names and descriptions of the skills and subagents the model picks from                                                                        |
| On demand | The most other triggers can add: skill bodies, rules for matching files, nested instruction files, as far as a limit such as Claude Code's per-file one lets in |
| Subagents | The subagents the agent loads or may load, picked from the listing or run by name only                                                                          |

**Largest subagent calls** lists what each subagent starts with when the model calls it, largest
first, at most ten (`--format json` has every one). A call does not add to the agent's numbers:
it runs in a context window of its own. What a call counts depends on the agent:

- **Claude Code** documents it: the subagent's prompt, the instruction files the session loads at
  startup unless the definition sets `omitClaudeMd: true`, the body of each skill its `skills`
  field preloads, and the first 200 lines or 25 KB of the `MEMORY.md` its `memory` field adds. In
  the example, `reviewer` starts with its prompt (≈23), the root `CLAUDE.md` the session loads at
  startup (≈37) and the `api-conventions` skill (≈42); `test-runner` with its prompt only.
- **The Copilot CLI** gives a custom agent the repository's instruction files only when it sets
  `include-custom-instructions: true`
  ([Custom agents](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#repository-custom-instructions-for-subagents));
  the call counts them then.
- **Codex** adds its skills instructions block unless the agent file sets
  `skills.include_instructions = false`; the call counts the session's skills listing for it.
- **The other agents** document only that the file's body is the subagent's prompt, so the call
  counts the prompt, and whether instruction files reach the subagent is listed as not
  documented.

A few rows read differently:

- `not measured` is a subagent the agent may load whose file agentcheckup cannot read, such as
  one with a YAML merge key, larger than the scan reads, or a symlink outside the repository. It
  comes first.
- `+` after a number means the call also starts with files the scan did not read, such as a
  preloaded skill larger than it reads: the number is a lower bound.
- `(if it loads)` marks a definition that shares its name with another, where the agent does not
  document which one wins: its call runs only if it is the one that loads.
- `?` marks a call with an unverified part.

**Model** is the model the call runs on, as far as the repository says: the definition's own
`model`, else a repository setting such as Claude Code's `CLAUDE_CODE_SUBAGENT_MODEL` (shown as
`(setting)`), else the session's model from a repository setting (`(session)`). `model not
visible` means the user, the organization or the call itself chooses it, and `(not documented)`
a value outside the ones the agent documents, which it may not run as written: Cursor documents
only `inherit` and its own model ids. The same file read by two agents can run on different
models, and Cursor reads Claude Code's folder too.
[`agentcheckup agents`](agents.md) explains each one.

[`agentcheckup context`](context.md#subagent-calls) shows each call's parts, the skills a
definition names and does not get, and its memory file.

## Start directories: `--by-directory`

In a monorepo, a session started in a package can load more than one started at the root.
`--by-directory` also plans every agent in each directory below the root that holds an
instruction file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules` and the like) or owns a
folder of agent configuration (`.claude`, `.codex`, `.cursor`, `.github` and the like), and ranks
them by what a session there starts with:

```text
Start directories by context at start  ≈tokens
                Claude  Codex  Cursor
  ./                95     17     126
  packages/api     130     30      48
```

A session in `packages/api` gets the root's `CLAUDE.md` and its own in Claude Code, so it starts
larger. Cursor takes `packages/api` as the folder opened, so the root's files and agent folders
are not part of it.

agentcheckup plans at most 50 such directories, in path order, and says how many more there are;
plan one of those with `--cwd`. `--by-directory` works from the root only. `?` marks a number
with an unverified row, as in the summary. The JSON report keeps each directory's totals, not its
plans, so it stays small in a large monorepo; `--cwd` gives one directory's plans in full.

## Changes in a pull request

With `--baseline`, the report also says how context at start and each subagent call moved since a
report of the base branch. The baseline is the JSON report of `agentcheckup tokens`,
`agentcheckup context` or a scan with `--context`:

```text
$ npx agentcheckup tokens --agent claude-code --format json --output base.json   # base branch
$ npx agentcheckup tokens --agent claude-code --baseline base.json               # pull request
…
Since the baseline
Findings: 0 new, 2 unchanged, 0 resolved
Session-start context:
  Claude Code ≈95 → ≈127 tokens (+32), subagent calls reviewer ≈101 → ≈134 (+33)
```

Here the pull request adds two lines to the root `CLAUDE.md`. Every Claude Code subagent call that
loads the session's instruction files grows with it; `test-runner`, with `omitClaudeMd: true`,
does not. Up to three calls per agent are named; the Markdown output lists up to ten in a
table.

`--gate` works as in [`agentcheckup context`](context.md#baselines-and-the-gate). No gate class
counts tokens: to fail a run on them, set budgets in an
[organization policy](policy.md#subagent-budget).

## Budgets

A policy can cap both numbers for each agent:

```json
{
  "policyVersion": 1,
  "name": "acme",
  "budgets": {
    "claude-code": { "startupTokens": 8000, "subagentStartupTokens": 20000 }
  }
}
```

`startupTokens` caps At start in any plan of the agent; `subagentStartupTokens` caps every one of
its subagent calls. Both read the plans at the root, and Codex's in each directory with an
`AGENTS.md`, and fail closed: a subagent whose call cannot be measured fails its budget. See
[startup-budget](policy.md#startup-budget) and [subagent-budget](policy.md#subagent-budget).

## JSON

`--format json` writes the context report, valid against
[schemas/report.schema.json](../schemas/report.schema.json), with the summary as `tokens`. It can
serve as a later baseline.

| Field                          | What it holds                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.agents[]`              | One row per agent: `agent`, `cwd`, `startup`, `listings`, `onDemand`, `subagents`, `unverified`                                                                                                      |
| `tokens.calls[]`               | Every subagent call, those not measured first, then largest first: `agent`, `cwd`, `id`, `path`, `name`, `tokens`, `unmeasured`, `unverified`, `mayRun`, `model` (`value`, `source`, `undocumented`) |
| `tokens.directories[]`         | With `--by-directory`: `cwd`, `largest`, and `agents[]` with each agent's `startup` and `unverified`, largest first                                                                                  |
| `tokens.directoriesNotPlanned` | With `--by-directory`: how many more directories hold agent configuration                                                                                                                            |
| `context.directories`          | With `--by-directory`: each start directory's `cwd` and its agents' startup totals, not their plans, and `notPlanned`                                                                                |
| `context.plans[].entries[]`    | For a subagent, `ownContext`: what a call starts with, part by part, and the preloads it does not get                                                                                                |

`tokens` is absent for a call nothing of can be measured, and a lower bound when `unmeasured`
names files the scan did not read. `mayRun` marks a definition that runs only if it is the one of
its name that loads. `model.source` is `definition`, `setting`, `session` or `not-visible`, and
`undocumented` marks a value the agent does not document. Paths are relative to the current
directory, as in every JSON report.

## Actual usage

agentcheckup measures the configuration, not the sessions that use it. What a session actually
spends depends on the conversation, the files the agent reads and the tools it calls. To see it:

- **Claude Code:** `/usage` and `/context` in a session; for teams, its
  [OpenTelemetry metrics](https://code.claude.com/docs/en/monitoring-usage), which count tokens
  by model and, with `query_source`, separate the main conversation from subagents.
- **Other agents:** their own usage views.

Comparing the two tells you how much of a session is configuration: `tokens` shows what every
session pays before the first message, and what every subagent call pays before its task.
[Compare configuration cost with what sessions spend](actual-usage.md) walks through it for each
agent, with OpenTelemetry for teams.

## Limitations

- **Estimates.** Characters divided by 4: rough for code and for non-Latin text. A tokenizer
  count would need the model's tokenizer, which for Claude runs only through an API, and
  agentcheckup makes no network requests.
- **Not visible.** User, managed and plugin scopes, tool definitions (MCP tools among them), the
  task message a session writes when it calls a subagent, git status, and anything outside the
  repository, such as user-scope memory, are not counted. `agentcheckup context` lists them per
  agent.
- **Subagents of other agents.** Whether instruction files reach the subagents of Cursor,
  Gemini CLI, Copilot in VS Code and cloud, and Devin Local is not documented, so their calls
  count the prompt only.
- **Skills that run as subagents.** A Claude Code skill with `context: fork` runs in a subagent of
  its own; its body is counted on demand in the session, not as a call.
- **A session that runs as a subagent.** The `agent` setting starts every session as one of the
  repository's subagents, whose prompt replaces the default system prompt. At start does not
  count that prompt.
- **A listing past its budget.** When Claude Code's skills listing passes its budget, it shortens
  descriptions; At start counts the full listing, and the plan's limits say it is over. The plan
  measures against Claude Code's defaults, 1,536 characters per skill and 1% of the context
  window: `skillListingMaxDescChars` and `skillListingBudgetFraction` in the settings are not
  applied.
- **Models with `--cwd`.** The Model column resolves a definition's model from the root's
  settings, as [`agentcheckup agents`](agents.md) does; a setting in the working directory's own
  `.claude/settings.json` is not applied to it.
- **Denied subagents.** A Claude Code subagent that `permissions.deny` blocks with `Agent(name)` is
  still listed and its call counted: whether Claude Code also leaves it out of the listing is not
  documented.
