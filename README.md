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
  AGENTS.md               a CLAUDE.md on the path is read instead  instr/agents-md-ignored-by-claude
  packages/api/AGENTS.md  a CLAUDE.md on the path is read instead  instr/agents-md-ignored-by-claude
  packages/web/AGENTS.md  a CLAUDE.md on the path is read instead  instr/agents-md-ignored-by-claude

Codex context · ./
At session start                         bytes  ≈tokens
  1  AGENTS.md                             786      197
  2  Skills listing (1 skill, metadata)    163       41
                                  Total    949    ≈ 238

Cursor context · ./
…
Skipped
  .cursor/rules/testing.md  only .mdc files are read here  cursor/md-file-ignored
```

Every plan also states its assumptions (such as the Claude Code version and a trusted
workspace) and the scopes it cannot see, such as `~/.claude` and managed settings.

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
- adds a broad permission (any shell command, any file write or edit), auto-approves MCP
  servers, or sets or changes `defaultMode`;
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
> | Permission widened             | .claude/settings.json                | permissions.allow adds Bash                                            |
> | New hook                       | .claude/settings.json › SessionStart | New hook SessionStart → scripts/hooks/session-start.sh                 |
> | Env override                   | .claude/settings.json                | Env override ANTHROPIC_BASE_URL → https://llm-proxy.example.net        |
>
> Findings: no new findings, 1 resolved.
>
> Session-start context: Claude Code ≈76 → ≈276 tokens (+200) · Codex unchanged · Codex
> (packages/api) unchanged · Codex (packages/web) unchanged · Cursor ≈304 → ≈307 tokens (+3)

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
$ npx agentcheckup
…
.cursor/rules/testing.md
  1:1  error  Cursor loads only .mdc files from .cursor/rules, so it ignores "testing.md". Rename it to "testing.mdc" and add frontmatter with description, globs or alwaysApply.  cursor/md-file-ignored

AGENTS.md
  1:1  warning  Claude Code reads "CLAUDE.md" in this directory and skips this AGENTS.md. Add the line "@AGENTS.md" to that file so Claude Code reads both.  instr/agents-md-ignored-by-claude
                ↳ CLAUDE.md: Claude Code reads this file instead of AGENTS.md.
…
✖ 5 problems (1 error, 3 warnings, 1 info)
  loading 1 error, 3 warnings · risk 1 info
Agent config score 84/100 (B) · ruleset 2026.10
```

## Usage

```text
agentcheckup [path] [options]           Check agent configuration
agentcheckup context [path] [options]   Show what each agent loads
agentcheckup rules [--json]             List the rules
agentcheckup explain <rule-id>          Explain one rule
```

```sh
npx agentcheckup                                    # check the current directory
npx agentcheckup --targets claude-code,codex        # only the agents you use
npx agentcheckup --format sarif --output agentcheckup.sarif
npx agentcheckup context --cwd packages/api         # a session started in packages/api
npx agentcheckup context --agent codex --format markdown
npx agentcheckup explain instr/codex-size-budget
```

Formats: `stylish` (default), `json`, `sarif`, `github` (annotations), `markdown` and `badge` for
a check; `text` (default), `json` and `markdown` for `context`. `--help` and `context --help`
list every option. In a Git hook, `npx agentcheckup --fail-on error` works with any hook
manager; a scan takes well under a second on most repositories.

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

- It never executes code from the scanned repository and makes no network requests.
- It never reads outside the directory you point it at. Symlinks and imports that leave it are
  reported, not followed. It never reads your home directory, so user-scope configuration is
  listed as not visible instead.
- Parsers and rules are bounded against crafted input, and every output format escapes
  terminal control sequences, CI workflow commands and Markdown.
- Reports never contain credential values: MCP `env` and `headers` keep their names only, and
  endpoint overrides are cut to their URL origin.
- `--untrusted` ignores the repository's configuration file and inline suppressions, and the
  repository's `.gitignore` cannot hide agent configuration from the scan. A pull request that
  adds `.mcp.json` to `.gitignore` still has its `.mcp.json` checked.
- A `--baseline` file is read as untrusted input: size-limited, never through a symlink, and
  only with a supported schema version.

The design is in [ADR 0003](docs/adr/0003-treat-scanned-repositories-as-hostile.md). Report
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

agentcheckup is in early development. Rule set `2026.10` covers static checks only. Behavioral
probes that run agents, automatic fixes and hook generation are out of scope until they can be
done safely; see [ADR 0006](docs/adr/0006-scope-for-the-first-release.md) and
[ADR 0007](docs/adr/0007-model-what-each-agent-loads.md).

## Contributing

False-positive reports with a minimal reproduction are the most valuable contribution, followed
by evidence that an agent loads a file differently than agentcheckup says. See
[CONTRIBUTING.md](CONTRIBUTING.md) to get started, and [docs/adr](docs/adr/README.md) for why
the code is shaped the way it is.

## License

[MIT](LICENSE). Bundled third-party code is listed in `THIRD_PARTY_NOTICES.md` in the
published package.
