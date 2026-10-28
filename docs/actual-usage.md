# Compare configuration cost with what sessions spend

[`agentcheckup tokens`](tokens.md) measures what the repository's configuration puts in context
before the first message, and what each subagent call starts with. A session spends more: the
conversation, the files the agent reads, tool output and tool definitions. agentcheckup reads no
transcripts and no telemetry ([ADR 0003](adr/0003-treat-scanned-repositories-as-hostile.md)), so
this page shows how to measure what sessions actually spend with each agent's own tools, and how
to read the two numbers together.

## Why the configuration's share matters

Claude Code "sends your full conversation with every request" and, with prompt caching,
re-reads it at the cached token rate ([Manage costs](https://code.claude.com/docs/en/costs)). The
context a session starts with is part of every request of that session, and a subagent's starting
context part of every request of that call. A `CLAUDE.md` of ≈2,000 tokens is read again on every
turn of every Claude Code session in the repository, and of every subagent call that loads it, and
it fills the context window for as long as the session runs. That makes the configuration a small
number per session and a large one per month: the place where a review of one file changes every
session.

## Claude Code, one developer

1. Measure the configuration:

   ```sh
   npx agentcheckup tokens --agent claude-code
   ```

2. Start a session in the same directory and run `/context` before the first message. It shows a
   live breakdown of the context window by category, including which `CLAUDE.md` and auto memory
   files loaded. agentcheckup's At start covers what the repository adds: its instruction files
   and the skill and subagent listings. The rest is what agentcheckup lists as not visible: the
   system prompt, tool definitions (MCP tools among them), auto memory, and user and managed
   files.
3. Run `/usage` at the end of a session. Its Session block lists input, output, cache read and
   cache write tokens by model, and a `Prompt cache (main)` line with the share of input served
   from cache, for the main conversation only. On a Pro, Max, Team or Enterprise plan it also attributes recent usage to skills,
   subagents, plugins and MCP servers, as percentages of the total.
4. For a number on every turn, a [status line](https://code.claude.com/docs/en/statusline) script
   can print `context_window.total_input_tokens` or `context_window.used_percentage` from the JSON
   Claude Code sends it.

`/usage` computes cost at list price unless the organization's managed settings set
`modelPricing`; the Console's usage page is authoritative for billing
([Manage costs](https://code.claude.com/docs/en/costs)).

## Claude Code, a team: OpenTelemetry

Claude Code exports metrics through OpenTelemetry
([Monitoring](https://code.claude.com/docs/en/monitoring-usage)). Set the variables in managed
settings, or each developer's environment:

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp        # or prometheus
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc  # Claude Code has no default protocol
export OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.example:4317
```

`claude_code.token.usage` counts tokens after each API request, with these attributes among
others:

| Attribute      | Values                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------ |
| `type`         | `input`, `output`, `cacheRead`, `cacheCreation`; `input` leaves out cache reads and writes |
| `model`        | The model of the request                                                                   |
| `query_source` | `main`, `subagent` or `auxiliary`                                                          |
| `agent.name`   | The subagent type; a project's own subagents appear as `custom` by default                 |

To see each of your subagents by name, also set `OTEL_LOG_TOOL_DETAILS=1`, which sends the real
names of subagents, skills and MCP servers on the counters (Claude Code 2.1.273 or later), and
also tool parameters, such as Bash commands and tool input, in tool events and spans: decide what
your backend may hold first. Then compare, per subagent:

- the tokens `query_source = subagent` requests use, grouped by `agent.name` and `model`, with
- what `agentcheckup tokens` says each call of that subagent starts with, and the model it runs on.

A subagent called often with a large starting context shows up in both. One on an expensive model
shows up in OpenTelemetry by `model`, and agentcheckup names the definition or setting that picks
that model. `claude_code.cost.usage` counts USD with the same attribution attributes, without
`type`.

## Other agents

- **Codex:** `/status` displays session configuration and token usage, with the remaining context
  capacity, and `/usage` shows account token usage
  ([Slash commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)).
  OpenTelemetry is off by default; an `[otel]` table in `config.toml` with an `otlp-http` or
  `otlp-grpc` exporter sends events, with token counts on `codex.sse_event` for
  `response.completed`, and a per-turn token usage metric
  ([Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)).
- **Gemini CLI:** `/stats model` shows token counts and quota information for the session
  ([Commands](https://geminicli.com/docs/reference/commands)). Telemetry, off by default, counts
  tokens by model and type in `gemini_cli.token.usage`
  ([Telemetry](https://geminicli.com/docs/cli/telemetry)).
- **GitHub Copilot CLI:** `/context` shows the context window's token usage, and `/usage` the
  session's per-model token totals
  ([CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)).
- **Copilot in VS Code and the cloud agent, Cursor and Devin Local** report usage in their account
  dashboards; what they show, and whether in tokens or requests, depends on the plan.

[ccusage](https://github.com/ccusage/ccusage), a third-party MIT tool, sums token usage and cost
per day, session or billing window from the local data of Claude Code, Codex, Gemini CLI and other
agent CLIs. It reads the session data the agents keep on your machine, which agentcheckup leaves
alone.

## Read the two together

| Question                                              | agentcheckup                                 | The agent                                         |
| ----------------------------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| What does every session start with, from the repo?    | `tokens`: At start                           | `/context` before the first message               |
| Which subagent's starting context is the largest?     | `tokens`: Largest subagent calls             | OpenTelemetry by `agent.name`                     |
| Which model does each subagent run on?                | `tokens` and `agents`                        | OpenTelemetry by `model` and `query_source`       |
| Did a pull request make every session more expensive? | `tokens --baseline`, `subagentStartupTokens` | The trend after the change merges                 |
| What does a month of sessions cost?                   | Not visible                                  | `/usage`, the Console, your OpenTelemetry backend |

agentcheckup answers the first four before a change merges, from the repository alone; the agent's
numbers confirm them afterwards and cover what no file shows.
