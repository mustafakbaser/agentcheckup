# 0009. Coverage of Copilot, Gemini CLI, Devin Local and Cline, and Codex TOML

- Status: Accepted
- Date: 2026-10-17
- Amends: [0007](0007-model-what-each-agent-loads.md), where the first modeled agents are Claude
  Code, Codex and Cursor and there is no TOML parser

## Context

[ADR 0007](0007-model-what-each-agent-loads.md) gave load plans to Claude Code, Codex and Cursor.
The rules already covered seven platforms, so for GitHub Copilot, Gemini CLI, Devin Desktop and
Cline a scan said what was wrong but not what the agent loads. These agents read much of the same
configuration: on the corpus of 80 repositories, 55 have a root `AGENTS.md`, which every Copilot
surface reads at session start, and Devin Local loads the `.md` files in `.cursor/rules` that
Cursor skips.

ADR 0007 also left `.codex/config.toml` unparsed. Codex starts MCP servers and runs hooks from
it, and the walker did not even read the file, so six corpus repositories with one showed none
of their servers. A pull request could add a server there, and the gate saw only a file it could
not analyze.

Copilot is not one agent. Copilot CLI, Copilot in VS Code and the Copilot cloud agent read
different files from the same repository:

- Instructions: all three read `.github/copilot-instructions.md` and the root `AGENTS.md`. The CLI
  also reads `CLAUDE.md`, `.claude/CLAUDE.md` and `GEMINI.md` from the root down to the working
  directory and follows `@path` references. VS Code reads `CLAUDE.md`, `.claude/CLAUDE.md` and
  `CLAUDE.local.md`, applies `.claude/rules` by `paths`, and reads nested `AGENTS.md` files only
  with a setting that is off by default. The cloud agent applies `*.instructions.md` only through
  `applyTo` and uses the nearest `AGENTS.md`.
- MCP servers: the CLI reads `.mcp.json` and `.github/mcp.json` in trusted folders; VS Code reads
  `.vscode/mcp.json` and the root `.mcp.json`; the cloud agent's servers live in the repository's
  settings on GitHub.com, outside the repository.
- Hooks: all three read `.github/hooks/*.json`; the CLI also runs Claude Code's hooks, VS Code
  only with a setting that is off by default, and the cloud agent fires a subset of events.

The sources disagree or are silent in several places
([What coding agents read](../platforms.md) cites each one):

- **Order.** No Copilot surface, and not Devin Local, documents the order of the startup
  context. The Copilot CLI "combines" its files with no precedence.
- **Gemini CLI.** The docs present `context.fileName` as the list of context file names; the
  source (gemini-cli `ed96fae`) adds those names in front of `GEMINI.md`, which stays one. Since
  version 0.24 the old top-level `contextFileName` is kept without being read or warned about.
  The trusted folders page says folder trust is off by default; the configuration reference says
  `true`, and the source fills in that default.
- **Devin Desktop.** The FAQ said the older Cascade agent remains available through July, which
  has passed. Devin Local shares its harness with Devin CLI, so the Devin CLI pages are its
  documentation. Size limits are documented only for Cascade.
- **Cline.** The docs say a rule whose frontmatter does not parse fails open; the SDK (cline
  `a42df8c`) drops it. The SDK reads only the root `AGENTS.md`, rules ending in `.markdown` and
  `.txt` as well as `.md`, and a legacy `.clinerules` file. It reads only the rules folder itself,
  and the extension does not document subfolders.
- **Codex.** The first reading assumed TOML 1.0. At openai/codex `ce0323f`, `Cargo.lock`
  resolves `toml` 0.9.11+spec-1.1.0 and `toml_parser` 1.1.3, which accept TOML 1.1 syntax and
  skip a leading byte order mark. `PROJECT_LOCAL_CONFIG_DENYLIST` drops more keys than first read,
  among them `apps_mcp_product_sku`, `responses_api_metadata` and two `experimental_realtime_*`
  URLs. Codex rejects `bearer_token` on HTTP servers, and a parse error stops it at startup only
  in a trusted project. Whether a server entry it rejects stops it too is not shown.

## Decision

- **Nine agents.** Load plans cover `claude-code`, `codex`, `cursor`, `copilot-cli`,
  `copilot-vscode`, `copilot-cloud`, `gemini`, `windsurf` and `cline`, in that order. Each agent
  belongs to a platform (`CONTEXT_PLATFORM`), which is what rules, findings and `targets` name,
  and has one switch that turns its loader on (`LOADER_ENABLED`).
- **Copilot is three agents.** A merged Copilot plan would claim loads that no surface makes,
  such as `CLAUDE.local.md`, which only VS Code reads, next to Claude Code's hooks, which by
  default only the CLI runs. Each surface
  gets its own plan, and all three share the platform `copilot`, so rule ids, `targets` and
  findings do not change. The consistency check matches a Copilot finding with a skip in any
  surface's plan. `--agent copilot` stands for the three surfaces; `--agent` also takes agent ids
  and `all`. Copilot Chat and code review on GitHub.com are not planned.
- **Devin Local, as `windsurf`.** The plan models Devin Local, the default agent of Devin Desktop,
  from the Devin CLI pages. Cascade is not planned. The id stays `windsurf`, the platform id rules
  and configurations already use, and reports name the agent Devin Local.
