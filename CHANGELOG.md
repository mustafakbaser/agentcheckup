# Changelog

## 0.1.0 (2026-10-17)

First release. agentcheckup shows what each coding agent loads from a repository, checks the agent configuration against how the agents read it, fixes what has one right answer, and gates pull requests that change it. It runs offline and never executes anything from the repository.

### Features

* **context:** load plans for Claude Code, Codex, Cursor, GitHub Copilot (CLI, VS Code and the cloud agent), Gemini CLI, Devin Local and Cline: what each agent loads at session start, when a path is in play, on request or not at all, and why, with evidence for every entry and a files-by-agents matrix.
* **checks:** 65 rules for instruction files, skills, Cursor and Copilot rules, MCP configuration, hooks, settings and Codex `config.toml`, each backed by the agent's documentation or source code. Output as text, JSON, SARIF, GitHub annotations or Markdown.
* **fix:** a dry-run diff by default. `--write` applies safe fixes, `--review` adds fixes to review, and `-i` asks for the words a fix needs, such as a "Use when" sentence. Every fix is verified by an in-memory re-scan before anything is written, and the writer stays inside the repository.
* **tasks:** findings that need judgment become a prompt for a coding agent, with repository text fenced as untrusted data and a `tasks --check` command to confirm each one is done. The agentcheckup skill and `agentcheckup skill install` hand this flow to Claude Code, Codex, Cursor and Copilot.
* **gate:** `--baseline` and `--gate` flag MCP servers, permissions, hooks, env overrides and hidden Unicode that a pull request adds, and `fix --format suggestions` turns safe fixes into review suggestions.
* **policy:** `--policy` checks a repository against an organization policy: allowed MCP servers and pins, forbidden settings, denied tools and commands, required hooks and startup token budgets.

See the [README](https://github.com/mustafakbaser/agentcheckup#readme) and the [docs](https://github.com/mustafakbaser/agentcheckup/tree/main/docs).
