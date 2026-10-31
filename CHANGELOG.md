# Changelog

## [0.4.2](https://github.com/mustafakbaser/agentcheckup/compare/v0.4.1...v0.4.2) (2026-10-31)


### Documentation

* pin the Action example to v0.4.1 and name its sarif-category input ([bb08dfb](https://github.com/mustafakbaser/agentcheckup/commit/bb08dfb1195016acbe7f5a4ae820d640b119b84d))

## [0.4.1](https://github.com/mustafakbaser/agentcheckup/compare/v0.4.0...v0.4.1) (2026-10-31)


### Bug fixes

* **deps:** bump ignore to 7.0.14, bundled into the CLI, and the development group ([#80](https://github.com/mustafakbaser/agentcheckup/issues/80)) ([6a27d55](https://github.com/mustafakbaser/agentcheckup/commit/6a27d55c0d22b829e990118aa9e2cdb13b7c512f))


### Documentation

* record the demo again with agentcheckup 0.4.0 ([7f165bd](https://github.com/mustafakbaser/agentcheckup/commit/7f165bd657025376fa94ece7d2737e3739296d1e))

## [0.4.0](https://github.com/mustafakbaser/agentcheckup/compare/v0.3.1...v0.4.0) (2026-10-31)


### ⚠ BREAKING CHANGES

* **platforms:** Against a 0.3 baseline, `--gate mcp` trips once for the servers of `.claude/settings.json` and `.claude/settings.local.json`, which the inventory now lists.
* **inventory:** Against a 0.3 baseline, `--gate permissions` trips once for the `allowed-tools` entries that now take effect, such as those of a skill in `.devin/skills`. A policy that forbids `broad-shell` or denies commands fails for a skill Devin Local reads that lists `exec`.
* **inventory:** Against a 0.3 baseline, `--gate env` trips once for a subagentStatusLine setting, `--gate mcp` and `mcp-unpinned` once for a `"type": "sdk"` server in .mcp.json, now skipped for Claude Code, and `--gate models` once for a subagent whose model came from an ANTHROPIC_DEFAULT_MODEL that Claude Code ignores (default, inherit, opusplan, haiku).
* **platforms:** Against a 0.3 baseline, `--gate hooks` trips once for the hooks the inventory now lists, those of a skills-folder plugin's hooks/hooks.json and the inline hooks of a .claude-plugin/plugin.json, and for each hook that `disableAllHooks` turns off. A policy's hooks.require fails where only a hook that is turned off met it.
* **platforms:** The JSON report's assumption `origin` takes the new value `assumed`, and four VS Code assumptions use it. Against a baseline from 0.3, `--gate models` can trip once for a Copilot CLI subagent whose repository sets `model` to `auto`, and for a VS Code agent with `target: github-copilot`.
* **inventory:** Against a baseline from 0.3, `--gate hooks` trips once for the hooks Copilot custom agents declare, and a policy can report them where it passed. Create baselines again with this version.
* **platforms:** The Copilot CLI's startup totals in load plans, `context` and the JSON report change: commands join its skills listing, and skills a skill of the same name shadows, skills the repository turns off and skills the model cannot pick leave it. A baseline from 0.3 shows a one-time change, and a policy's `budgets.startupTokens` can fail where it passed.
* **hooks:** Against a 0.3 baseline, `--gate hooks` trips once for each PreModelRequest or PostModelRequest hook in .codex/hooks.json or .codex/config.toml, which the inventory now lists as an event Codex fires.
* **cli:** Report paths of a scan outside the working directory are relative to the scanned directory, without `../`; a script that joined them to the working directory must join them to the scanned directory. `--json` outside `rules`, and any flag but `--json` on `rules` or on `explain`, now exit 2 instead of being ignored.
* **agents:** Against a 0.3 baseline, `--gate models` can trip once for definitions with a merge key. A policy allowlist or subagent budget fails closed for them where it passed.

### Features

* **report:** order GitHub annotations by what fails the run, and add --sarif-category ([472a3cc](https://github.com/mustafakbaser/agentcheckup/commit/472a3ccc53de8e1b381b8fbe17ff7d33633db03b))
* **rules:** report Devin Local hooks that fail open or set a timeout in milliseconds ([615d1f3](https://github.com/mustafakbaser/agentcheckup/commit/615d1f3b82300dbc5ded38432c26679a5ad6e572))


### Bug fixes

* **agents:** read a merge key in any agent's definition as a file it may not read ([fe0aca2](https://github.com/mustafakbaser/agentcheckup/commit/fe0aca2b1c4825e11f03d15f20655f3a6c053464))
* **agents:** read the Copilot CLI's models in .claude/agents as the CLI documents them ([6784a17](https://github.com/mustafakbaser/agentcheckup/commit/6784a17fe346b44e7b40f402b0fdc14c7e1aa62e))
* **cli:** keep the exit code when a reader closes the pipe, and exit 2 on an unreadable config ([9a82229](https://github.com/mustafakbaser/agentcheckup/commit/9a822299b353388932bb4afd2186637405554eff))
* **cli:** report paths without ../, refuse an --output that names a scanned file, and reject ignored flags ([d0d29a6](https://github.com/mustafakbaser/agentcheckup/commit/d0d29a60c2955d8f5e8cd45980275d831881a902))
* **core:** bound Markdown parsing per scan, not only per file ([d7fe59b](https://github.com/mustafakbaser/agentcheckup/commit/d7fe59beca8297ccb9a9d1b50d3f12ef7bcd8482))
* **fix:** finish or undo the fix in progress on Ctrl+C, and skip the rest ([ae86e97](https://github.com/mustafakbaser/agentcheckup/commit/ae86e97ff1b2c10c80d9c825fed1a2857e9eb2f5))
* **hooks:** accept Codex's model request hook events ([9b97816](https://github.com/mustafakbaser/agentcheckup/commit/9b9781698c936b7ab980e6e7178bd80620a8a647))
* **inventory:** count the tools a Devin Local skill auto-approves ([885daa7](https://github.com/mustafakbaser/agentcheckup/commit/885daa724be0014b57f23d6d38acdcec1469f5c9))
* **inventory:** list the hooks of Copilot custom agents, and plan Copilot hooks as each surface runs them ([9de24d2](https://github.com/mustafakbaser/agentcheckup/commit/9de24d2e4d861146988ecfca3a7d7441e4efc509))
* **inventory:** mark the env overrides and MCP servers Claude Code drops, and list subagentStatusLine ([27b679d](https://github.com/mustafakbaser/agentcheckup/commit/27b679d2d8d3524cd2c0d6b6a93ce902c9696b5a))
* **parse:** report a repeated key that follows a key without a value at the key ([90c3421](https://github.com/mustafakbaser/agentcheckup/commit/90c34212176cd98e8cfc224de559c687b26e5f46))
* **platforms:** leave out the Cline rules, workflows and skills that Cline does not load ([7ef7d2d](https://github.com/mustafakbaser/agentcheckup/commit/7ef7d2de51f26e3cdbd3aff7f3c918c29a6f72b2))
* **platforms:** list the MCP servers Devin Local imports from Claude Code, OpenCode and Zed files ([7029c00](https://github.com/mustafakbaser/agentcheckup/commit/7029c004949020c2063599aeec5fac7b0c007d1f))
* **platforms:** plan Claude Code's per-file cut, settings files and skills-folder plugins as documented ([04a7bb9](https://github.com/mustafakbaser/agentcheckup/commit/04a7bb9d71db1bfc57be186376c59608ba4af684))
* **platforms:** plan the Copilot CLI's .claude/rules, commands and skill order as its reference does ([636b09e](https://github.com/mustafakbaser/agentcheckup/commit/636b09e6299f1fb91edd8ceeeec2256456328429))
* **platforms:** stop calling the Local harness VS Code's default, and read Copilot targets and auto models as documented ([1d615a8](https://github.com/mustafakbaser/agentcheckup/commit/1d615a8af43f26d3130bd37a96d332385dcb46c9))
* **report:** count Markdown budgets in bytes, and keep joiners in Persian and Indic words ([97ffbc1](https://github.com/mustafakbaser/agentcheckup/commit/97ffbc152a577da58e6bce96d90f2d52f15c36ce))
* **report:** neutralize legacy workflow commands from scanned text ([0353ab4](https://github.com/mustafakbaser/agentcheckup/commit/0353ab4fe7514d080522d7c5be779525306732bd))
* **rules:** cite what Devin Desktop documents now that its Cascade pages are gone ([9b569a3](https://github.com/mustafakbaser/agentcheckup/commit/9b569a3d4ecde9d934769a4f6061cfdc6cebac67))
* **rules:** find Slack's rotating app-level and workflow tokens whole ([a9041f3](https://github.com/mustafakbaser/agentcheckup/commit/a9041f318f4b9294ee88ab876e47c44e4623d102))
* **rules:** read Gemini CLI's skill frontmatter as its current loader does ([834f8d5](https://github.com/mustafakbaser/agentcheckup/commit/834f8d5ea1b389b1af76a5a3e1563132b9abfb22))
* **rules:** reference a variable Claude Code expands when mcp/literal-secret fixes a remote server ([8ef8740](https://github.com/mustafakbaser/agentcheckup/commit/8ef87404bd5a9173809e260c11f530e1c272d31d))


### Performance

* **fix:** reuse parses and text work across verification scans ([edc39ee](https://github.com/mustafakbaser/agentcheckup/commit/edc39ee570eebd6060134db45c6ced221314197f))
* **parse:** check frontmatter keys for repeats in linear time ([5dab3ae](https://github.com/mustafakbaser/agentcheckup/commit/5dab3aefb6c6614f9c1d255823294cd1f787ed73))
* **platforms:** build the file-by-agent matrix in one pass per plan ([611ad42](https://github.com/mustafakbaser/agentcheckup/commit/611ad42725cff2c23adbf5ef053d0b07fdda2883))


### Documentation

* pin the examples to the current release, and document the API ([a753360](https://github.com/mustafakbaser/agentcheckup/commit/a753360d86893863ca4d29d2c8e662abce13bdd6))
* re-check the cited sources that changed, and record their new hashes ([0930dde](https://github.com/mustafakbaser/agentcheckup/commit/0930dde63d704c3a9954cd9823e217611dc153b2))

## [0.3.1](https://github.com/mustafakbaser/agentcheckup/compare/v0.3.0...v0.3.1) (2026-10-28)


### Bug fixes

* **platforms:** count the ignored files an agent may load in each plan ([5cbb9ed](https://github.com/mustafakbaser/agentcheckup/commit/5cbb9ede4ad98a3147f3fa27a14ae91f530f14ec))

## [0.3.0](https://github.com/mustafakbaser/agentcheckup/compare/v0.2.0...v0.3.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* **agents:** `agentcheckup agents` and the JSON report's `agents` list definitions they did not before (files without frontmatter, remote agents, files the scan did not read) and correct some names and statuses. Against a baseline from 0.2, the first comparison can show those definitions as added, removed or changed once, and `--gate models` can trip for them. Create the baseline again with this version.
* **platforms:** a plan's `totals.startup` now includes the subagents listing, and subagent entries have trigger `startup` and a size of name plus description. A baseline made by an earlier version shows a one-time startup change, and a policy's `budgets.startupTokens` can fail where it passed. Create baselines again with this version.
* **platforms:** Claude Code's startup totals in load plans, `context` and the JSON report change: listed skills count their names, and skills the model cannot pick, or that `skillOverrides` turns off, leave the startup total. A baseline from 0.2 shows a one-time change, and a policy's `startupTokens` budget can fail where it passed.

### Features

* **cli:** add the tokens command to sum up what each agent's configuration costs in context ([07285b3](https://github.com/mustafakbaser/agentcheckup/commit/07285b3e4e1f6b3220b91bcd70fef4f2a1c974d9))
* **platforms:** list every agent's subagents in its load plan, from the start ([ba68614](https://github.com/mustafakbaser/agentcheckup/commit/ba68614918ea1b39d1ed869f7f1237700df625db))
* **platforms:** measure what each subagent starts with when it runs ([e65fc27](https://github.com/mustafakbaser/agentcheckup/commit/e65fc27d59f9f80ace7733ee5a0f6d1b272bf936))
* **policy:** budget what each subagent call may start with ([f0be6a6](https://github.com/mustafakbaser/agentcheckup/commit/f0be6a6c03c0e2e95dab3f7b21858d7295cf43cc))
* **report:** show what each subagent call starts with, and how a change moves it ([fe4725d](https://github.com/mustafakbaser/agentcheckup/commit/fe4725d162c92ca32f726ddbcfcff986fcb5fe5a))


### Bug fixes

* **agents:** read custom agents as each agent documents them, and switches where a session starts ([613f6e0](https://github.com/mustafakbaser/agentcheckup/commit/613f6e0177766e0710769b7648dbc23fb338bf9c))
* **platforms:** count Claude Code's skill listing as Claude Code builds it ([e8e57af](https://github.com/mustafakbaser/agentcheckup/commit/e8e57af0ad0885a4057d1f81729a2ed2be7cd984))


### Documentation

* compare configuration cost with what sessions spend ([543d561](https://github.com/mustafakbaser/agentcheckup/commit/543d56159cb8843fd8384efaae5bc2f2884f20ed))
* document the tokens command and subagent calls, and record ADR 0014 ([1b078af](https://github.com/mustafakbaser/agentcheckup/commit/1b078af2692a90ec45807363b4041d9c2a06789c))

## [0.2.0](https://github.com/mustafakbaser/agentcheckup/compare/v0.1.1...v0.2.0) (2026-10-27)


### ⚠ BREAKING CHANGES

* **platforms:** A baseline written by an earlier version has no findings in the newly read agent folders, so hidden Unicode there counts as new and `--gate unicode` trips once. A file that `.claude/agents` reaches through a symlink to one of these folders is reported at its real path, so its findings show as new and resolved once, and a Copilot custom agent that declares `mcp-servers` trips `--gate mcp` once. Create the baseline again with this version.
* **inventory:** the inventory has more items. A policy run without a baseline, or with "existing": "fail", can report violations it did not before, and a baseline made by an earlier version shows the new items as added, so the gate trips once. Create baselines again with this version; the GitHub Action does so on every run.

### Features

* **agents:** list every agent definition and the model it runs with ([1b136ba](https://github.com/mustafakbaser/agentcheckup/commit/1b136ba185b27562862b3ea93c19c1cbeb46cf55))
* **cli:** add the agents command to list agent definitions and their models ([a277af1](https://github.com/mustafakbaser/agentcheckup/commit/a277af1224083981276809c07a701676d081dbbb))
* **inventory:** list hooks, MCP servers and permissions declared in frontmatter ([3b2b433](https://github.com/mustafakbaser/agentcheckup/commit/3b2b43392aed974989f16c0e87c6e029219ed73c))
* **inventory:** list the subagent every Claude Code session starts as ([958c14b](https://github.com/mustafakbaser/agentcheckup/commit/958c14b01e2296179d31d1bfa4ad6114908e18b1))
* **platforms:** read the custom agent files of Codex, Cursor, Gemini CLI, Copilot and Devin Local ([c977278](https://github.com/mustafakbaser/agentcheckup/commit/c977278d297e7bf509ffb09a2b0a736961efa150))
* **policy:** allow and deny the models agents may be set to run on ([7bb50ef](https://github.com/mustafakbaser/agentcheckup/commit/7bb50efa0b6331f61c628eb9e5624f7bbea17e55))
* **report:** write agent definitions and model settings, and gate model changes on request ([b7bfb37](https://github.com/mustafakbaser/agentcheckup/commit/b7bfb374138974822aee1736beb862aa60666a32))
* **rules:** report model values agents do not document, and subagent models Claude Code ignores ([b2b0575](https://github.com/mustafakbaser/agentcheckup/commit/b2b057558ff81d23c5d00ffc97e49184c5f9a4f6))


### Bug fixes

* **gate:** label permission modes as set or changed, and say where each change is ([7b904af](https://github.com/mustafakbaser/agentcheckup/commit/7b904afdc6e6d7e44af54197c96597e42a365d42))
* **inventory:** remove credentials from permission values ([bd31a4c](https://github.com/mustafakbaser/agentcheckup/commit/bd31a4c85d5d43d3c9839c9a6406236728269e00))
* **rules:** stop claiming Claude Code skips frontmatter its own reader reads ([8bce8ea](https://github.com/mustafakbaser/agentcheckup/commit/8bce8eae58b82f7444bc52e59d3a04c44d7756ab))


### Documentation

* add npm, OpenSSF Scorecard and Marketplace badges ([eb00419](https://github.com/mustafakbaser/agentcheckup/commit/eb00419d25b97e96e14e5e1143ef3b680e985314))
* document agent definitions and models, and record ADR 0013 ([a3fad3f](https://github.com/mustafakbaser/agentcheckup/commit/a3fad3ff1a3f1aa97250ef005e38cb1893ec95ed))
* document items declared in frontmatter and the session agent, and record ADR 0012 ([1f12ae4](https://github.com/mustafakbaser/agentcheckup/commit/1f12ae4beab21abed9d88d1d49f4603c408289d6))
* show a recording of context, fix and fix --write in the README ([a223f3f](https://github.com/mustafakbaser/agentcheckup/commit/a223f3ff0f6ac8a61df44b6a77b4e644e9ed416a))

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
