# 0007. Model what each agent loads and gate security-relevant changes

- Status: Accepted
- Date: 2026-10-15

## Context

agentcheckup already models how agents load files, but only inside rules, and only to find
problems. The import graph, the Codex size budget, skill placement, Cursor rule activation, MCP
servers and hooks each live in their own rule files under `src/rules/`. No part of the code
answers the question users ask most: what does my agent actually load when I start it in this
directory, and how much context does that cost?

Teams have a second need. A pull request that adds an MCP server, a hook, a permission or an
environment override changes what code runs on a developer's machine, or where their prompts go.
A well-formed server produces no finding, so a linter alone does not flag it for review.

The documented loading behavior for each agent is collected in
[What coding agents read](../platforms.md). [ADR 0003](0003-treat-scanned-repositories-as-hostile.md)
limits agentcheckup to the repository: it never reads the home directory.
[ADR 0004](0004-evidence-backed-rules.md) requires a cited source for every claim about an agent.

## Decision

- Pure loaders in `src/platforms/load/` build a load plan for one agent and one working
  directory. They use the same parsed files as the rules. Rules run first, and loaders reuse the
  cached parses afterwards, so the Markdown budget is spent in the same order and findings
  cannot change.
- Each documented loading behavior has one implementation, shared by the rule and the loader. A
  consistency test checks that every skip caused by a problem has its finding, and that every
  loading finding has its skip.
- Plans cover the repository only. Managed, user, global, team and account scopes are listed as
  "not visible" and never read. Settings the repository cannot show are stated as assumptions;
  rule options feed them.
- Every claim in a plan cites a source. Behavior we could not verify is marked `unverified` and
  shown with "?".
- Token counts are estimates: characters divided by 4, labeled "≈". They never cause an error
  and never affect the score.
- A separate security inventory in `src/inventory/`, also pure, lists every MCP server, hook,
  permission and environment override, whether or not an agent loads it today. Every JSON report
  includes it. It never contains credential values. Endpoint values such as
  `ANTHROPIC_BASE_URL` are shown as their URL origin only.
- `--baseline report.json` compares a scan with an earlier report. Findings, inventory items
  and plan entries match by identity relative to the repository root. `--gate` turns new
  security-relevant changes into exit code 1, the same code findings use. Removals never trip
  the gate. Approval of gated changes comes from CODEOWNERS on agent-config paths, not from
  labels.
- The first modeled agents are Claude Code, Codex and Cursor.
- The JSON report keeps schema version 1 and gains optional fields: `pathBase`, `inventory`,
  `context`, `baseline`, and `baseline` on each finding. Version 1 was never published, so a
  version 2 is not needed.
- There is no TOML parser in this phase. `.codex/config.toml` is reported as not analyzed, and
  no servers or hooks are guessed from it.
- The first release waits until `context`, `--baseline`, the inventory and the GitHub Action
  ship. This is still static analysis, within [ADR 0006](0006-scope-for-the-first-release.md).
- Autofix, a policy mode, a language server and the playground are out of scope for this work.

## Consequences

- agentcheckup makes positive claims ("Claude Code loads this file") for the first time. A wrong
  claim costs more trust than a missed finding. The consistency test and a replay over the
  corpus of real repositories guard against it.
- Moving loading helpers out of rule files into `src/platforms/` must leave every finding
  unchanged. A golden snapshot of the findings checks this.
- Configuration in user scope cannot be checked. Plans say so instead of guessing.
- Codex MCP servers and hooks declared in `.codex/config.toml` are reported as not analyzed.
- Token estimates are rough, especially for code and non-Latin text.
- A baseline written by a different rule set shows findings from new rules as new. Reports label
  them "new rule" so they are not mistaken for regressions.