- **Where the sources disagree, the plan follows the source code when it is published and marks
  the rest unverified.** Gemini CLI reads `GEMINI.md` with the names `context.fileName` adds, and
  the new rule `gemini/settings-key-ignored` reports old top-level keys. Cline follows its SDK.
  Plans assume folder trust off for Gemini CLI, after the trusted folders page.
- **Undocumented order is unverified.** When no source documents the order of the startup
  context, a plan does not invent one. Copilot plans list files in a fixed order, per directory
  from the root down and then the skills listing, and mark every position unverified ("?").
  Devin Local's startup entries have no position. Other behavior no source confirms, such as
  Cline's rule subfolders, Cascade's 12,000-character limit applied to Devin Local, or VS Code
  setting defaults, is unverified too, and never an error
  ([ADR 0004](0004-evidence-backed-rules.md)).
- **New skip codes:** `wrong-location`, `no-apply-to`, `shadowed-by-preferred`, `disabled`,
  `never-active` and `invalid-toml`.
- **One implementation per decision.** How Copilot places and applies instructions, which context
  files Gemini CLI reads, when a Devin rule applies and what `read_config_from` turns off, which
  files in `.clinerules` are rules, and which Codex settings apply live in `src/platforms/`, used
  by the rules and the loaders alike.
- **A full TOML parser for `.codex/config.toml`.** Codex reads the file with the Rust `toml`
  crate, so every TOML spelling of a table starts a server: `[mcp_servers.x]`,
  `[mcp_servers."x"]`, a top-level `mcp_servers.x.command = …` or an inline table. A parser for a
  subset would let a pull request hide a server in a spelling the subset rejects or reads
  differently, and the inventory and the gate would not see it. `src/parse/toml.ts` therefore
  accepts the crate's whole grammar, TOML 1.0 and the TOML 1.1 syntax that the locked crates
  read, skips one leading byte order mark, and builds the value tree the crate builds. It returns
  the same document shape as the JSON parser, so the helpers for spans, hook handlers, secrets
  and fingerprints work unchanged. It is bounded like the other parsers
  ([ADR 0003](0003-treat-scanned-repositories-as-hostile.md)): at most 1 MiB, 64 levels and
  100,000 values, one linear pass, null-prototype tables, and a stop at the first error. A pinned
  subset of the MIT-licensed toml-test suite, hostile inputs and property tests check it.
- **What Codex does with the file.** The plan reads `.codex/config.toml` in each directory from
  the project root down to the working directory, the closest value winning: its MCP servers,
  `enabled = false`, its hooks and `features.hooks`, and `project_doc_max_bytes` and
  `project_doc_fallback_filenames`, which take precedence over the rule option. The rule
  `codex/config-invalid` reports a file that is not valid TOML and server entries Codex rejects,
  and `codex/ignored-project-key` reports keys Codex drops from a project file.
- **The gate fails closed.** What agentcheckup cannot read never counts as safe. A
  `.codex/config.toml` that is not valid TOML is skipped in the plan as `invalid-toml` and listed
  in the inventory as `invalid-toml:<path>`; one the parser does not read, in UTF-16 or past a
  limit, is listed as not analyzed. Either trips the `mcp` and `hooks` gate classes when it
  appears. So do an unparseable `.devin/mcp_config.json` or `.github/mcp.json` (`mcp`) and the
  files in Cline's hook and plugin folders (`hooks`), whose format no source documents. Codex's
  permission settings (`approval_policy`, `sandbox_mode`, network access, writable roots and tool
  approval modes) are permission keys the widening check does not name, so they trip the
  `permissions` class whenever they are added or changed.

## Consequences

- `context`, the matrix and the session-start summary of a pull request cover nine agents. On the
  corpus, the consistency check finds no mismatch between the plans and the findings for any of
  them, and with `.codex/config.toml` read the inventory lists 132 MCP servers, 85 of the 97 that
  start from a command unpinned.
- Nine columns do not fit a terminal with full labels. With more than four agents the text matrix
  shows one letter per cell under a grouped header, with a key, and leaves out agents that read
  none of the files. It is denser to read; Markdown keeps full names and JSON every column.
- Copilot appears three times in plans and summaries. That is longer, and it is the only way to
  show that a nested `AGENTS.md` reaches the CLI and the cloud agent but not VS Code.
- Startup positions are not comparable across agents: Copilot's are marked "?" and Devin Local
  has none. Totals still are.
- The TOML parser is code we maintain. A new TOML version or a new `toml` crate in Codex can
  change what Codex accepts; the sources pin the crates of `ce0323f`, and the weekly source
  check reports when a cited page changes.
- A baseline written before this change lists `.codex/config.toml` as not analyzed and has no
  inventory items for the new MCP and hook files, so the first comparison shows those servers and
  hooks as added and the gate trips once. Writing the baseline again fixes it.
- Some files are still not read: Cline rules ending in `.txt` or `.markdown`, the legacy
  `.clinerules` file, and Devin's `AGENTS.local.md`, `AGENT.md` and global rules files. Plans list
  them as incomplete, without a size.
- Where a vendor later settles a disagreement, the fix is a source and a certainty, not a new
  design: the plans already say which claims are unverified.
