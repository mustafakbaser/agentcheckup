# 0013. List agent definitions and their models

- Status: Accepted
- Date: 2026-10-26
- Amends: [0007](0007-model-what-each-agent-loads.md), whose gate gains a class, and
  [0011](0011-organization-policy.md), whose policy gains a field

## Context

Every agent agentcheckup models but Cline reads custom agents or subagents from the repository,
each from its own folders and in its own format: Claude Code from `.claude/agents`, Codex from
`.codex/agents` and the roles `.codex/config.toml` declares, Cursor from `.cursor/agents`, Gemini
CLI from `.gemini/agents`, GitHub Copilot from `.github/agents`, Devin Local from `.devin/agents`.
Cursor and Copilot read Claude Code's folder too, so one file reaches several agents, each of
which judges its `model` against the values it documents. `model: opus` is right for Claude Code
and not a value Cursor documents.

The model a subagent runs on is the main cost and behavior lever teams ask about, and the
repository says less about it than it seems. Claude Code takes the definition's `model`, then
`CLAUDE_CODE_SUBAGENT_MODEL`, then the main conversation's model, and ignores the definition
under `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`
([Subagents](https://code.claude.com/docs/en/sub-agents)); Codex and Gemini CLI have orders of
their own. The model a call passes, user settings and managed allowlists are invisible to a
static scan.

Token spend per agent was considered too. Claude Code exports it through OpenTelemetry metrics,
and transcripts are a documented-unstable format; both are runtime data a repository scan does
not have, and reading home-directory transcripts would break the rule that agentcheckup never
reads user scopes ([ADR 0003](0003-treat-scanned-repositories-as-hostile.md)).

## Decision

- **A pure module, src/agents, lists every definition once per agent that reads its file**, with
  the name the agent knows it by, whether it loads, is skipped or shadowed or may not load and
  why, its model as written and the form the reading agent documents it in (alias, id, display
  name, `inherit`, not documented), its effort, tools and Claude Code permission mode, and the
  repository's model settings. Each reading cites its source; behavior no source confirms is
  `unverified`. Whether Claude Code loads a subagent is checkSubagent's answer, the one the load
  plan and `instr/subagent-invalid` give. A file an agent reaches through a symlink is read at the
  symlink's path. Definitions collide only within one agent folder's owner directory; where an
  agent does not document which one wins, the loser is unverified. A file agentcheckup cannot
  fully read, such as one with a merge key or past a parser limit, is `unknown`, and its digest
  covers its text.
- **The model a definition runs on follows each agent's documented order, as far as the
  repository's root settings tell.** What only a call, a user or an organization chooses is
  `not-visible`, shown as set outside the repository, never guessed.
- **Every scan writes the list to the JSON report** as `agents`, next to `inventory`, with ids and
  digests, for every agent whatever the targets. A digest leaves out lines and the effective
  model: a changed setting is one change, not one per definition that inherits it. Model values
  and setting values are shown with credentials removed.
- **`agentcheckup agents` shows it**, narrowed to the agents among the targets or those `--agent`
  names; a comparison with `--baseline` is narrowed the same way. Its JSON report is not, so it
  can serve as a baseline.
- **A gate class `models`, outside `security`.** It trips on a definition added or changed, on a
  definition that runs on another model because a setting changed, and on a model setting set,
  changed or removed: unlike a removed permission, a removed override changes what runs.
  `--gate security` keeps meaning what it meant, and fix verification gates only the security
  classes: a model is a cost and behavior choice, not a capability.
- **Two rules, warnings at most.** `agent/model-not-documented` reports a value the agent whose
  format the file is does not document; another agent's reading of the file, such as Cursor's of
  `.claude/agents`, is shown but not reported, since the file is right for its own agent.
  `agent/subagent-model-ignored` reports a subagent model Claude Code ignores under
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`. Neither has a fix: the right model is the author's choice.
- **A policy field `models`**, additive in policy version 1: per agent, `allow` and `deny` lists of
  values; `allow` matches exactly, `deny` also without bracketed options. It checks the models
  the repository makes an agent run on, judges a definition a setting overrides by that setting,
  checks a definition that may win where the order is not documented, and fails an allowlist
  closed for a definition that may load but whose model cannot be read. An older agentcheckup
  stops on the field as an unknown one.

## Consequences

- One subagent file can be four definitions. In the 80-repository corpus the rules report
  nothing: every model value is one its own agent documents, and no repository turns
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` on.
- Reports and baselines grow by the `agents` field. A baseline written before it has none, so the
  first comparison shows every definition as added, and `--gate models` and a `models` policy
  count them as new.
- The list is static: aliases resolve per provider, managed allowlists substitute models, and a
  call may pass its own. Spend per agent stays out of scope until it can be read without user
  scopes.
- New agent formats need a reader, sources and tests in src/agents before their definitions are
  listed. The load plans model Claude Code's subagents only; the other agents' custom agents are
  listed by `agents`, not planned, until their loaders read them.
