# 0018. Inventory every repository surface that runs code

- Status: Accepted
- Date: 2026-11-18
- Amends: [0007](0007-model-what-each-agent-loads.md), [0016](0016-report-what-a-scan-could-not-see.md)
  and [0017](0017-digest-what-redaction-hides.md), whose inventory left these surfaces out

## Context

An audit on 2026-11-14, checked against the Claude Code documentation and CHANGELOG on
2026-11-18, found repository-scoped Claude Code surfaces that run code, grant permissions or
install extensions, which the security inventory did not list, so `--baseline` with `--gate
security` passed pull requests that added or changed them:

- `headersHelper` on a remote MCP server: "Claude Code executes a `headersHelper` as an arbitrary
  shell command" ([MCP](https://code.claude.com/docs/en/mcp)).
- `sandbox` settings, which any settings file may set: `excludedCommands`,
  `autoAllowBashIfSandboxed`, `filesystem.allowWrite`, `network.allowedDomains`, the proxy ports
  and more. Claude Code ignores the ones that loosen the sandbox in a repository's files only
  while managed settings make the sandbox admin-required
  ([Sandboxing](https://code.claude.com/docs/en/sandboxing)). `autoAllowBashIfSandboxed`
  defaulted to `true` before 2.1.325
  ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)).
- `enabledPlugins` and `extraKnownMarketplaces`: a project's `true` beats a user's `false`, and a
  marketplace is registered once the folder is trusted
  ([Settings reference](https://code.claude.com/docs/en/settings-reference)). The GitHub Copilot
  CLI and Copilot cloud read both keys from `.claude/settings.json` too
  ([Copilot CLI configuration directory](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)).
- Skills-folder plugins: their mods ("a plugin's mod runs JavaScript inside Claude Code with your
  permissions", [Plugin security](https://code.claude.com/docs/en/plugins/security)), language
  servers ("Claude Code also starts the language servers the plugin declares"), `bin/` ("on the
  Bash tool's `PATH` while the plugin is enabled") and skills, loaded as `/<plugin>:<skill>`,
  whose `allowed-tools` the inventory attributed to Cursor and Devin Local only.
- Workflows in `.claude/workflows/`, JavaScript that "orchestrates many subagents" and "runs as
  `/<name>`" ([Workflows](https://code.claude.com/docs/en/workflows)), and Claude Desktop's preview
  servers in `.claude/launch.json`, whose `runtimeExecutable` is "The command to run" and which
  Claude starts "automatically after editing project files"
  ([Desktop](https://code.claude.com/docs/en/desktop)).
- Variables such as `BASH_ENV`, `DYLD_INSERT_LIBRARIES`, `GIT_SSH_COMMAND` and `PERL5OPT`, which
  make a later process run other code, were `other` env overrides, which never trip the gate.

## Decision

- **List each surface with the item kind that already means what it does.** A `headersHelper` is
  a field of its server's item (redacted for display, whole without credentials in the digest),
  so it trips `mcp`. Sandbox settings that widen the sandbox and plugin settings are permission
  items keyed by their path (`sandbox.excludedCommands`, `enabledPlugins.<plugin>`,
  `extraKnownMarketplaces.<name>`), so they trip `permissions`. Commands Claude Code starts that
  are not hooks or MCP servers, a plugin's language servers, its `bin/` folder (a `PATH`
  override) and Desktop preview servers, are `code-exec` env overrides, as `apiKeyHelper` is, so
  they trip `env`.
- **Plugin items keep their names whole.** The gate and policies read a permission by the last
  segment of its key; a plugin or marketplace key ends in a name the repository chooses, so it is
  matched by its prefix first. A plugin set to `false` never widens; a marketplace's digest covers
  its source, without header values, and `autoUpdate`, so another source under the same name is a
  change.
- **Scripts are not analyzed, but changes to them are seen.** agentcheckup does not read
  JavaScript. A workflow or a mod module is an `incomplete` entry `code:<path>#<sha256>` with the
  SHA-256 of its bytes, so adding or changing one is a new entry and trips `hooks` as "Not
  analyzed", "New" or "Changed". A module outside the plugin's `hooks/` folder, which the walk does
  not read, or a `modules` value that is not a list of paths inside the plugin, leaves
  `hooks/hooks.json` not analyzed. So does a manifest that names more skill, command or workflow
  folders, and a plugin with `commands/` files, whose fields the inventory does not read.
- **Effect follows the documentation.** Sandbox keys documented as "User or managed", and
  `CLAUDE_CODE_ENABLE_CFC=1` and `OTEL_LOG_MANAGED_SETTINGS` in project settings, are listed with
  `"effective": false`. Settings that only restrict the sandbox are not listed. `ENV` is
  `code-exec` only when its value names a file, because projects often use it for a deployment
  name and only an interactive shell reads it.
- **What is not modeled.** `.claude/scheduled_tasks.json` is not read: its format is not
  documented, and "sessions there list the copied tasks but don't run them". `.claude/loop.md` is
  checked as an instruction file, not inventoried: it runs only when someone types `/loop`.
  `sandbox.ignoreViolations` only silences reports.

## Consequences

- A baseline made by an earlier version lacks these items, so the first comparison shows them as
  added or changed and the gate trips once. The GitHub Action builds its baseline with the same
  version on every run, so only hand-made baselines are affected. `fingerprintVersion` stays 3:
  the digests of items that existed before change only where they gained a field (a
  `headersHelper`) or a class (a variable now `code-exec`), not for every item.
- In the 80-repository corpus the change adds 22 sandbox items (one repository), 12 plugin and 7
  marketplace items, 5 preview servers, 4 workflows and 2 `PYTHONPATH` overrides; no finding
  changes.
- Changing a script that a workflow or mod imports does not change the entry's digest. The entry
  covers only the file Claude Code loads first.
- A policy reports each `code:` entry as `unanalyzed-config`, under an id without the digest.
