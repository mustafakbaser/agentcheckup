# agentcheckup

**See what each coding agent actually loads from your repository, and what a pull request changes about it.**

[![npm](https://img.shields.io/npm/v/agentcheckup)](https://www.npmjs.com/package/agentcheckup)
[![CI](https://github.com/mustafakbaser/agentcheckup/actions/workflows/ci.yml/badge.svg)](https://github.com/mustafakbaser/agentcheckup/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/mustafakbaser/agentcheckup/badge)](https://scorecard.dev/viewer/?uri=github.com/mustafakbaser/agentcheckup)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-agentcheckup-blue?logo=github)](https://github.com/marketplace/actions/agentcheckup)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin and Cline read different files from
the same repository, and they rarely say what they skipped. agentcheckup shows, for each agent,
what is in context when a session starts, what loads later, what it costs in tokens, and what is
skipped and why. It
checks every file against how the agents load it, fixes what has one correct form, writes the
rest as tasks for your coding agent, lists every custom agent and subagent with the model it runs
on, and flags new MCP servers, hooks, permissions and environment overrides in pull requests.

```sh
npx agentcheckup context   # what each agent loads
npx agentcheckup tokens    # what that costs in context, per agent and per subagent call
npx agentcheckup agents    # custom agents and subagents, and their models
npx agentcheckup           # what is wrong, and why
npx agentcheckup fix       # preview the fixes; changes nothing
npx agentcheckup tasks     # the rest, as a prompt for a coding agent
```

No configuration, no API key, no network requests, no telemetry. Node.js 22.12 or newer.

![Terminal recording: agentcheckup context --matrix shows which of nine agents load each file, Claude Code skipping AGENTS.md and an MCP server and Cursor skipping a .md rule; fix previews three fixes; fix --write applies only the safe one, an @AGENTS.md import in CLAUDE.md.](docs/assets/demo.gif)

The examples below run on one small repository: an `AGENTS.md`, a `CLAUDE.md` that imports a
missing `docs/setup.md`, a Cursor rule saved as `.md`, an MCP server with a `url` but no `type`,
a skill without a description, and a skill whose description does not say when to use it.
Output is trimmed.

## See what each agent loads

```text
$ npx agentcheckup context
Claude Code context · ./
…
At session start                          bytes  ≈tokens
  1  CLAUDE.md                               62       16
  2  Skills listing (2 skills, metadata)    119       30
                                   Total    181     ≈ 46

On demand
  .claude/skills/deploy/SKILL.md  body 41 bytes ≈ 11, when the model picks it
  .claude/skills/pdf/SKILL.md     body 17 bytes ≈ 5, when the model picks it

Skipped
  .mcp.json › docs           "url" without "type"                     mcp/url-without-type               fix: review
  AGENTS.md                  a CLAUDE.md on the path is read instead  instr/agents-md-ignored-by-claude  fix: safe
  CLAUDE.md › docs/setup.md  the import does not resolve              instr/import-unresolved

Codex context · ./
…
Cursor context · ./
…
Skipped
  .cursor/rules/style.md  only .mdc files are read here  cursor/md-file-ignored  fix: review

Copilot CLI context · ./
…
Gemini CLI context · ./: loads nothing from this repository
…
3 of 4 skips can be fixed: agentcheckup fix
```

Nine agents get a plan: Copilot counts three times, because its CLI, VS Code and cloud agent
read different files, and Devin Desktop's agent is Devin Local. Every plan also states its
assumptions, such as the Claude Code version and a trusted workspace, and the scopes it cannot
see, such as `~/.claude` and managed settings. `--cwd <dir>` plans a session started in another
directory, and the matrix shows the whole repository at once:

```text
$ npx agentcheckup context --matrix
…
Files by agent          Claude Codex Cursor Copilot       Devin Cline
                                            CLI VSC Cloud
.claude/skills/deploy   L      —     L      L   L   L     L     L
.claude/skills/pdf      L      —     L      L   L   L     L     L
.cursor/rules/style.md  —      —     X      —   —   —     U     —
.mcp.json               X      —     —      S   S   —     S     —
AGENTS.md               X      S     S      S   S   S     S     S
CLAUDE.md               S      —     S      S   S   S     S     —
Not shown: Gemini CLI reads none of these files

S  startup   loaded at session start
L  listed    in the skills listing; the body loads when used
U  manual    loaded only when you ask for it
X  skipped   not loaded; the plan says why
—  not-read  not read by this agent
```

Here Claude Code never sees `AGENTS.md` or the MCP server, Codex never sees `CLAUDE.md` or the
skills, Cursor ignores `style.md` because it is not an `.mdc` file, and Gemini CLI reads none
of these files.
[What each agent loads](docs/context.md) explains every column and cell.

In [80 public repositories](corpus/SUMMARY.md#what-agents-load) with agent configuration, the
nine agents load different instruction files at session start in 72 of the 73 repositories
where any of them loads instructions. By default, Claude Code skips the root `AGENTS.md` in 11 of
the 55 repositories that have one, because a `CLAUDE.md` is read instead.

## See which model each subagent runs on

Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot and Devin Local each read custom agents or
subagents from their own folders, and Cursor and Copilot read Claude Code's too. A `model` that is
right for one of them may mean nothing to another, and a repository setting may override it:

```text
$ npx agentcheckup agents --agent claude-code,cursor,gemini
5 agent definitions in 3 files (4 loaded, 1 skipped)

.claude/agents/helper.md
  Claude Code  helper    no model → haiku (subagent setting, .claude/settings.json)
  Cursor       helper    no model → set outside the repository
.claude/agents/reviewer.md
  Claude Code  reviewer  opus
  Cursor       reviewer  opus (not a value Cursor documents)
.gemini/agents/scout.md
  Gemini CLI   scout     gemini-3-flash · skipped: no description

Model settings
  .claude/settings.json:3  env.CLAUDE_CODE_SUBAGENT_MODEL = haiku  Claude Code subagents
…
```

Each file is listed once for every agent that reads it, with the model as written and where the
one it runs on comes from, in each agent's documented order. A model chosen where agentcheckup
cannot look, such as your user settings or the model a call passes, is shown as set outside the
repository, never guessed. Two rules report a model value the agent does not document and a
subagent model Claude Code ignores; `--gate models` asks for review when a pull request changes
a definition, a model setting or the model a subagent runs on, and a
[policy](docs/policy.md#model-not-allowed) can allow or deny models per agent.
[Agent definitions and models](docs/agents.md) has the details.

## See what agent configuration costs in tokens

Every session pays for its instruction files and for the listings the model picks skills and
subagents from, and every subagent call starts a context window of its own. For Claude Code, that
window holds the subagent's prompt, the session's `CLAUDE.md` files and the skills it preloads:

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
…
```

In [80 public repositories](corpus/SUMMARY.md#subagent-listings-and-calls-root-directory), 88%
of what Claude Code's 159 subagent calls start with is the session's instruction files, and none of
those subagents sets `omitClaudeMd`.

`--by-directory` ranks the directories of a monorepo by what a session started there loads, and
`--baseline` shows what a pull request adds, to context at start and to each subagent call. A
[policy](docs/policy.md#subagent-budget) can cap both. The numbers are estimates, characters ÷ 4,
from the repository alone: [What agent configuration costs in context](docs/tokens.md) explains
them, and how they relate to what a session actually spends.

## Find what is wrong

A scan starts with what each agent misses. Under each finding, a `why` line adds what the load
plans know and the message does not, and a `fix` or `how` line says what to do:

```text
$ npx agentcheckup
What each agent misses
  Claude Code  MCP server docs is skipped: "url" without "type"                                 fix: review
               AGENTS.md is skipped: a CLAUDE.md on the path is read instead (≈28 tokens)       fix: safe
               docs/setup.md is skipped: CLAUDE.md imports it, but the import does not resolve  manual
  Cursor       .cursor/rules/style.md is skipped: only .mdc files are read here (≈9 tokens)     fix: review

.claude/skills/pdf/SKILL.md
  3:14  ℹ info  The description does not say when to use the skill. Add a "Use when ..." clause with the situations and keywords that should trigger it.  skill/description-quality
                fix  needs your words (fix -i): Add a "Use when ..." sentence to "description" in .claude/skills/pdf/SKILL.md
…
AGENTS.md
  1:1  ⚠ warning  Claude Code reads "CLAUDE.md" in this directory and skips this AGENTS.md. Add the line "@AGENTS.md" to that file so Claude Code reads both.  instr/agents-md-ignored-by-claude
                  ↳ CLAUDE.md: Claude Code reads this file instead of AGENTS.md.
                  why  Claude Code never loads these ≈28 tokens; Codex, Cursor, Copilot CLI, Copilot in VS Code, Copilot cloud agent, Devin Local and Cline do.
                  fix  safe: Add "@AGENTS.md" as line 1 of CLAUDE.md

CLAUDE.md
  3:6  ✖ error  Imported file "docs/setup.md" does not exist, so Claude Code cannot load it.  instr/import-unresolved
                how  create "docs/setup.md" or correct the path; no file named "setup.md" exists

✖ 6 problems (3 errors, 2 warnings, 1 info)
  loading 2 errors, 2 warnings · correctness 1 error · clarity 1 info
Agent config score 72/100 (C) · ruleset 2026.10
Fixes: 1 safe (agentcheckup fix --write) · 3 need review (agentcheckup fix -i) · 1 needs your words (agentcheckup fix -i) · 1 manual
```

`--compact` prints only the findings, and `--verbose` adds each rule's docs URL, rationale and
sources. Each rule is backed by the agent's documentation or source code, for example:

- **[Codex stops reading `AGENTS.md` at 32 KiB](docs/rules/instr/codex-size-budget.md)**, counted
  across every `AGENTS.md` from the repository root down to the working directory.
- **[Claude Code ignores `AGENTS.md` when a `CLAUDE.md` exists](docs/rules/instr/agents-md-ignored-by-claude.md)**
  in the same directory or above it, unless `CLAUDE.md` imports it with `@AGENTS.md`.
- **[A `SKILL.md` without frontmatter on line 1](docs/rules/skill/frontmatter-missing.md)** is
  skipped by Codex and Gemini CLI, and
  **[a skill body over 500 lines](docs/rules/skill/body-too-long.md)** stays in Claude Code's
  context on every later turn.
- **[Imports that point to missing files](docs/rules/instr/import-unresolved.md)**, hook events an
  agent does not know, and hook timeouts in the wrong unit.
- **[Invisible Unicode](docs/rules/risk/hidden-unicode.md)** and
  [credentials committed in MCP configuration](docs/rules/mcp/literal-secret.md).

The rules and the load plans cover Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin
Desktop (formerly Windsurf) and Cline. The [rule catalog](docs/rules/README.md) lists all of
them.
[What coding agents read](docs/platforms.md) documents each agent's loading behavior with sources,
and [One configuration for every agent](docs/portability.md) shows how to share one setup.

## Fix what has one right answer

`agentcheckup fix` shows each fix as a diff, checked by scanning a fixed copy of the repository
in memory. It changes nothing:

```text
$ npx agentcheckup fix
…
review  cursor/md-file-ignored  Rename .cursor/rules/style.md to style.mdc and add "alwaysApply: true"
rename from .cursor/rules/style.md
rename to .cursor/rules/style.mdc
…
safe    instr/agents-md-ignored-by-claude  Add "@AGENTS.md" as line 1 of CLAUDE.md
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -1,3 +1,5 @@
+@AGENTS.md
+
 # Acme API

 Read @docs/setup.md before you start the service.
  effect: Claude Code session start ≈46 → ≈77 tokens
  effect: Cursor, Copilot CLI, Copilot in VS Code, Copilot cloud agent and Devin Local session start ≈64 → ≈67 tokens
…
input   skill/description-quality  .claude/skills/pdf/SKILL.md:3  needs your words: a "Use when ..." clause (agentcheckup fix -i)
…
manual  instr/import-unresolved  CLAUDE.md:5  create "docs/setup.md" or correct the path; no file named "setup.md" exists
Verified on an in-memory copy: 4 findings resolved, 2 new, 2 left · 2 need judgment: agentcheckup tasks
…
1 fix needs your words: run agentcheckup fix -i to answer it.
```

The 2 new findings are infos that the fixed files raise, such as a copied description too short
to match requests. A fix may add infos, never an error or a warning. What agentcheckup can do
about a finding is one of four things:

- **safe:** a fix with one correct form that keeps your text and adds or changes no MCP server,
  hook, permission or env override, such as the `@AGENTS.md` import. `fix --write` applies these.
- **review:** any other change agentcheckup can make, such as the rename above, a `"type"` that
  lets Claude Code start a server, or moving the largest sections of a long skill body into
  linked files. `fix --write --review` applies these too, and `fix -i` asks about each one.
- **needs your words:** the fix knows where the change goes, but you write it, such as a
  "Use when ..." sentence for a skill description. Only `fix -i` asks for the words.
- **manual:** no fix. The `how` line says what to do, and the next section hands it to an agent.

`fix -i` writes your words into a copy in memory and runs every rule on it before it offers the
change. An answer that does not resolve the finding, or adds a problem, is refused in the rule's
words and asked again:

```text
$ npx agentcheckup fix -i --rule skill/description-quality
…
(1/1) Add a sentence that says when to use this skill? [y]es [n]o [s]uppress [q]uit (Enter: no) y
a "Use when ..." clause › Use when the user asks to read, fill or merge PDF files.
…
-description: Extract text and tables from PDF files, fill forms and merge documents.
+description: "Extract text and tables from PDF files, fill forms and merge documents. Use when the user asks to read, fill or merge PDF files."
…
✓ re-scanned: the finding is resolved; no new problem.
Use this? [y]es [e]dit [n]o (Enter: yes)
…
Applied 1 fix to 1 file. Re-scanned: 1 finding resolved, 0 new, 5 left.
```

Nothing is written without `--write` or `-i`, and a dry run exits 1 when it would change a file.
Writes stay inside the scanned directory, never go through a symlink or a hard link, write each
file atomically, and are refused for a file that changed since the scan. `--untrusted` allows
only the preview. [Fixing findings](docs/fix.md) covers every option and lists every rule with a
fix; [ADR 0008](docs/adr/0008-write-fixes-to-the-scanned-repository.md) and
[ADR 0010](docs/adr/0010-fixes-beyond-deterministic-edits.md) have the design.

## Hand the rest to your agent

Some findings need judgment: the file a broken import meant, the commands a skill's
`allowed-tools` should allow. `agentcheckup tasks` writes them as a prompt for a coding agent,
with rules for every task and a check to run when it is done. It only reads.

```sh
claude "$(npx agentcheckup tasks)"   # or codex, or paste the output into any agent
npx agentcheckup tasks --check       # exit 0 when no task is open
```

```text
$ npx agentcheckup tasks
# agentcheckup tasks · 2 open · …
Rules for every task:
- Edit only the file a task names. Do not create, rename or delete files unless the task says so.
- Never add or widen allowed-tools, permissions, hooks, MCP servers or env overrides.
…
## 2/2 · ac-bb0bd14d · skill/description-quality (info)
File: `.claude/skills/pdf/SKILL.md` line 3, frontmatter key `description`
…
Current value:
~~~~untrusted
Extract text and tables from PDF files, fill forms and merge documents.
~~~~
Do: keep the meaning; say in one sentence what the skill does, with words from the skill body; end with one sentence starting "Use when" that names the requests and keywords that should trigger the skill.
…
## For you
These need the user's decision. Do not change them; list them for the user when you finish.
- `.mcp.json` line 3 · mcp/url-without-type (error): …
```

Findings with a ready fix are never tasks: step 0 of the prompt tells the agent to preview them
with `fix` and to ask you before it applies them. Credentials, hidden content, MCP servers,
hooks, permissions and settings are listed for you and never handed to an agent. Every command
in the prompt is pinned to the version you ran, repository text is fenced as data, and
credentials are redacted. `tasks --check <id>` exits 0 once a task's finding is gone and its
file still passes the rules that guard it.

To let your agent run this loop itself, install the agentcheckup skill:

```sh
npx agentcheckup skill install
```

It copies the skill into `.claude/skills/agentcheckup`, or `.agents/skills` when your targets
leave out Claude Code, after checking it in memory with every rule. The skill has the agent list
the tasks, preview fixes, ask you before every change and check each task. Its `allowed-tools`
pre-approve only read-only agentcheckup commands; the pull request gate below flags them once,
in the pull request that adds the skill. See [Tasks for a coding agent](docs/tasks.md) and
[The agentcheckup skill](docs/skill.md).

## Gate pull requests

A pull request that adds an MCP server, a hook or a permission changes what runs on your
developers' machines. A well-formed change produces no lint finding, so nothing asks for review.
The [agentcheckup GitHub Action](https://github.com/mustafakbaser/agentcheckup-action) scans the
base commit and the pull request, and fails the check when a change needs review:

```yaml
name: agentcheckup
on:
  pull_request:
permissions: {}
jobs:
  agentcheckup:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - uses: mustafakbaser/agentcheckup-action@v0.1.0
```

The gate looks at what changed since the base commit; removals never trip it. By default it
fails the check when a pull request adds or changes an MCP server (or an MCP config file
agentcheckup cannot analyze), a hook, a permission that lets an agent do more without asking
(a `permissions.allow` entry, a skill's or command's `allowed-tools`, auto-approved MCP
servers, `defaultMode`), an env override that sets an endpoint, a credential, TLS behavior or
code execution, or hidden Unicode. Hooks, MCP servers and permission modes that skills,
commands and subagents declare in their frontmatter count too, and so does the subagent that
Claude Code's `agent` setting starts every session as. New lint findings at or above `error` fail
it too; findings already on the base branch do not. Agent definitions and model settings are not
a security class: add `models` to the gate classes to review those changes too. The job summary for a pull request that adds an MCP server, widens a
permission, adds a hook and points Claude Code at another API endpoint starts like this, followed
by the session-start context per agent and the findings:

> **Needs review: 4 security-relevant changes**
>
> | Change                         | Where                                | Detail                                                               |
> | :----------------------------- | :----------------------------------- | :------------------------------------------------------------------- |
> | **New MCP server, not pinned** | .mcp.json › browser                  | New MCP server browser (stdio, npx -y @acme/browser-mcp, not pinned) |
> | Permission widened             | .claude/settings.json                | permissions.allow adds Bash(curl:\*)                                 |
> | New hook                       | .claude/settings.json › SessionStart | New hook SessionStart → scripts/hooks/session-start.sh               |
> | Env override                   | .claude/settings.json                | Env override ANTHROPIC_BASE_URL → https://llm-proxy.example.net      |

Endpoint values are shown as their URL origin. Credential values never appear in reports. The
gate does not approve anything: pair the required check with
[CODEOWNERS](https://github.com/mustafakbaser/agentcheckup-action#requiring-the-check-and-codeowners)
on agent-config paths, so a person who owns that configuration reviews each change. The Action's
README covers SARIF upload, pull request comments, forks and the full list of inputs.

The safe fixes that fall inside a pull request's diff can become review comments with suggested
changes, for the Action to post; nothing is written to the repository:

```sh
gh pr diff 42 > pr.diff
npx agentcheckup fix --untrusted --format suggestions --diff pr.diff --output suggestions.json
```

Without the Action, run the same comparison yourself:

```sh
# On the base commit
npx agentcheckup --untrusted --no-gitignore --context --format json --output base.json --fail-on none
# On the pull request
npx agentcheckup --untrusted --no-gitignore --context --baseline base.json --gate security
```

Build the baseline from the base branch, never from a file in the pull request, and in CI run
agentcheckup from outside the checkout, as the Action does, so a package committed to the
repository cannot stand in for it. [Baselines and the gate](docs/context.md#baselines-and-the-gate)
gives the exact rules.

### Enforce an organization policy

The gate asks for review; a policy says what is acceptable at all. Write the rules once and check
every repository against them:

```json
{
  "policyVersion": 1,
  "name": "acme agent policy",
  "mcp": { "allow": ["npm:@modelcontextprotocol/server-github"], "requirePin": true },
  "forbid": ["bypass-permissions", "broad-shell"],
  "permissions": { "denyCommands": ["curl", "wget"] },
  "budgets": { "claude-code": { "startupTokens": 8000 } }
}
```

```text
$ npx agentcheckup --policy acme-agent-policy.json
…
Policy acme agent policy (enforce · sha256 b88dda9383ac · 6 checks)
  .mcp.json:3  fails  MCP server "docs" connects to https://mcp.example.com, which the policy does not allow.  mcp-not-allowed
✖ 1 violation fails the run
```

A violation fails the run unless the policy is in audit mode. Violations never change the score,
and the repository cannot switch them off: `--policy` ignores its configuration and inline
directives. Read the policy from the base branch or a central repository, never from the pull
request. A policy can also allow or deny, per agent, the models that agent definitions and
model settings name. [Organization policy](docs/policy.md) covers every check, baselines and the
trust model.

## Usage

```text
agentcheckup [path] [options]                Check agent configuration
agentcheckup fix [path] [options]            Preview fixes as a diff, or apply them with --write or -i
agentcheckup tasks [path] [options]          Write the findings that need judgment as tasks for an agent
agentcheckup context [path] [options]        Show what each agent loads
agentcheckup tokens [path] [options]         Show what that costs in context, per agent and call
agentcheckup agents [path] [options]         List custom agents and subagents, and their models
agentcheckup skill install [path] [options]  Install the agentcheckup skill for coding agents
agentcheckup rules [--json]                  List the rules
agentcheckup explain <rule-id>               Explain one rule
```

```sh
npx agentcheckup                                    # check the current directory
npx agentcheckup --compact                          # only the findings
npx agentcheckup --targets claude-code,codex        # only the agents you use
npx agentcheckup --format sarif --output agentcheckup.sarif
npx agentcheckup packages/api --format sarif --sarif-category api --output api.sarif
npx agentcheckup fix                                # preview every fix; changes nothing
npx agentcheckup fix --write                        # apply the safe fixes
npx agentcheckup fix --write --review               # also apply the fixes that need review
npx agentcheckup fix -i                             # ask about each fix, and for your words
npx agentcheckup tasks --format json                # the tasks as JSON
npx agentcheckup context --cwd packages/api         # a session started in packages/api
npx agentcheckup context --agent codex --format markdown
npx agentcheckup tokens --by-directory              # rank the directories of a monorepo
npx agentcheckup agents --agent claude-code         # Claude Code's subagents and their models
npx agentcheckup explain instr/codex-size-budget
```

Formats: `stylish` (default), `json`, `sarif`, `github` (annotations), `markdown` and `badge` for
a check; `diff` (default), `json` and `suggestions` for `fix`; `markdown` (default) and `json` for
`tasks`; `text` (default), `json` and `markdown` for `context` and `agents`. `--compact` and `--verbose` set
how much `stylish` shows, and `--compact` also shortens `markdown` and `github`.
`--sarif-category` keeps several SARIF uploads of one repository apart
([Annotations and code scanning](docs/configuration.md#annotations-and-code-scanning)). `--help` and
`<command> --help` list every option. In a Git hook, `npx agentcheckup --fail-on error` works
with any hook manager; a scan takes well under a second on most repositories.

From code:

```ts
import { scan } from 'agentcheckup';

const result = await scan('.', { targets: ['claude-code', 'codex'], context: true });
console.log(result.score.score, result.findings.length);
for (const plan of result.context?.plans ?? []) {
  console.log(plan.agent, plan.totals.startup.tokens);
}
```

The API is not stable before 1.0. The JSON report follows
[schemas/report.schema.json](schemas/report.schema.json).

## Exit codes

| Code | Meaning                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | No findings at or above `--fail-on` (default `error`), the score meets `--min-score`, and no gate tripped. `context` exits 0 unless `--gate` trips.                                 |
| 1    | Findings at or above `--fail-on` (only new ones with `--baseline`), a score below `--min-score`, changes caught by `--gate`, or a `--policy` violation that fails the run           |
| 2    | Invalid arguments, configuration, `--cwd` or `--agent`; `--gate` without `--baseline`; a configuration, baseline or policy file that cannot be read or used; an unusable `--output` |
| 3    | Internal error: a rule, a loader or the scanner crashed                                                                                                                             |
| 130  | Interrupted by Ctrl+C (SIGINT) while a command writes (`fix`, `--output`, `skill install`); 143 for SIGTERM, 129 for SIGHUP                                                         |

A reader that stops early, as in `agentcheckup | head`, does not change the exit code: what it
no longer reads is dropped, and the run finishes, `--output` and fixes included.

`fix` exits 0 when a dry run has nothing to change or every selected fix was applied and
verified, 1 when a dry run would change a file or a selected fix was not applied, 2 on invalid
arguments such as `--review` without `--write`, 3 on an internal error, and 130 (143, 129) when
Ctrl+C (SIGTERM, SIGHUP) interrupts its writing, which never leaves a fix half applied. Fixes
that need your words and manual steps do not change the exit code. `tasks` exits 1 while a task
is open, and `tasks --check` 0 once the given tasks are done. See [fix](docs/fix.md#exit-codes),
[tasks](docs/tasks.md#exit-codes) and [skill install](docs/skill.md#with-agentcheckup).

## Configuration

agentcheckup works without configuration. To choose agents or change rule severities, add
`agentcheckup.config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/mustafakbaser/agentcheckup/main/schemas/config.schema.json",
  "targets": ["claude-code", "codex", "cursor"],
  "rules": {
    "instr/claude-md-too-long": ["warn", { "maxLines": 300 }]
  },
  "ignore": ["examples/**"]
}
```

Suppress a single finding with a reason:

```markdown
<!-- agentcheckup-disable-next-line instr/import-unresolved -- generated during the docs build -->
```

Rule options also feed the load plans: if you raised Codex's `project_doc_max_bytes` in
`~/.codex/config.toml`, set the `maxBytes` option of `instr/codex-size-budget` and `context` uses
the same limit. A value in the repository's `.codex/config.toml` is read directly. See
[configuration](docs/configuration.md) for all options.

## How rules are decided

A rule may report an `error` only when an agent's documentation or source code shows that it
skips, ignores, truncates or breaks the file. Portability problems and degraded behavior are
warnings. Advice is `info` and never affects the score. Every rule page lists its sources and
the date they were last checked, and a weekly job reports when a cited source changes. Behavior
that could not be verified is never an error. See [ADR 0004](docs/adr/0004-evidence-backed-rules.md).

Load plans follow the same evidence: every entry cites its sources, and anything neither
documentation nor source code confirms is marked `unverified` and shown with "?". See
[ADR 0007](docs/adr/0007-model-what-each-agent-loads.md) and
[ADR 0009](docs/adr/0009-coverage-of-copilot-gemini-devin-cline-and-codex-toml.md).

Before release, every rule, load plan and fix was run against 80 public repositories with agent
configuration. Each finding class was reviewed by hand for false positives. A
consistency check compares the plans with the findings, and a replay applies every fix in memory
and checks that it resolves its findings, adds no error or warning and leaves nothing for a
second run. The [aggregate results](corpus/SUMMARY.md), the repository list and the harness are
in [corpus/](corpus/). Per-repository results are not published.

## Score

agentcheckup reports a score from 0 to 100. Each file starts at 100 and loses 40 points per error
and 8 per warning; the repository score weights the worst file, so many clean files cannot hide
one broken file. A risk error caps the score at 49. Token counts never affect it.
[How the score works](docs/scoring.md) explains the formula and why.

```sh
npx agentcheckup --format badge
```

prints Markdown for a badge.

## Security

agentcheckup is built to run on repositories you do not trust:

- It never executes code from the scanned repository and makes no network requests. `fix` runs
  no git, hooks or formatters either; it prints commands such as `git mv` for you to run.
- It never reads outside the directory you point it at. Symlinks and imports that leave it are
  reported, not followed. It never reads your home directory, so user-scope configuration is
  listed as not visible instead.
- Scans, `context` and `tasks` only read. Only `fix --write`, `fix -i` and `skill install` write,
  and only inside the scanned directory: never through a symlink or a hard link, never inside
  `.git`, never onto an existing file when creating or renaming one, and never to a file that
  changed since the scan. Each new version goes to a temporary file first and then into place.
  `fix --untrusted` is a dry run only, and `skill install` refuses `--untrusted`.
- A task prompt treats repository text as data: it is fenced and redacted, and every command in
  it is a pinned agentcheckup command, never one from the repository.
- Parsers and rules are bounded against crafted input, and every output format escapes
  terminal control sequences, CI workflow commands and Markdown.
- Reports and fix diffs never contain credential values: MCP `env` and `headers` keep their
  names only, endpoint overrides are cut to their URL origin, and fix diffs show a committed
  token as `ghp_…(40 chars)`.
- `--untrusted` ignores the repository's configuration file and inline suppressions, and the
  repository's `.gitignore` cannot hide agent configuration from the scan. A pull request that
  adds `.mcp.json` to `.gitignore` still has its `.mcp.json` checked.
- A `--baseline` file is read as untrusted input: size-limited, never through a symlink, and
  only with a supported schema version.

The design is in [ADR 0003](docs/adr/0003-treat-scanned-repositories-as-hostile.md), and for
writing fixes in [ADR 0008](docs/adr/0008-write-fixes-to-the-scanned-repository.md) and
[ADR 0010](docs/adr/0010-fixes-beyond-deterministic-edits.md). Report vulnerabilities privately
as described in [SECURITY.md](SECURITY.md).

## Limits

- **Static analysis only.** agentcheckup reads files and applies each agent's documented loading
  behavior. It never starts an agent, so it cannot see a remote flag, an experiment or a bug
  that changes what the agent does.
- **Repository scope only.** User, managed, team and account settings are not visible: for
  example `~/.claude`, `~/.codex/config.toml`, `~/.copilot`, `~/.gemini`, `~/.config/devin`,
  `~/.cline`, Cursor User Rules, and the Copilot cloud agent's MCP servers, which live in the
  repository's settings on GitHub.com. Each plan lists them.
- **Assumptions are stated.** Each plan says what it assumed: the instructions mode, a minimum
  version, a trusted workspace, Codex's byte limit, VS Code settings, Devin Desktop outside
  Restricted Mode, Cline rule toggles read from frontmatter. Some can be changed with rule
  options or flags such as `--context-window`.
- **Not every surface has a plan.** Copilot Chat and code review on GitHub.com, VS Code's other
  agent harnesses, Devin Desktop's older Cascade agent and Antigravity CLI are covered by rules
  only. Copilot, Devin and Cursor do not document the order of their instructions, and the plans
  say so.
- **Token counts are estimates:** characters divided by 4, shown with "≈". They are rough for
  code and non-Latin text.
- **What is not analyzed is reported, never guessed:** a `.codex/config.toml` in UTF-16 or past
  the parser's limits, Cline hook scripts and plugins, Cline rules in `.txt` or `.markdown`
  files.
- **Words and tasks are checked, not judged.** agentcheckup checks that your answer in `fix -i`
  or an agent's change resolves the finding and breaks no rule, not that the text is right.
  Review what an agent changed as you would any diff.

## Status

agentcheckup is in early development. Rule set `2026.10` covers static checks, and
`agentcheckup fix` repairs the findings it can, within the limits of
[ADR 0008](docs/adr/0008-write-fixes-to-the-scanned-repository.md) and
[ADR 0010](docs/adr/0010-fixes-beyond-deterministic-edits.md). Behavioral probes that run
agents, hook generation and an MCP server mode are out of scope for now; see
[ADR 0006](docs/adr/0006-scope-for-the-first-release.md),
[ADR 0007](docs/adr/0007-model-what-each-agent-loads.md) and ADR 0010.

## Contributing

False-positive reports with a minimal reproduction are the most valuable contribution, followed
by evidence that an agent loads a file differently than agentcheckup says. See
[CONTRIBUTING.md](CONTRIBUTING.md) to get started, and [docs/adr](docs/adr/README.md) for why
the code is shaped the way it is.

## License

[MIT](LICENSE). Bundled third-party code is listed in `THIRD_PARTY_NOTICES.md` in the
published package.
