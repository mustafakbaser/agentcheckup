# Agent definitions and models

`agentcheckup agents` lists the custom agents and subagents a repository defines and the model
each one runs on, as far as the repository can tell. Every scan's JSON report carries the list
for every agent in its `agents` field, whatever the targets.

```sh
npx agentcheckup agents                          # every agent among the configured targets
npx agentcheckup agents --agent claude-code      # one agent
npx agentcheckup agents --format markdown        # tables, for a job summary
npx agentcheckup agents --format json            # the scan report, with `agents`
```

A file is listed once for every agent that reads it: Cursor and GitHub Copilot read Claude
Code's `.claude/agents` too, so one subagent can be four definitions, each judged by the agent
that reads it. `--agent` narrows the text, the Markdown and a comparison with `--baseline`; the
JSON report always holds every agent's definitions, so it can serve as any later baseline. The
decision is [ADR 0013](adr/0013-list-agent-definitions-and-their-models.md).

The same definitions are in each agent's [load plan](context.md#subagent-calls): their listing at
session start, and what each call starts with in a context window of its own.
[`agentcheckup tokens`](tokens.md) puts that next to the model each call runs on.

## What each agent reads

Only definitions an agent reads from the repository are listed. User folders such as
`~/.claude/agents`, plugins and managed settings are never read.

| Agent               | Files                                                                                                                                                              | Needs                                                                                                                                                                     | Known by                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Claude Code         | `.claude/agents/**/*.md`                                                                                                                                           | `name` and `description`                                                                                                                                                  | `name`                                            |
| Codex               | `.codex/agents/**/*.toml`, and the roles `[agents.<name>]` in `.codex/config.toml` declares, with the file its `config_file` names                                 | `name`, `description` and `developer_instructions`, each of its type; a file a role declares takes the role's name and description, and needs no `developer_instructions` | `name`, or the role's                             |
| Cursor              | `.cursor/agents/**/*.md`, `.claude/agents/**/*.md` and the Markdown in `.codex/agents`                                                                             | nothing: every field is optional; a file without frontmatter loads, unverified, except in `.claude/agents`                                                                | `name`, or the file name                          |
| Gemini CLI          | `.gemini/agents/*.md`, not in subfolders                                                                                                                           | frontmatter, with a `name` of lowercase letters, digits, hyphens and underscores, and `description` (a remote agent: `agent_card_url` or `agent_card_json` instead)       | `name`                                            |
| Copilot CLI         | `.github/agents/**/*.md`, then `.claude/agents` in Claude Code's format                                                                                            | `description`                                                                                                                                                             | the path below `agents`, such as `team--reviewer` |
| Copilot in VS Code  | `.github/agents/*.md`, not in subfolders, and `.claude/agents` in Claude Code's format                                                                             | nothing: the header is optional                                                                                                                                           | `name`, or the file name                          |
| Copilot cloud agent | `.github/agents/**/*.agent.md` at the repository root                                                                                                              | `description`                                                                                                                                                             | the file name                                     |
| Devin Local         | `.devin/agents/<name>.md`, or `<name>/` with `AGENT.md`, `AGENTS.md`, `agent.md` or `agents.md`, the first of them; the same under `.agents/agents` (experimental) | a name other than `subagent_explore` and `subagent_general`; a file without frontmatter loads, unverified                                                                 | `name`, or the file or directory name             |

An `AGENTS.md` or `GEMINI.md` directly in one of these folders documents it, and is read as the
instruction file it is. A Copilot file whose `target` is `vscode` is not the cloud agent's, and one
whose `target` is `github-copilot` is not VS Code's. The Copilot CLI's `models`, a list it tries
in order, wins over `model`.

Each definition has a status, which the JSON report writes as `loads`, `skipped`, `shadowed` and
`unknown`:

- **loads**: the agent lists it.
- **skipped**: the agent drops it, and the output says why, such as `no description`, or that
  the repository's settings turn the agent's custom agents off: Codex's `agents.enabled` or
  `features.multi_agent`, Gemini CLI's `experimental.enableAgents` or
  `agents.overrides.<name>.enabled`. The settings are those of a session started in the
  directory that owns the agent folder: for Codex every `.codex/config.toml` from the repository
  root down to it, the closest winning, for Gemini CLI that directory's `.gemini/settings.json`.
  [instr/subagent-invalid](rules/instr/subagent-invalid.md) reports the files Claude Code skips.
