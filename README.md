# agentcheck

**Does your coding agent actually read that?**

[![CI](https://github.com/mustafakbaser/agentcheck/actions/workflows/ci.yml/badge.svg)](https://github.com/mustafakbaser/agentcheck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

agentcheck checks `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, Cursor rules, Copilot instructions,
MCP servers and hooks against how Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI,
Windsurf and Cline actually load them. Every rule cites the documentation or source code it is
based on.

```sh
npx agentcheck
```

No configuration, no API key, no network requests, no telemetry. Node.js 22.12 or newer.

```text
.cursor/rules/style.md
  1:1  error  Cursor loads only .mdc files from .cursor/rules, so it ignores "style.md". Rename it to "style.mdc" and add frontmatter with description, globs or alwaysApply.  cursor/md-file-ignored

.mcp.json
  3:5  error  MCP server "docs" has a "url" but no "type", so Claude Code reads it as a stdio server and skips it. Add "type": "http" (or "sse" or "ws").  mcp/url-without-type

AGENTS.md
  1:1  warning  Claude Code reads "CLAUDE.md" in this directory and skips this AGENTS.md. Add the line "@AGENTS.md" to that file so Claude Code reads both.  instr/agents-md-ignored-by-claude
                ↳ CLAUDE.md: Claude Code reads this file instead of AGENTS.md.

CLAUDE.md
  3:5  error  Imported file "docs/missing-guide.md" does not exist, so Claude Code cannot load it.  instr/import-unresolved

✖ 4 problems (3 errors, 1 warning, 0 infos)
  loading 2 errors, 1 warning · correctness 1 error
Agent config score 75/100 (C) · ruleset 2026.10
```

## What it catches

Agents rarely tell you when they skip part of your configuration. These are some of the
problems agentcheck reports, each backed by the agent's documentation or source:

- **[Codex stops reading `AGENTS.md` at 32 KiB](docs/rules/instr/codex-size-budget.md)**, counted
  across every `AGENTS.md` from the repository root down to the working directory. The rest is
  dropped without a warning.
- **[Claude Code ignores `AGENTS.md` when a `CLAUDE.md` exists](docs/rules/instr/agents-md-ignored-by-claude.md)**
  in the same directory or above it, unless `CLAUDE.md` imports it with `@AGENTS.md`.
- **[A `SKILL.md` without frontmatter on line 1](docs/rules/skill/frontmatter-missing.md)** is
  skipped by Codex and Gemini CLI, and **[one without a description](docs/rules/skill/description-missing.md)**
  is skipped by Codex.
- **[Cursor ignores `.md` files in `.cursor/rules/`](docs/rules/cursor/md-file-ignored.md)**. Only
  `.mdc` files are rules.
- **[An MCP server with a `url` but no `type`](docs/rules/mcp/url-without-type.md)** is read as
  a stdio server by Claude Code, so the server is skipped.
- **[Imports that point to missing files](docs/rules/instr/import-unresolved.md)**, imports
  deeper than an agent follows, and imports that leave the repository.
- **[Hook event names an agent does not recognize](docs/rules/hooks/unknown-event.md)**,
  [scripts that do not exist](docs/rules/hooks/script-missing.md), and
  [timeouts in the wrong unit](docs/rules/hooks/timeout-units.md).
- **[Invisible Unicode](docs/rules/risk/hidden-unicode.md)**: tag characters and bidirectional
  overrides that a reviewer cannot see but the model reads, and
  [credentials committed in MCP configuration](docs/rules/mcp/literal-secret.md).

The [rule catalog](docs/rules/README.md) lists all rules. [What coding agents read](docs/platforms.md)
documents each agent's loading behavior with sources, and
[One configuration for every agent](docs/portability.md) shows how to share one setup across
all of them.

## Use it

### Locally

```sh
npx agentcheck                      # scan the current directory
npx agentcheck path/to/repo         # scan another directory
npx agentcheck --targets claude-code,codex   # only check the agents you use
npx agentcheck explain instr/codex-size-budget
```

Exit codes: `0` no findings at or above `--fail-on` (default `error`), `1` findings or a score
below `--min-score`, `2` invalid arguments or configuration, `3` internal error.

### In GitHub Actions

Annotations on the pull request, no extra permissions:

```yaml
name: agentcheck
on: pull_request
permissions:
  contents: read
jobs:
  agentcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      # Run from outside the checkout so a package committed to the repository cannot shadow
      # agentcheck. --untrusted ignores the repository's own config and suppressions.
      - run: npx --yes agentcheck@0 "$GITHUB_WORKSPACE" --untrusted --format github
        working-directory: ${{ runner.temp }}
```

For GitHub code scanning, write SARIF instead and upload it:

```yaml
- run: npx --yes agentcheck@0 "$GITHUB_WORKSPACE" --untrusted --format sarif --output "$GITHUB_WORKSPACE/agentcheck.sarif" --fail-on none
  working-directory: ${{ runner.temp }}
- uses: github/codeql-action/upload-sarif@24c54180a607b1449ed407dd24f251e4e9147c8d # v4.38.3
  with:
    sarif_file: agentcheck.sarif
```

The upload step needs `security-events: write`.

### In a Git hook

```sh
npx agentcheck --fail-on error
```

works in any pre-commit hook manager. The scan takes well under a second on most repositories.

### From code

```ts
import { scan } from 'agentcheck';

const result = await scan('.', { targets: ['claude-code', 'codex'] });
console.log(result.score.score, result.findings.length);
```

The API is not stable before 1.0. The JSON report follows
[schemas/report.schema.json](schemas/report.schema.json).

## Configuration

agentcheck works without configuration. To choose agents or change rule severities, add
`agentcheck.config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/mustafakbaser/agentcheck/main/schemas/config.schema.json",
  "targets": ["claude-code", "codex", "cursor"],
  "rules": {
    "instr/claude-md-too-long": ["warn", { "maxLines": 300 }]
  },
  "ignore": ["examples/**"]
}
```

Suppress a single finding with a reason:

```markdown
<!-- agentcheck-disable-next-line instr/import-unresolved -- generated during the docs build -->
```

See [configuration](docs/configuration.md) for all options.

## How rules are decided

A rule may report an `error` only when an agent's documentation or source code shows that it
skips, ignores, truncates or breaks the file. Portability problems and degraded behavior are
warnings. Advice is `info` and never affects the score. Every rule page lists its sources and
the date they were last checked. Behavior that could not be verified is never an error. See
[ADR 0004](docs/adr/0004-evidence-backed-rules.md).

Before release, every rule was run against 80 public repositories with agent configuration
(7,596 files), and each finding class was reviewed by hand for false positives. The
[aggregate results](corpus/SUMMARY.md), the repository list and the harness are in
[corpus/](corpus/). Per-repository results are not published.

## Score

agentcheck reports a score from 0 to 100. Each file starts at 100 and loses 40 points per error
and 8 per warning; the repository score weights the worst file, so many clean files cannot hide
one broken file. A risk error caps the score at 49. [How the score works](docs/scoring.md)
explains the formula and why.

```sh
npx agentcheck --format badge
```

prints Markdown for a badge.

## Security

agentcheck is built to run on repositories you do not trust:

- It never executes code from the scanned repository and makes no network requests.
- It never reads outside the directory you point it at. Symlinks and imports that leave it are
  reported, not followed.
- Parsers and rules are bounded against crafted input, and every output format escapes
  terminal control sequences, CI workflow commands and Markdown.
- `--untrusted` ignores the repository's configuration file and inline suppressions.

The design is in [ADR 0003](docs/adr/0003-treat-scanned-repositories-as-hostile.md). Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Status

agentcheck is in early development. Rule set `2026.10` covers static checks only. Behavioral
probes that run agents, and hook generation, are deliberately out of scope until they can be
done safely; see [ADR 0006](docs/adr/0006-scope-for-the-first-release.md).

## Contributing

False-positive reports with a minimal reproduction are the most valuable contribution. See
[CONTRIBUTING.md](CONTRIBUTING.md) to get started, and [docs/adr](docs/adr/README.md) for why
the code is shaped the way it is.

## License

[MIT](LICENSE). Bundled third-party code is listed in `THIRD_PARTY_NOTICES.md` in the
published package.
