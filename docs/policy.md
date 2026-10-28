# Organization policy

`--policy <file>` checks a repository against rules your organization sets: which MCP servers
may run, which settings are forbidden, which tools and commands no agent may use without asking,
which hooks must be configured, how many tokens an agent may load at session start, and which
models agents may be set to run on.

```sh
npx agentcheckup --policy acme-agent-policy.json
```

A violation fails the run with exit code 1, unless the policy is in audit mode. Violations are
not findings:

- They have no rule id, are listed apart from the findings in every format, and never change
  the score ([ADR 0005](adr/0005-scoring.md)).
- The repository cannot switch them off. `--policy` implies `--untrusted`, so the repository's
  `agentcheckup.config.json` (its `rules`, `overrides` and `ignore` entries) and its inline
  directives are not read. No directive names a violation.
- `--targets` does not narrow them. Every MCP server, hook, permission and env override in the
  [security inventory](context.md#baselines-and-the-gate) is checked, and every agent a budget
  names is planned, whatever the targets are.

The decision and its trade-offs are in [ADR 0011](adr/0011-organization-policy.md).

## Example

```json
{
  "$schema": "https://raw.githubusercontent.com/mustafakbaser/agentcheckup/main/schemas/policy.schema.json",
  "policyVersion": 1,
  "name": "acme agent policy",
  "mode": "enforce",
  "existing": "report",
  "mcp": {
    "allow": [
      "npm:@modelcontextprotocol/server-github",
      "pypi:mcp-server-fetch",
      "oci:ghcr.io/acme/mcp-db",
      "https://mcp.acme.internal",
      "https://*.acme.dev"
    ],
    "allowLocal": false,
    "requirePin": true
  },
  "forbid": ["bypass-permissions", "auto-approve-project-mcp", "broad-shell", "gemini-trust"],
  "permissions": { "denyTools": ["WebFetch"], "denyCommands": ["curl", "wget", "ssh"] },
  "hooks": {
    "require": [
      {
        "agent": "claude-code",
        "event": "PreToolUse",
        "matcher": "Bash",
        "script": "scripts/hooks/guard.sh"
      }
    ]
  },
  "budgets": {
    "claude-code": { "startupTokens": 8000, "subagentStartupTokens": 20000 },
    "codex": { "startupTokens": 8000 }
  },
  "models": { "claude-code": { "allow": ["sonnet", "haiku", "inherit"] } }
}
```

This policy allows five MCP servers, each pinned to an exact version or digest; forbids four
settings; fails any grant that lets an agent fetch web pages or run `curl`, `wget` or `ssh`
without asking; requires a Claude Code hook that guards shell commands; limits what Claude Code
and Codex load at session start to about 8,000 tokens, and what each Claude Code subagent call
starts with to about 20,000; and lets Claude Code's subagents and settings name only Sonnet, Haiku
or the main conversation's model. With `"existing": "report"`
and a baseline, only violations a change adds fail the run.

The file follows [schemas/policy.schema.json](../schemas/policy.schema.json); with `$schema` set,
editors complete and check it.

## Fields

| Field                      | Type                                                 | Default   | Meaning                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ---------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `$schema`                  | string                                               | none      | The schema URL, for editors. Not checked.                                                                                                                                                                                                                                                                                                                                            |
| `policyVersion`            | `1`                                                  | required  | The format version. A newer version than this agentcheckup reads is an error: update agentcheckup.                                                                                                                                                                                                                                                                                   |
| `name`                     | string, 1 to 120 characters                          | required  | Shown in every report, so readers know which policy ran.                                                                                                                                                                                                                                                                                                                             |
| `mode`                     | `"enforce"` or `"audit"`                             | `enforce` | `audit` reports violations and never fails the run. Use it to roll a policy out.                                                                                                                                                                                                                                                                                                     |
| `existing`                 | `"report"` or `"fail"`                               | `report`  | With `--baseline`: `report` fails only on violations the baseline did not have, `fail` on every violation. Without a baseline every violation fails.                                                                                                                                                                                                                                 |
| `mcp.allow`                | array of [allowlist entries](#allowlist-entries)     | none      | Absent: no allowlist check. Present, even empty: only the servers it lists may run.                                                                                                                                                                                                                                                                                                  |
| `mcp.allowLocal`           | boolean                                              | `false`   | With `mcp.allow`: allow servers that run a script from the repository, such as `node ./tools/mcp.js`.                                                                                                                                                                                                                                                                                |
| `mcp.requirePin`           | boolean                                              | `false`   | Every MCP server must run an exact package version, an image digest or a repository script. Servers reached by URL always pass.                                                                                                                                                                                                                                                      |
| `forbid`                   | array of [setting names](#forbidden-setting)         | `[]`      | Settings that must not be configured. A closed list: a misspelled name is an error.                                                                                                                                                                                                                                                                                                  |
| `permissions.denyTools`    | array of tool names                                  | `[]`      | Tools no grant may let an agent use without asking, such as `WebFetch` or `mcp__github`.                                                                                                                                                                                                                                                                                             |
| `permissions.denyCommands` | array of program names                               | `[]`      | Programs no shell grant may let an agent run without asking, such as `curl`. Compared without case.                                                                                                                                                                                                                                                                                  |
| `hooks.require`            | array of [hook requirements](#hook-missing)          | `[]`      | Hooks that must be configured.                                                                                                                                                                                                                                                                                                                                                       |
| `budgets.<agent>`          | `{ "startupTokens": n, "subagentStartupTokens": n }` | none      | `startupTokens`: the most tokens the agent may load at session start. `subagentStartupTokens`: the most any of its subagent calls may start with (agentcheckup 0.3.0 or later). Each from 1 to 100,000,000; at least one. Agents with a load model: `claude-code`, `codex`, `cursor`, `copilot-cli`, `copilot-vscode`, `copilot-cloud`, `gemini`, `windsurf` (Devin Local), `cline`. |
| `models.<agent>.allow`     | array of model values                                | none      | Absent: no allowlist. Present, even empty: the agent's definitions and the repository's model settings may name only these values. See [`model-not-allowed`](#model-not-allowed).                                                                                                                                                                                                    |
| `models.<agent>.deny`      | array of model values                                | `[]`      | Values they must not name, even when `allow` lists them. Each `models.<agent>` needs `allow`, `deny` or both.                                                                                                                                                                                                                                                                        |

Unknown fields are an error, so a typo cannot switch a check off. A policy file with any problem
stops the run with exit code 2 and one line per problem; see [Errors](#errors). The same holds
for fields a newer agentcheckup added, such as `models`: an older version stops on them rather
than skipping their check.

## Checks

Each violation names its check. Reports link here by check id.

### `mcp-not-allowed`

An MCP server runs a package, an image or an origin that `mcp.allow` does not list, a repository
script while `mcp.allowLocal` is off, or a command agentcheckup cannot read as a package. On only
when `mcp.allow` is present. The servers a Claude Code subagent declares inline in its
frontmatter `mcpServers` are checked too.

### `mcp-unpinned`

With `mcp.requirePin`, an MCP server runs a package without an exact version (`npx -y pkg`,
`pkg@^1`, `pkg@latest`), an image without a digest, or a command whose version cannot be told.

### `forbidden-setting`

A setting `forbid` names is configured. Grants come from the same table the
[gate](context.md#gate-classes) uses, so the policy and `--gate` agree on what an entry does.

| Name                       | Violated by                                                                                                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bypass-permissions`       | `permissions.defaultMode` or a subagent's `permissionMode` set to `bypassPermissions`. Reported even where Claude Code ignores it, in project settings since v2.1.257 and in a subagent since v2.1.267, because older versions honor it. |
| `auto-approve-project-mcp` | `enableAllProjectMcpServers` set to `true`: Claude Code starts every server in `.mcp.json` without asking.                                                                                                                               |
| `mcp-auto-approve`         | Any `enabledMcpjsonServers` entry: Claude Code starts that server without asking.                                                                                                                                                        |
| `broad-shell`              | A grant of every shell command: `Bash`, `Bash(*)`, `PowerShell`, `PowerShell(*)` in `permissions.allow` or the `allowed-tools` of a skill or command, or Copilot's `shell` or `bash`.                                                    |
| `broad-write`              | A grant to write or edit any file: a bare `Write` or `Edit`.                                                                                                                                                                             |
| `gemini-trust`             | `trust: true` on a Gemini CLI MCP server: Gemini CLI runs its tool calls without confirmation.                                                                                                                                           |
| `additional-directories`   | Any `permissions.additionalDirectories` entry: Claude Code gets files outside the project.                                                                                                                                               |
| `env-endpoint`             | An env override that sends traffic elsewhere, such as `ANTHROPIC_BASE_URL` or a proxy variable.                                                                                                                                          |
| `env-tls`                  | An env override that changes TLS certificate checks, such as `NODE_TLS_REJECT_UNAUTHORIZED` or `NODE_EXTRA_CA_CERTS`.                                                                                                                    |
| `env-code-exec`            | An env override that can run code, such as `NODE_OPTIONS` or `LD_PRELOAD`, and Claude Code settings that run a command, such as `apiKeyHelper`.                                                                                          |

A setting that has no effect where it is set is still reported, and its message says so.

### `denied-tool`

A grant lets an agent do without asking what `permissions` denies. Grants are the entries that
let an agent do more without asking: `permissions.allow` entries and the `allowed-tools` of a
skill or a Claude Code command.
`deny` and `ask` entries never violate the policy.

- A tool grant violates `denyTools` when it names the tool, without case; when it ends in `*` and
  the tool starts with what comes before it; or when it grants a whole MCP server (`mcp__github`)
  whose tool is denied, and the other way around.
- A shell grant (`Bash`, `PowerShell`, Copilot's `shell`) violates `denyCommands` when it allows
  every command (no specifier, or `*`), when its first word is the denied program
  (`Bash(curl:*)`, `Bash(/usr/bin/curl https://x)`), or when its program cannot be told: a
  leading `*`, command substitution, `;`, `|`, `&`, a variable or glob in the first word, or a
  wrapper such as `sudo`, `env`, `xargs` or `sh`. The program is the file name of the first word,
  without `.exe`, `.cmd`, `.bat` or `.com`.

### `hook-missing`

A hook in `hooks.require` is not configured. Each requirement names:

| Field     | Required | Matches                                                                                                     |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `agent`   | yes      | `claude-code`, `codex`, `cursor` or `gemini`; the hook must be in that agent's own hook configuration.      |
| `event`   | yes      | An event the agent knows, such as `PreToolUse`. A misspelled event is an error that suggests the right one. |
| `matcher` | no       | The hook's matcher, exactly.                                                                                |
| `script`  | no       | The repository script the hook runs, as a path from the repository root (`scripts/hooks/guard.sh`).         |
| `command` | no       | The hook's command line, exactly.                                                                           |

A hook in the frontmatter of a skill, command or subagent never meets a requirement: it runs only
once the skill is invoked, or only while the subagent runs, so it does not guard the whole
session.

**Configured, not enforced.** The check proves only that the hook is configured. Hooks fail open
on errors and timeouts, and user settings can turn them off, so a hook is not a control the
repository can enforce. Every report says so next to a hook requirement. To have Claude Code
or Cursor block a tool call when the hook fails, see
[hooks/fails-open](rules/hooks/fails-open.md).

### `startup-budget`

An agent loads more tokens at session start than its budget allows. The check takes the largest
load plan of the agent: at the root, and for Codex in each directory with an `AGENTS.md`, as
`agentcheckup context --matrix` shows them. An agent that has no load plan fails the check
rather than passing it. Token counts are estimates (characters divided by 4), so leave headroom.

### `subagent-budget`

A subagent call starts with more tokens, in a context window of its own, than the agent's
`subagentStartupTokens` allows. Each subagent over the budget is a violation of its own, at its
file, measured at its largest in any load plan of the agent. What a call counts is what
[`agentcheckup tokens`](tokens.md) shows: for Claude Code, the subagent's prompt, the session's
startup instruction files unless the definition sets `omitClaudeMd: true`, the skills its
`skills` field preloads and the part of its `MEMORY.md` its `memory` field adds; for the Copilot
CLI, the repository's instruction files when the agent sets `include-custom-instructions: true`;
for Codex, its skills instructions block; and the prompt. The task message, tool definitions and
anything outside the repository are not counted.

- **It fails closed.** An agent that has no load plan fails the check. So does a subagent the
  agent may load whose call agentcheckup cannot measure, such as a file with a YAML merge key,
  larger than the scan reads, or a symlink outside the repository, and a call within the budget
  that starts with a file the scan did not read, such as a preloaded skill past the size it
  reads.
- **Either of two may run.** Where two definitions share a name and the agent does not document
  which one wins, such as two files in one `.claude/agents` folder, both calls are checked.
- **The plans are those of the startup budget:** each agent at the root, and Codex in each
  directory with an `AGENTS.md`. A subagent defined below the root is checked where one of them
  lists it. The report has a note that counts the ones none of them lists; see what one costs with
  `agentcheckup tokens --cwd <dir>`.
- **Against a baseline,** a call over the budget is new when it grew. A violation for a call that
  cannot be measured carries the definition's digest, so any change of the file makes it new. A
  baseline written before agentcheckup 0.3.0 measures no call, so every violation is new, and the
  report says so.
- An older agentcheckup rejects the field as unknown and stops with exit code 2, so a policy that
  sets it cannot pass by being ignored.

### `model-not-allowed`

An agent definition or a repository setting names a model the policy does not allow for the
agent: one outside `models.<agent>.allow`, or one in `models.<agent>.deny`. `allow` matches
values exactly as written, so `sonnet` and `claude-sonnet-5-5` are different values, and so are
`opus` and `opus[1m]`. `deny` also matches a value without the options in brackets, so
`deny: ["opus"]` catches `opus[1m]`. For GitHub Copilot, whose model ids are case-insensitive, both
compare without case. `inherit` (the main conversation's model) is a value like any other: leave
it out of `allow` to require every subagent to name its model. An alias stays an alias, such as
`best` for Opus: list the values you allow rather than deny the ones you do not.

- The definitions are those [`agentcheckup agents`](agents.md) lists: each file once per agent
  that reads it. Cursor and GitHub Copilot read Claude Code's `.claude/agents` too, so
  `models.cursor` covers those files as Cursor reads them.
- The settings are those that pick a model: Claude Code's `model`, `env.ANTHROPIC_MODEL`,
  `env.ANTHROPIC_DEFAULT_MODEL`, `env.CLAUDE_CODE_SUBAGENT_MODEL` and the
  `env.ANTHROPIC_DEFAULT_*_MODEL` variables that set what an alias such as `sonnet` resolves to;
  Codex's `model` and `agents.default_subagent_model`; Gemini CLI's `model.name` and per-agent
  overrides; and the Copilot CLI's `model`. Effort settings are not models, and
  `CLAUDE_CODE_SUBAGENT_MODEL` set to `inherit` picks none.
- A definition whose model a setting overrides with a model the repository names, such as
  `CLAUDE_CODE_SUBAGENT_MODEL` under Claude Code's `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, runs on that
  setting's model, so the setting is checked instead. With the switch alone, the definition's own
  model is checked too: Claude Code before v2.1.257 still runs it.
- A definition the agent skips, or is documented to lose to another, runs on no model and is not
  checked. Where which of two definitions wins is not documented, such as two files in one
  `.claude/agents` folder with the same name, both are checked.
- A definition without a model runs on one chosen elsewhere: a repository setting, which is
  checked, or the user's choice, which agentcheckup cannot see.
- A definition the agent may load but whose model cannot be read fails an allowlist: the policy
  fails closed. The violation's entry is `unknown`. So does a scan without agent definitions,
  which only the programmatic API can produce.

### `unanalyzed-config`

A configuration file agentcheckup cannot analyze, such as a `.mcp.json` that is not valid JSON, a
`.codex/config.toml` that is not valid TOML, or a skill, command or subagent whose frontmatter
agentcheckup cannot read as Claude Code may (see
[Items declared in frontmatter](context.md#items-declared-in-frontmatter)), may hide a
violation. The policy fails
closed: each such file is a violation of its own whenever a check of MCP servers, settings,
grants or hooks is on.

## Allowlist entries

| Form                            | Example                                                  | Matches                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm:<name>[@<version>]`        | `npm:@modelcontextprotocol/server-github`, `npm:x@1.2.3` | An npm package, scoped or not, run with `npx`, `pnpm dlx`, `bunx` and the like. With a version: only that exact version.                                                             |
| `pypi:<name>[==<version>]`      | `pypi:mcp-server-fetch`, `pypi:mcp_server_fetch==1.0.0`  | A PyPI package run with `uvx`, `pipx run` and the like. Names compare as PEP 503 normalizes them: case, `-`, `_` and `.` do not matter.                                              |
| `oci:<image>[@sha256:<digest>]` | `oci:ghcr.io/acme/mcp-db`, `oci:mcp/fetch@sha256:…`      | A container image run with `docker run` or `podman run`. Docker's defaults apply: `mcp/fetch` is `docker.io/mcp/fetch`, `node` is `docker.io/library/node`.                          |
| `<scheme>://<host>[:<port>]`    | `https://mcp.acme.internal`, `https://*.acme.dev`        | A remote server at that origin: same scheme, host and port. A leading `*.` matches every host below it on a label boundary: `a.acme.dev`, never `evilacme.dev` or `acme.dev` itself. |

Rules:

- Versions are exact. A range (`npm:x@^1`, `pypi:x>=1`) or a moving tag (`npm:x@latest`,
  `oci:x:1.0`) in the policy is an error. An entry without a version allows any version of the
  package; add `mcp.requirePin` to require that the server pins one.
- URL entries are origins: no path, query or user name. Only a leading `*.` wildcard is allowed.
  Schemes are `http`, `https`, `ws` and `wss`; a scheme's default port may be left out.
- A server with a command is judged by the package it runs, even when it also has a `url`.
- A server whose package or version cannot be told matches no entry: an unknown launcher, a
  wrapper script, or a command agentcheckup cannot read.
- An empty `allow` list allows no server. Leave `mcp.allow` out to skip the check.

## Fails closed

Where agentcheckup cannot tell whether the repository follows the policy, it reports a violation:

- a configuration file it cannot analyze ([`unanalyzed-config`](#unanalyzed-config));
- an MCP server whose package or version cannot be told (no allowlist entry matches it);
- a shell grant whose program cannot be told (it counts as running every denied program);
- an agent with a budget but no load plan;
- an agent definition the agent may load whose model cannot be read, under a `models` allowlist,
  and a definition that may win where which one wins is not documented;
- a policy file with an unknown field, an unknown setting name or an unknown hook event (exit 2).

## Baselines

With `--baseline`, the same policy is checked against the baseline report too, and each violation
is marked `new` or `unchanged`:

```sh
# On the base commit
agentcheckup --untrusted --no-gitignore --context --format json --output base.json --fail-on none
# On the pull request, with the policy from the base commit
agentcheckup --no-gitignore --policy policy.json --baseline base.json --gate security
```

- A violation is unchanged when the baseline has one with the same id: the same check, the same
  subject (a server, a setting, a grant, a hook requirement, an agent or a file), and for an
  inventory item the same digest. Changing a server that already violates the policy, such as
  bumping its version, makes a new violation.
- A startup budget violation is new unless the baseline exceeded the same budget with at least
  as many tokens. A subagent budget violation is new unless the baseline's call of the same
  subagent exceeded it with at least as many tokens: a call that grows is new.
- `"existing": "report"` fails only on new violations; `"fail"` fails on all of them.
- Budgets need load plans in the baseline: write it with `--context`. A baseline without plans,
  without an inventory or without agent definitions (from an older agentcheckup) makes every
  such violation new, and the report says so.
- A model violation keeps its id while the definition or setting is unchanged; changing the
  model, or anything else the definition says, makes a new violation.
- A change inside a file agentcheckup cannot analyze is not visible, so such a file counts as
  unchanged when the baseline has it too.
- Ids are relative to the scanned directory, so a baseline written from another working
  directory still matches.

### After an upgrade

A new version can read configuration an earlier one did not, such as the hooks, MCP servers and
permissions in skill, command and subagent frontmatter. A run with a baseline and
`"existing": "report"` compares both scans with the same version, so it fails only on what the
change under review adds. A run without a baseline, or with `"existing": "fail"`, reports every
violation the new version finds, including ones in files that did not change. Start such a rollout
in `"mode": "audit"` after upgrading.

## Exit codes

| Code | When                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | No violation fails the run, and nothing else fails it. Audit mode always passes the policy part                                           |
| 1    | A violation fails the run: in enforce mode, any violation without a baseline, a new one with `"existing": "report"`, or any with `"fail"` |
| 2    | The policy file cannot be read or is not a valid policy, or `--policy` is combined with `--config`                                        |

A violation fails the run whatever `--fail-on` says; `--fail-on`, `--min-score` and `--gate`
still apply to findings and changes as usual. JSON, SARIF and badge output add a line on stderr
when a violation fails the run, so exit code 1 never comes without a reason.

### Errors

Each problem is one line on stderr, with control and invisible characters shown as `<U+XXXX>`:

```text
policy.json: Unknown field "mcp.alow" (did you mean "mcp.allow"?). Unknown fields are an error, so a typo cannot switch a check off.
policy.json: mcp.allow[0]: "npm:x@^1.0.0" names a version range. Ranges are not allowed: give an exact version or none.
policy.json: mcp.allow[1]: "https://mcp.acme.dev/mcp" is not an origin. A URL entry must be an origin, scheme://host[:port], without a path, query or user name.
policy.json: hooks.require[0].event: "PreTooluse" is not a Claude Code hook event. Did you mean "PreToolUse"?
policy.json: policyVersion 2 is newer than this agentcheckup reads (1). Update agentcheckup to use this policy.
Refusing to read policy file /work/link.json: it is a symbolic link, not a regular file.
--policy ignores configuration files, so it cannot be combined with --config.
```

The policy file is read as untrusted input: a regular file (not a symlink), at most 256 KiB,
valid UTF-8 JSON.

## Reports

Every format shows the policy's name, its mode and the SHA-256 of the policy file. The digest
covers the file's bytes, so `shasum -a 256 policy.json` prints the same value and tells you which
policy a run used. Messages never carry `path:line`; each format adds the location.

| Format     | What it shows                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stylish`  | A policy block after the findings: one line per violation, failing ones first, then a headline and the notes.                                                                                                                   |
| `markdown` | A "Policy" section before the summary of changes since the baseline: the name, mode, short digest, number of checks, a table of violations with their status (`new`, `unchanged`, `fails`, `reported`) and the notes.           |
| `github`   | One annotation per violation that fails the run or is new, titled `policy: <check>`, on the file and line when there is one: an error when it fails the run, a warning otherwise. Notes are notices.                            |
| `sarif`    | Violations with a file are results with `ruleId` `policy/<check>` and `properties.policy: true`, with a rule descriptor per check. Code scanning needs a file for every result, so the others are tool execution notifications. |
| `json`     | The top-level `policy` field: `name`, `sha256`, `mode`, `insideScanRoot`, `checks`, `violations` and `notes`. See [schemas/report.schema.json](../schemas/report.schema.json).                                                  |

## Trust model

A policy only means something if the change under review cannot edit it, switch it off or hide
from it.

- **The policy file must come from a trusted tree:** the base branch or a central repository,
  never the pull request. A policy read from the checkout of a pull request is whatever the pull
  request says it is. When the policy file lies inside the scanned directory, the report notes it.
- **The repository cannot switch checks off.** `--policy` implies `--untrusted`: the
  repository's configuration and inline directives are ignored, and its `.gitignore` cannot hide
  agent configuration. `--policy` with `--config` exits with code 2.
- **The baseline comes from the base commit too**, never from a file in the pull request.
- **Run agentcheckup from outside the checkout** in CI, so a package committed to the repository
  cannot stand in for it.
- **A required status check alone can be spoofed:** a pull request can change the workflow that
  runs it. Enforce it with an organization or repository ruleset that requires a workflow from a
  central repository at a pinned ref, or with CODEOWNERS on `.github/workflows/` and required
  code-owner review.

The [GitHub Action](https://github.com/mustafakbaser/agentcheckup-action) reads the policy from
the base commit or from a central repository, never from the pull request.

## Limits

- **Hooks: configured, not enforced.** A required hook proves the configuration, not the
  behavior. Hooks fail open on errors and timeouts, and user settings can turn them off.
- **Personal files.** `--policy` reads gitignored agent configuration, so a local run checks
  personal files such as `.claude/settings.local.json`. CI never sees them: they are not
  committed. A policy run in CI checks what the repository shares, not what each developer has.
- **Repository scope only.** User, managed and global settings are never read. A developer can
  allow in `~/.claude/settings.json` what the repository's policy forbids.
- **Static analysis.** The policy checks configuration files, not what an agent or a server does
  at run time, and the budgets use estimated tokens.
- **No suppressions.** A violation goes away when the repository changes or the policy does.