- **shadowed**: another definition wins, and the output names its file. Cursor takes
  `.cursor/agents` first; the Copilot CLI loads `.github/agents` before `.claude/agents` and keeps
  the first of an id, so two files with one `name` under two ids both load; a role
  `.codex/config.toml` declares wins over a Codex file of the same name; Devin Local reads one
  file of an `agents/<name>/` directory. Where the agent does not
  document which one wins, such as two files in one `.claude/agents` folder with the same name,
  the later file in path order is marked shadowed, as unverified.
- **unknown**, shown as "may not load": whether the agent loads it, or what it reads from it, is
  not documented: frontmatter only Claude Code's own reader accepts (see
  [Items declared in frontmatter](context.md#items-declared-in-frontmatter)), a `<<` merge key, a
  file past agentcheckup's parser limits, a Codex `config_file` outside the repository, or a file
  the scan did not read at all: larger than it reads, unreadable, or a symlink to a file outside
  the repository. A role `.codex/config.toml` declares keeps its precedence over a file of the
  same name even when it is unknown; the file is then shadowed, unverified.

Definitions in another directory's agent folder, such as `packages/api/.claude/agents`, are
marked `?`, unverified: they serve sessions started there, where they win over the root's, so a
name they share with the root's shadows neither. So are definitions in subfolders the
documentation does not mention, and in a folder spelled in another letter case, such as
`.Claude/agents`, which an agent finds only where the file system ignores case. Folders match on
whole path segments: `notes.cursor/agents` is not a `.cursor/agents` folder.

A Gemini CLI remote agent (`kind: remote`) needs a `name` and an `agent_card_url` or
`agent_card_json`, and no description: its agent card, outside the repository, describes it, so
its listing and its call are unverified
([Remote subagents](https://geminicli.com/docs/core/remote-agents/)). A file that lists several
remote agents is unknown.

A file an agent reaches through a symlink is read at the symlink's path, as what it is there.
With `.claude/agents -> ../.github/agents`, each Copilot agent file is also a Claude Code
subagent, and Cursor and Copilot read it from both folders.

## Model values

Each agent documents the values its files take for `model`. A value outside them is listed as
not documented. [agent/model-not-documented](rules/agent/model-not-documented.md) reports it for
the agent whose format the file is: a Claude alias in `.claude/agents` is right for Claude Code,
though Cursor does not document it, so only `agents` shows that.

| Agent                                    | Documented values                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                              | `sonnet`, `opus`, `haiku`, `fable` and the other aliases its `--model` flag takes, each with `[1m]`; a Claude model id, also as Amazon Bedrock and Google Cloud write them; `inherit` |
| Codex                                    | A model id. `inherit` is not one: leave `model` out to use the parent session's model                                                                                                 |
| Cursor                                   | `inherit`, or a Cursor model id, optionally with options such as `[effort=high]`                                                                                                      |
| Gemini CLI                               | `inherit`, or a model id                                                                                                                                                              |
| GitHub Copilot, in its own files         | A model id, or the name the model picker shows, such as `Claude Sonnet 4.5`; in VS Code also a list to try in order                                                                   |
| GitHub Copilot, reading `.claude/agents` | `sonnet`, `opus`, `haiku` or `inherit`                                                                                                                                                |
| Devin Local                              | The values of its `--model` flag, such as `opus`, `sonnet`, `swe` or `codex`                                                                                                          |

The forms are kept permissive where an agent takes any id: a custom provider can make any single
word a model, so only values no form covers are reported. An empty or null `model` is no model.
Values are shown with credentials removed, should a URL carry any.

## Where the model comes from

The model a definition runs on follows each agent's documented order. agentcheckup reads only
the repository's settings files at the root: `.claude/settings.json` and
`.claude/settings.local.json` (the local file wins), `.codex/config.toml`, `.gemini/settings.json`
and `.github/copilot/settings.json`.

| Agent                                             | Order, first wins                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                                       | The model a call passes (not visible); the definition's `model`, where `inherit` means the main conversation's model; `env.CLAUDE_CODE_SUBAGENT_MODEL`, unless it is `inherit`; the main conversation's model: `env.ANTHROPIC_MODEL`, then `model`, then the default for new sessions, `env.ANTHROPIC_DEFAULT_MODEL` |
| Codex                                             | The definition's `model`; `agents.default_subagent_model`; the session's `model`                                                                                                                                                                                                                                     |
| Gemini CLI                                        | `agents.overrides.<name>.modelConfig.model`; the definition's `model`; `model.name`                                                                                                                                                                                                                                  |
| Copilot CLI                                       | The definition's `models` or `model`; the repository's `model` setting                                                                                                                                                                                                                                               |
| Cursor, Copilot in VS Code and cloud, Devin Local | The definition's `model`; otherwise the model you pick, which the repository does not set                                                                                                                                                                                                                            |

While Claude Code's `env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is on, Claude Code ignores every
subagent's `model` and runs it on `CLAUDE_CODE_SUBAGENT_MODEL`, or on the main conversation's
model without it (Claude Code v2.1.257 or later).
[agent/subagent-model-ignored](rules/agent/subagent-model-ignored.md) reports each `model` that has
no effect. Claude Code's `env.ANTHROPIC_DEFAULT_OPUS_MODEL`, `_SONNET_`, `_HAIKU_` and `_FABLE_`
set what an alias resolves to; they are listed as model settings.

A model chosen where agentcheckup cannot look is shown as **set outside the repository**: user
and managed settings, environment variables, the model a call passes, and the model you pick in
the agent. Managed settings can also replace a model: Claude Code's `availableModels` substitutes
another for one it blocks. agentcheckup never guesses these.

## Model settings

The list ends with the repository settings that pick a model or an effort: Claude Code's
`model`, `env.ANTHROPIC_MODEL`, `env.ANTHROPIC_DEFAULT_MODEL`, `effortLevel`,
`env.CLAUDE_CODE_SUBAGENT_MODEL`, `env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, `availableModels` and
the alias targets above; Codex's `model`, `model_reasoning_effort` and
`agents.default_subagent_*`; Gemini CLI's `model.name` and per-agent overrides; the Copilot CLI's
`model` and `effortLevel`. Each says what it sets: sessions, subagents, the models allowed, or an
alias target. Settings in subdirectories are listed too, since a session started there reads
them; the model a definition runs on is worked out from the root's.

## JSON

The `agents` field of a report holds `definitions` and `settings`, each sorted by id, as
[schemas/report.schema.json](../schemas/report.schema.json) describes:

```json
{
  "id": "agent:.claude/agents/reviewer.md@claude-code",
  "file": ".claude/agents/reviewer.md",
  "line": 2,
  "agent": "claude-code",
  "name": "reviewer",
  "status": "loads",
  "model": { "value": "opus", "form": "alias", "line": 4 },
  "effective": { "value": "opus", "source": "definition" },
  "tools": "listed",
  "certainty": "documented",
  "evidence": ["claudeSubagents"],
  "digest": "3f1c2a9b7d04e"
}
```

- `id` is `agent:<file>@<agent>`; a role `.codex/config.toml` declares without a file of its own
  is `agent:<file>#<name>@codex`. A setting is `model:<file>#<key>`.
- `effective.source` is `definition`, `setting` (a setting for subagents), `session` (the
  session's model, for a definition that inherits it) or `not-visible`. `effective.overridden`
  names the setting that makes the agent ignore the definition's own model.
- `digest` covers what the file says and what the agent does with it, without lines and without
  `effective`, which settings decide: a changed setting is a changed setting, not a change of
  every definition that inherits it. For a file the agent may read and agentcheckup cannot, it
  covers the file's text, so any change of it is a change.

## Baselines, the gate and policies

- `--baseline` compares definitions and settings by id, and lists the ones added, removed and
  changed. `--gate models` trips when a definition is added or changes, when one runs on another
  model because a setting changed, and when a model setting is set, changed or removed: removing
  an override changes what runs. Removing a definition never trips it. `models` is not a security
  class, so `--gate security` leaves it out. See [Gate classes](context.md#gate-classes).
- With `agents --agent`, the comparison covers only those agents, so `--gate models` sees only
  their definitions. A scan with `--gate models` covers every agent, whatever the targets.
- A [policy](policy.md#model-not-allowed) can allow or deny, per agent, the model values
  definitions and settings name.
- A fix never counts a model change as a gate effect: it stays as safe as its rule declares it.

## Limits

- **Repository scope only.** User, managed and plugin agents and settings are never read, and
  neither is the environment a session starts with.
- **Static.** The list says what the files set, not which model a running session uses: aliases
  resolve to different versions on different providers, and an agent may substitute a model it
  cannot use.
- **Load plans.** `agentcheckup context` plans Claude Code's subagents; the other agents' custom
  agents are listed here, not in their load plans.
- **Not read yet:** MCP servers a Copilot custom agent declares in `mcp-servers` (such a file is
  incomplete, so the gate and a policy fail closed), Copilot's repository model list
  `.github/allowed_models.txt`, and Copilot's `modelPolicy`.
- **Suppressions.** A finding in a Codex agent's TOML file cannot be suppressed inline; turn the
  rule off for that path in the configuration's `overrides`.
- **Cline** defines no custom agents in a repository, so it has none.
