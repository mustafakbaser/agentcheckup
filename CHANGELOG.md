# Changelog

## [0.1.1](https://github.com/mustafakbaser/agentcheckup/compare/v0.1.0...v0.1.1) (2026-10-18)


### Features

* **report:** list the agents whose session-start context did not change on one line ([a1aff40](https://github.com/mustafakbaser/agentcheckup/commit/a1aff40f2a07c186084758730bb6acb505ecba4d))
* **report:** name agents with the same token change on one line ([bc274ea](https://github.com/mustafakbaser/agentcheckup/commit/bc274ea3b92a0ce2f52d19b10b26349b866f3694))


### Bug fixes

* **fix:** quote a YAML value that a YAML 1.1 reader takes for a bare exponent ([8736a2a](https://github.com/mustafakbaser/agentcheckup/commit/8736a2ae20187da610918cb421bcf0b662970e9c))
* **fix:** scan fixes alone when an agent drops a file as a copy of another ([76a3a17](https://github.com/mustafakbaser/agentcheckup/commit/76a3a17464248abc24f9065f3bd4c6e3b439eca8))
* **release:** create the pack directory, and publish an existing tag on request ([ecac2aa](https://github.com/mustafakbaser/agentcheckup/commit/ecac2aab907e2f5b689fea7ef11087983de05580))
* **release:** publish the packed file, and rehearse the publish commands in CI ([df62cd2](https://github.com/mustafakbaser/agentcheckup/commit/df62cd26ff57b511acd96c9b1dbb508835fd8d92))
* **report:** leave out the new-finding column when no finding shown is new ([39de256](https://github.com/mustafakbaser/agentcheckup/commit/39de2562acaba06f4120eaaf25baa8a0ec4c3f36))


### Documentation

* refresh CLI output examples for nine agents and grouped token changes ([01b0207](https://github.com/mustafakbaser/agentcheckup/commit/01b02072fb01f46ea530556e0bde8b24ee240560))
* **release:** note the two-day window of a new npm trusted publisher ([900d78f](https://github.com/mustafakbaser/agentcheckup/commit/900d78ff8e45a1c26186e217bf4e925c033d87a1))

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
