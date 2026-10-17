# agentcheckup

**See what each coding agent actually loads from your repository, and what a pull request changes about it.**

[![CI](https://github.com/mustafakbaser/agentcheckup/actions/workflows/ci.yml/badge.svg)](https://github.com/mustafakbaser/agentcheckup/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Claude Code, Codex and Cursor read different files from the same repository, and they rarely say
what they skipped. agentcheckup reads your agent configuration and shows, for each agent, what is
in context when a session starts, what loads later, and what is skipped and why. In a pull
request, it shows how that changed and flags new MCP servers, hooks, permissions and environment
overrides for review.

```sh
npx agentcheckup context
```

No configuration, no API key, no network requests, no telemetry. Node.js 22.12 or newer.

Here it runs on a small pnpm monorepo with a `CLAUDE.md`, three `AGENTS.md` files, two skills, a
`.mcp.json` and a Claude Code hook (output trimmed):

```text
Claude Code context · ./
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

Codex context · ./
At session start                         bytes  ≈tokens
  1  AGENTS.md                             786      197
  2  Skills listing (1 skill, metadata)    163       41
                                  Total    949    ≈ 238

Cursor context · ./
…
Skipped
  .cursor/rules/testing.md  only .mdc files are read here  cursor/md-file-ignored  fix: review

4 of 4 skips can be fixed: agentcheckup fix
```

Every plan also states its assumptions (such as the Claude Code version and a trusted
workspace) and the scopes it cannot see, such as `~/.claude` and managed settings. A skip that
`agentcheckup fix` can remove ends with the class of its fix.

The matrix shows the whole repository at once:

```text
$ npx agentcheckup context --matrix
…
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

Here Claude Code never sees `AGENTS.md`, Codex never sees `CLAUDE.md`, and Cursor ignores
`testing.md` because it is not an `.mdc` file. [What each agent loads](docs/context.md) explains
every column and cell.

In [80 public repositories](corpus/SUMMARY.md#what-agents-load) with agent configuration, the
three agents load different instruction files at session start in 41 of the 71 repositories
where any of them loads instructions. By default, Claude Code skips the root `AGENTS.md` in 11 of
the 55 repositories that have one, because a `CLAUDE.md` is read instead.

## Fix what it finds

A scan starts with what each agent misses. Under each finding, a `why` line adds what the load
plans know and the message does not, and a `fix` or `how` line says what to do. Here it runs on a
small repository with an `AGENTS.md`, a `CLAUDE.md` that imports a missing `docs/setup.md`, a
Cursor rule saved as `.md`, an MCP server with a `url` but no `type`, and a skill without a
description (output trimmed):

```text
$ npx agentcheckup
What each agent misses
  Claude Code  MCP server docs is skipped: "url" without "type"                                 fix: review
               AGENTS.md is skipped: a CLAUDE.md on the path is read instead (≈82 tokens)       fix: safe
               docs/setup.md is skipped: CLAUDE.md imports it, but the import does not resolve  manual
  Codex        skill deploy is skipped: no description (≈13 tokens)                             fix: review
  Cursor       .cursor/rules/style.md is skipped: only .mdc files are read here (≈9 tokens)     fix: review

.cursor/rules/style.md
  1:1  error  Cursor loads only .mdc files from .cursor/rules, so it ignores "style.md". Rename it to "style.mdc" and add frontmatter with description, globs or alwaysApply.  cursor/md-file-ignored
              why  Cursor never loads these ≈9 tokens.
              fix  review: Rename .cursor/rules/style.md to style.mdc and add "alwaysApply: true"
…
AGENTS.md
  1:1  warning  Claude Code reads "CLAUDE.md" in this directory and skips this AGENTS.md. Add the line "@AGENTS.md" to that file so Claude Code reads both.  instr/agents-md-ignored-by-claude
                ↳ CLAUDE.md: Claude Code reads this file instead of AGENTS.md.
                why  Claude Code never loads these ≈82 tokens; Codex and Cursor do.
                fix  safe: Add "@AGENTS.md" as line 1 of CLAUDE.md
…
✖ 5 problems (4 errors, 1 warning, 0 infos)
  loading 3 errors, 1 warning · correctness 1 error
Agent config score 64/100 (D) · ruleset 2026.10
Fixes: 1 safe (agentcheckup fix --write) · 3 need review (agentcheckup fix -i) · 1 manual
```

`--compact` prints the findings without these additions and tags each one that has a fix as
`fixable`. `--verbose` adds each rule's docs URL, rationale and sources.

`agentcheckup fix` shows what it would change as a diff, checked by scanning a fixed copy in
memory. It changes nothing:

```text
$ npx agentcheckup fix
…
review  cursor/md-file-ignored  Rename .cursor/rules/style.md to style.mdc and add "alwaysApply: true"
rename from .cursor/rules/style.md
rename to .cursor/rules/style.mdc
--- a/.cursor/rules/style.md
+++ b/.cursor/rules/style.mdc
@@ -1 +1,4 @@
+---
+alwaysApply: true
+---
 Always use TypeScript strict mode.
  effect: Cursor session start ≈99 → ≈114 tokens
…
safe    instr/agents-md-ignored-by-claude  Add "@AGENTS.md" as line 1 of CLAUDE.md
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -1,3 +1,5 @@
+@AGENTS.md
+
 # Acme API

 Read @docs/setup.md before you start the service.
  effect: Claude Code session start ≈16 → ≈101 tokens
  effect: Cursor session start ≈99 → ≈102 tokens
…
manual  instr/import-unresolved  CLAUDE.md:5  create "docs/setup.md" or correct the path; no file named "setup.md" exists
Verified on an in-memory copy: 4 findings resolved, 2 new, 1 left.
```

The 2 new findings are infos that the fixed files raise, such as a description that is too short
to match requests. A fix may add infos, never an error or a warning. Then apply the fixes:

```text
$ npx agentcheckup fix --write --review
…
Applied 4 fixes to 4 files. Re-scanned: 4 findings resolved, 2 new, 1 left.
  Claude Code ≈16 → ≈101 tokens at session start · Codex ≈82 → ≈102 tokens at session start · Cursor ≈99 → ≈125 tokens at session start
  Changed MCP server docs (sse, https://mcp.example.com) (gate class mcp)
…
Review the changes with git status and git diff.

$ npx agentcheckup
…
✖ 3 problems (1 error, 0 warnings, 2 infos)
  correctness 1 error · risk 1 info · clarity 1 info
Agent config score 82/100 (B) · ruleset 2026.10
```

What agentcheckup can do about a finding falls into one of three classes:

- **safe:** a fix with one correct form that keeps your text and adds or changes no MCP server,
  hook, permission or env override, such as the `@AGENTS.md` import. `fix --write` applies these.
- **review:** any other change agentcheckup can make, such as a description copied from the
  skill body, or a `"type"` that lets Claude Code start a server. `fix --write --review` applies
  these too, and `fix -i` asks about each fix.
- **manual:** no fix. The `how` line says what to do, such as creating `docs/setup.md`.

Nothing is written without `--write` or `-i`, and a dry run exits 1 when it would change a file.
Writes stay inside the scanned directory, never go through a symlink or a hard link, write each
file atomically, and are refused for a file that changed since the scan. `--untrusted` allows
only the preview; [ADR 0008](docs/adr/0008-write-fixes-to-the-scanned-repository.md) has the
design.

[Fixing findings](docs/fix.md) covers every option and lists every rule with a fix.

## Review agent config in pull requests

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

The gate looks at what changed since the base commit. Removals never trip it. By default it
fails the check when a pull request:

- adds or changes an MCP server (the summary says when its package is not pinned to an exact
  version or digest), or adds an MCP config file agentcheckup cannot analyze;
- adds a permission that lets an agent do more without asking, such as a `permissions.allow`
  entry (the summary marks broad ones: any shell command, any file write or edit), an extra
  directory or a skill's `allowed-tools`, auto-approves MCP servers, or sets or changes
  `defaultMode`;
- adds or changes a hook;
- adds an env override that sets an endpoint, a credential, TLS behavior or code execution, such
  as `ANTHROPIC_BASE_URL`, `NODE_TLS_REJECT_UNAUTHORIZED` or `NODE_OPTIONS`, or points an
  existing endpoint override somewhere else;
- adds hidden Unicode: tag characters and bidirectional overrides a reviewer cannot see.

New lint findings at or above `error` fail the check too; findings that were already on the base
branch do not. The job summary for a pull request that adds an MCP server, widens a permission,
adds a hook and points Claude Code at another API endpoint looks like this:

> **Needs review: 4 security-relevant changes**
>
> | Change                         | Where                                | Detail                                                                 |
> | :----------------------------- | :----------------------------------- | :--------------------------------------------------------------------- |
> | **New MCP server, not pinned** | .mcp.json › browser                  | New MCP server browser (stdio, `npx -y @acme/browser-mcp`, not pinned) |
> | Permission widened             | .claude/settings.json                | permissions.allow adds Bash(curl:\*)                                   |
> | New hook                       | .claude/settings.json › SessionStart | New hook SessionStart → scripts/hooks/session-start.sh                 |
> | Env override                   | .claude/settings.json                | Env override ANTHROPIC_BASE_URL → https://llm-proxy.example.net        |
>
> Findings: no new findings, 1 resolved.
>
> **Session-start context**
>
> | Agent                |              Before |                After |       Change | Limits                                         |
> | :------------------- | ------------------: | -------------------: | -----------: | :--------------------------------------------- |
> | Claude Code          | ≈31 tokens, 2 files | ≈155 tokens, 2 files | ≈+124 tokens | —                                              |
> | Codex                |  ≈28 tokens, 1 file |   ≈28 tokens, 1 file |    unchanged | AGENTS.md chain 110 of 32,768 bytes (under 1%) |
> | Codex (packages/api) | ≈38 tokens, 2 files |  ≈38 tokens, 2 files |    unchanged | AGENTS.md chain 149 of 32,768 bytes (under 1%) |
> | Codex (packages/web) | ≈38 tokens, 2 files |  ≈38 tokens, 2 files |    unchanged | AGENTS.md chain 151 of 32,768 bytes (under 1%) |
> | Cursor               | ≈54 tokens, 3 files | ≈185 tokens, 3 files | ≈+131 tokens | —                                              |

Endpoint values are shown as their URL origin. Credential values never appear in reports.

The gate does not approve anything. Pair the required check with
[CODEOWNERS](https://github.com/mustafakbaser/agentcheckup-action#requiring-the-check-and-codeowners)
on agent-config paths (`.mcp.json`, `.claude/`, `.cursor/`, `.codex/`, `AGENTS.md`, `CLAUDE.md`
and others), so a person who owns that configuration reviews each change. The Action's README
covers SARIF upload, pull request comments, forks and the full list of inputs.

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

## Enforce an organization policy

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

```sh
npx agentcheckup --policy acme-agent-policy.json
```

A violation fails the run unless the policy is in audit mode. Violations never change the score,
and the repository cannot switch them off: `--policy` ignores its configuration and inline
directives. Read the policy from the base branch or a central repository, never from the pull
request. [Organization policy](docs/policy.md) covers every check, baselines and the trust model.

## What it catches

agentcheckup also checks each file against how the agents load it. Each rule is backed by the
agent's documentation or source code:

- **[Codex stops reading `AGENTS.md` at 32 KiB](docs/rules/instr/codex-size-budget.md)**, counted
  across every `AGENTS.md` from the repository root down to the working directory.
- **[Claude Code ignores `AGENTS.md` when a `CLAUDE.md` exists](docs/rules/instr/agents-md-ignored-by-claude.md)**
  in the same directory or above it, unless `CLAUDE.md` imports it with `@AGENTS.md`.
- **[A `SKILL.md` without frontmatter on line 1](docs/rules/skill/frontmatter-missing.md)** is
  skipped by Codex and Gemini CLI.
- **[Cursor ignores `.md` files in `.cursor/rules/`](docs/rules/cursor/md-file-ignored.md)**.
- **[An MCP server with a `url` but no `type`](docs/rules/mcp/url-without-type.md)** is skipped
  by Claude Code.
- **[Imports that point to missing files](docs/rules/instr/import-unresolved.md)**, hook events an
  agent does not know, and hook timeouts in the wrong unit.
- **[Invisible Unicode](docs/rules/risk/hidden-unicode.md)** and
  [credentials committed in MCP configuration](docs/rules/mcp/literal-secret.md).

The rules cover Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin Desktop (formerly
Windsurf) and Cline. The [rule catalog](docs/rules/README.md) lists all of them.
[What coding agents read](docs/platforms.md) documents each agent's loading behavior with sources,
and [One configuration for every agent](docs/portability.md) shows how to share one setup.

```text
$ npx agentcheckup --compact
…
.cursor/rules/testing.md
  1:1  error  Cursor loads only .mdc files from .cursor/rules, so it ignores "testing.md". Rename it to "testing.mdc" and add frontmatter with description, globs or alwaysApply.  cursor/md-file-ignored  fixable (review)

AGENTS.md
  1:1  warning  Claude Code reads "CLAUDE.md" in this directory and skips this AGENTS.md. Add the line "@AGENTS.md" to that file so Claude Code reads both.  instr/agents-md-ignored-by-claude  fixable
                ↳ CLAUDE.md: Claude Code reads this file instead of AGENTS.md.
…
✖ 5 problems (1 error, 3 warnings, 1 info)
  loading 1 error, 3 warnings · risk 1 info
Agent config score 84/100 (B) · ruleset 2026.10
```

## Usage

```text
agentcheckup [path] [options]           Check agent configuration
agentcheckup fix [path] [options]       Preview fixes as a diff, or apply them with --write or -i
agentcheckup context [path] [options]   Show what each agent loads
agentcheckup rules [--json]             List the rules
agentcheckup explain <rule-id>          Explain one rule
```

```sh
npx agentcheckup                                    # check the current directory
npx agentcheckup --compact                          # only the findings
npx agentcheckup --targets claude-code,codex        # only the agents you use
npx agentcheckup --format sarif --output agentcheckup.sarif
npx agentcheckup fix                                # preview every fix; changes nothing
npx agentcheckup fix --write                        # apply the safe fixes
npx agentcheckup fix -i                             # ask about each fix
npx agentcheckup context --cwd packages/api         # a session started in packages/api
npx agentcheckup context --agent codex --format markdown
npx agentcheckup explain instr/codex-size-budget
```

Formats: `stylish` (default), `json`, `sarif`, `github` (annotations), `markdown` and `badge` for
a check; `diff` (default) and `json` for `fix`; `text` (default), `json` and `markdown` for
`context`. `--compact` and `--verbose` set how much `stylish` shows, and `--compact` also
shortens `markdown` and `github`. `--help`, `fix --help` and `context --help` list every option.
In a Git hook, `npx agentcheckup --fail-on error` works with any hook manager; a scan takes well
under a second on most repositories.

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

| Code | Meaning                                                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | No findings at or above `--fail-on` (default `error`), the score meets `--min-score`, and no gate tripped. `context` exits 0 unless `--gate` trips.   |
| 1    | Findings at or above `--fail-on` (only new ones with `--baseline`), a score below `--min-score`, or security-relevant changes caught by `--gate`      |
| 2    | Invalid arguments, configuration, `--cwd` or `--agent`; `--gate` without `--baseline`; a baseline that cannot be read or used; an unusable `--output` |
| 3    | Internal error: a rule, a loader or the scanner crashed                                                                                               |

`fix` exits 0 when a dry run has nothing to change or every selected fix was applied and
verified, 1 when a dry run would change a file or a selected fix was not applied, 2 on invalid
arguments such as `--review` without `--write`, and 3 on an internal error. See
[Exit codes](docs/fix.md#exit-codes).

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

Rule options also feed the load plans: if you raised Codex's `project_doc_max_bytes`, set the
`maxBytes` option of `instr/codex-size-budget` and `context` uses the same limit. See
[configuration](docs/configuration.md) for all options.

## How rules are decided

A rule may report an `error` only when an agent's documentation or source code shows that it
skips, ignores, truncates or breaks the file. Portability problems and degraded behavior are
warnings. Advice is `info` and never affects the score. Every rule page lists its sources and
the date they were last checked, and a weekly job reports when a cited source changes. Behavior
that could not be verified is never an error. See [ADR 0004](docs/adr/0004-evidence-backed-rules.md).

Load plans follow the same evidence: every entry cites its sources, and anything neither
documentation nor source code confirms is marked `unverified` and shown with "?". See
[ADR 0007](docs/adr/0007-model-what-each-agent-loads.md).

Before release, every rule and every load plan was run against 80 public repositories with
agent configuration (7,596 files). Each finding class was reviewed by hand for false positives.
A consistency check compares the plans with the findings: a file a plan skips because of a
problem must have the finding that reports it, and every finding about loading must have its
skip. The
[aggregate results](corpus/SUMMARY.md), the repository list and the harness are in
[corpus/](corpus/). Per-repository results are not published.

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
- Scans and `context` only read. Only `fix --write` and `fix -i` write, and only inside the
  scanned directory: never through a symlink or a hard link, never inside `.git`, never onto an
  existing file when creating or renaming one, and never to a file that changed since the scan.
  Each new version goes to a temporary file first and then into place. `fix --untrusted` is a
  dry run only.
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
writing fixes in [ADR 0008](docs/adr/0008-write-fixes-to-the-scanned-repository.md). Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Limits

- **Static analysis only.** agentcheckup reads files and applies each agent's documented loading
  behavior. It never starts an agent, so it cannot see a remote flag, an experiment or a bug
  that changes what the agent does.
- **Repository scope only.** User, managed, team and account settings, such as `~/.claude`,
  `~/.codex/config.toml` or Cursor User Rules, are not visible. Each plan lists them.
- **Assumptions are stated.** Each plan says what it assumed: the instructions mode, a minimum
  version, a trusted workspace, Codex's byte limit. Change them with rule options or flags such
  as `--context-window`.
- **Three agents have load plans today:** Claude Code, Codex and Cursor. GitHub Copilot, Gemini
  CLI, Devin Desktop and Cline are covered by rules, and load plans for them will follow.
- **Token counts are estimates:** characters divided by 4, shown with "≈". They are rough for
  code and non-Latin text.
- **No TOML parser yet.** MCP servers and hooks in `.codex/config.toml` are reported as not
  analyzed, never guessed.

## Status

agentcheckup is in early development. Rule set `2026.10` covers static checks, and
`agentcheckup fix` repairs the findings it can, within the limits of
[ADR 0008](docs/adr/0008-write-fixes-to-the-scanned-repository.md). Behavioral probes that run
agents and hook generation are out of scope until they can be done safely; see
[ADR 0006](docs/adr/0006-scope-for-the-first-release.md) and
[ADR 0007](docs/adr/0007-model-what-each-agent-loads.md).

## Contributing

False-positive reports with a minimal reproduction are the most valuable contribution, followed
by evidence that an agent loads a file differently than agentcheckup says. See
[CONTRIBUTING.md](CONTRIBUTING.md) to get started, and [docs/adr](docs/adr/README.md) for why
the code is shaped the way it is.

## License

[MIT](LICENSE). Bundled third-party code is listed in `THIRD_PARTY_NOTICES.md` in the
published package.
