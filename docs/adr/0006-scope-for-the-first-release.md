# 0006. Scope for the first release

- Status: Accepted
- Date: 2026-10-14

## Context

The original roadmap included behavioral evaluation (`test`, `compare`) that runs real agents
headlessly, hook generation (`enforce`), a public leaderboard and an editor extension. Review
findings:

- Running an agent on a repository runs that repository's hooks, MCP servers and skill shell
  commands. In headless mode Claude Code does not show its trust dialog. Doing this safely needs
  containers, egress control and spend limits.
- Anthropic's `claude plugin eval` and Microsoft's `waza` already provide single-platform
  evaluation.
- Codex hooks fail open on errors and timeouts, Claude Code hooks fail open on most exit codes,
  and Cursor's fail-closed mode is opt-in. A tool that promises enforcement would overstate what
  the platforms provide.
- Public rankings of third-party repositories drew strong criticism when other tools tried them.

## Decision

The first release ships static analysis only: `agentcheckup [path]` with terminal, JSON, SARIF,
GitHub annotation and Markdown output, a configuration file, inline suppressions, a score and a
badge URL. It makes no network calls and has no telemetry.

Deferred, each to be designed in its own ADR:

- Behavioral probes, local and opt-in, behind sandboxing and explicit budgets.
- Hook and permission generation, with a per-platform table of what is enforced, best effort,
  or unsupported.
- A browser playground built on the pure core.

## Consequences

The first release is smaller and safe to run anywhere, including on untrusted pull requests. The
differentiator is rule quality and cross-platform coverage, which every later feature builds on.
