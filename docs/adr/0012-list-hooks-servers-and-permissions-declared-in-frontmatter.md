# 0012. List hooks, servers and permissions declared in frontmatter

- Status: Accepted
- Date: 2026-10-26
- Amends: [0007](0007-model-what-each-agent-loads.md) and
  [0011](0011-organization-policy.md), which read the security inventory

## Context

The security inventory ([ADR 0007](0007-model-what-each-agent-loads.md)) lists the MCP servers,
hooks, permissions and environment overrides in configuration files, and a skill's
`allowed-tools`. The gate and an organization policy
([ADR 0011](0011-organization-policy.md)) read only the inventory, so what it leaves out is
never reviewed.

Claude Code reads more of these from frontmatter and settings:

- A subagent in `.claude/agents/` declares `hooks`, inline MCP servers in `mcpServers`, and a
  `permissionMode` ([Subagents](https://code.claude.com/docs/en/sub-agents)). Its hooks run and
  its servers connect only while it runs.
- A skill declares `hooks` that Claude Code registers when the skill is invoked and keeps for the
  rest of the session ([Hooks](https://code.claude.com/docs/en/hooks)).
- A command in `.claude/commands/` accepts a skill's fields except `name` and `paths`
  ([Skills](https://code.claude.com/docs/en/skills)), so its `allowed-tools` and `hooks` act as a
  skill's do.
- The `agent` key, which any settings file may set, starts every session as a named subagent,
  with its prompt, tools, model, hooks and MCP servers
  ([Settings reference](https://code.claude.com/docs/en/settings-reference)).

A pull request could add a subagent that starts an unpinned MCP server, or a command that allows
every shell command, and neither `--gate` nor a policy would see it. In the 80-repository corpus,
12 repositories have subagents and 35 command files set `allowed-tools`.

How Claude Code reads frontmatter is a second gap. The documentation describes YAML between `---`
lines, and a file whose YAML does not parse as one with no fields. Claude Code 2.1.272's reader,
read from its binary and replayed under the Bun version it embeds, does more, none of it
documented:

- it ends the block at the first `---` anywhere, even inside a line, and accepts any whitespace
  after the opening `---`;
- it parses with `Bun.YAML.parse`, which keeps the last of repeated keys, applies `<<` merge keys
  and accepts keys longer than 1,024 characters;
- when that fails, it retries with unquoted values quoted (src/platforms/skill-repair.ts).

Every invalid subagent, command and skill block in the corpus parses after the retry, and some of
them declare hooks or `allowed-tools`. A check that reads only YAML a strict parser accepts, up to
a `---` line, could be evaded with a stray `---`, `: ` or repeated key, while
`instr/subagent-invalid` told the reviewer that Claude Code skips the file.

## Decision

- **List frontmatter items in the inventory.** Subagent `hooks`, inline `mcpServers` and
  `permissionMode`; skill and command `hooks` and `allowed-tools`; the settings `agent`. The same
  readers, ids, digests and redaction as configuration files apply: a hook is
  `hook:<file>#<event>:<digest>`, a server `mcp:<file>#<name>`, credentials never enter an item.
  A server a subagent only names is configured elsewhere and is not listed again; the env ids of a
  subagent's servers use the server's name, not its position in the list.
- **Read every block Claude Code may read.** The documented block and the block Claude Code's
  reader finds, when it differs, are each parsed as they are and, when that fails, as Claude
  Code's retry repairs them, with every line number pointing into the file. The items of all of
  them are listed, each once: listing an item never claims that it runs.
- **Fail closed where agentcheckup cannot read what Claude Code may.** A block that neither parse
  reads, one past a parser limit, and one with merge keys may declare items agentcheckup cannot
  see, so the file is incomplete: a new one trips `hooks`, and `mcp` for a subagent, and a policy
  reports `unanalyzed-config`. agentcheckup does not emulate Bun's YAML semantics.
- **Effect follows the loader.** A subagent Claude Code skips runs no hook (no platforms), starts
  no server (`skipped`) and applies no mode (`effective: false`); one that only an undocumented
  reading loads is unknown. Claude Code drops a `permissionMode` it does not know, and
  `bypassPermissions` there is broad but not effective: since v2.1.267 a subagent runs in that mode
  only when the main conversation does. Files of the repository root's own agent folders load
  whatever their folders are called, as the loaders plan them. A file reached through a symlink
  in an agent folder is read as what it is there.
- **Rules make no claim the reader contradicts.** Where Claude Code's reader may load a subagent
  whose frontmatter the documented form rejects, its load is unknown: the plan lists it as
  unverified, and `instr/subagent-invalid` and `skill/frontmatter-invalid` no longer say that
  Claude Code skips it or reads no fields.
- **Say when an item applies.** Hooks and servers from frontmatter carry an optional `scope`:
  `subagent` (while that subagent runs) or `skill` (from the invocation of the skill or command to
  the end of the session). Gate summaries name it, and a subagent's `Stop` hook shows as
  `SubagentStop`. Items from configuration files have no `scope`, so their digests and baselines
  stay as they were. A baseline with a scope this version does not know still reads.
- **Settings that change what runs trip the gate whenever they change.** A `permissionMode`, like
  `defaultMode`, trips `permissions` as "Permission mode set" or "changed", never as "widened"; the
  settings `agent` trips it as "Session agent set" or "changed". Text output names the file and
  line of every gate hit, as Markdown and annotations do.
- **Scoped hooks are not session hooks.** A hook from a skill, command or subagent never meets a
  policy's `hooks.require`.
- **A breaking change.** A policy run without a baseline can report new violations, and a baseline
  from an earlier version shows the new items as added. Under the release configuration, the
  release is a minor version, so `^0.1` ranges do not pick it up unannounced.

## Consequences

- The gate and policies cover the hooks, MCP servers and permission settings that a repository's
  configuration files, skills, commands, subagents and Claude Code settings declare, and reviews
  see when a scoped item applies. Plugin directories are not covered: a plugin's
  `hooks/hooks.json`, `agents/` and `commands/` are not read yet.
- A baseline made by an earlier version lacks these items, so the first comparison shows them as
  added. The GitHub Action builds its baseline with the same version on every run, so only manual
  baselines are affected; the documentation says so.
- Hooks in another tool's format, such as `pre:` scripts in subagent frontmatter, are not Claude
  Code hooks and are not listed. Most hook blocks in corpus subagents use such a format. A rule
  that reports them is left for later, because it changes findings.
- Only Claude Code is modeled here. Cursor also reads `.claude/agents/` and `.codex/agents/`, and
  Codex, Gemini CLI, GitHub Copilot and Devin Local have subagent files of their own; their fields
  are not yet read.
- The reader's behavior is undocumented. If Claude Code changes it, the inventory may list items
  from a block Claude Code no longer reads, or mark a file incomplete that it reads as documented.
  Both err toward review, never toward silence. The replay is checked against the binary when the
  sources are checked again.
- Reading the documented block parses frontmatter that declares nested items a second time, to
  find their lines; that parse skips the unique-key check the first one made.
