# 0014. Measure subagent calls and sum up what configuration costs in context

- Status: Accepted
- Date: 2026-10-28
- Amends: [0007](0007-model-what-each-agent-loads.md), whose plans gain every agent's
  subagents and what each call starts with, and [0011](0011-organization-policy.md), whose
  budgets gain a field

## Context

Load plans counted what a session starts with, but subagents only half. Claude Code's plan listed
each subagent as something the model picks later, sized by its description, and no other agent's
plan listed custom agents at all, though Codex, Cursor, Gemini CLI, GitHub Copilot and Devin
Local read them ([ADR 0013](0013-list-agent-definitions-and-their-models.md)). Claude Code's
documentation, read again on 2026-10-27, says more
([Subagents](https://code.claude.com/docs/en/sub-agents)):

- The model delegates by each subagent's description, and "those descriptions take up context":
  Claude Code warns at startup when the names and descriptions pass 15,000 tokens.
- A subagent starts in a context window of its own, with its prompt, every level of the CLAUDE.md
  hierarchy the session loads unless the definition sets `omitClaudeMd: true`, the full content
  of the skills its `skills` field preloads (the first 32 names; a skill the model cannot invoke
  cannot be preloaded), memory its `memory` field adds, and what no file shows: environment
  details, the task message, git status.
- Project subagents are found from the working directory up to the repository root, the one
  closest to the working directory winning on a name.

Its skills documentation adds that the listing holds every skill's name, that a skill with
`disable-model-invocation: true` has its "description not in context", and that
`skillOverrides` in the settings can list a skill by name only, hide it or turn it off. The plan
counted descriptions without names and listed every skill.

Cursor, Gemini CLI and Devin Local document that their model reads each custom agent's
description to decide when to delegate. The Copilot CLI gives a custom agent the repository's
instruction files only with `include-custom-instructions: true`, and loads every `.github/agents`
before any `.claude/agents`; Codex adds its skills instructions block to a custom agent. Beyond
that, the agents document only that the file's body is the subagent's prompt.

Teams asked to see what their agents spend, per agent and in total. What a session spends is
runtime data; what the repository's configuration puts in context is not, and it is what a
review can change.

## Decision

1. **One discovery.** Which agent reads which agent file, and what it does with it, moves to
   `src/platforms/agent-files.ts`, shared by the agent definitions and the load plans, so the two
   cannot disagree.
2. **Subagents in every plan.** A step after every loader lists the agent's subagents: their
   listing, name and description, is a startup entry and counts in the session-start total. It is
   documented for Claude Code, Cursor, Gemini CLI and Devin Local, unverified for Codex and
   Copilot.
   Folders are read from the working directory up to the repository root for Claude Code, Codex
   and the Copilot CLI, the root's for the Copilot cloud agent, and the working directory's own
   folder for Cursor, Copilot in VS Code, Gemini CLI and Devin Local, as each loader already takes
   its working directory. A plan applies the switches its session reads, such as Codex's
   `agents.enabled` in every `.codex/config.toml` layer down to the working directory.
3. **What a call starts with**, `ownContext` on each subagent entry: for Claude Code, its prompt,
   the session's startup instruction files unless `omitClaudeMd`, the bodies of the skills it
   preloads, with the preloads it does not get and why, the names past the first 32 as a count,
   and the part of its `MEMORY.md` the agent memory adds, which the scan now reads as an
   artifact of its own; for the Copilot CLI, the instruction files with
   `include-custom-instructions: true`; for Codex, the skills listing as its skills instructions
   block; and the prompt. It is not part of the plan's totals. A definition's prompt and listing
   are measured once per scan, however many plans list it. What the scan did not read is named
   as unmeasured, a subagent it cannot read at all has no call, and a definition that may load
   instead of the preferred one, where the agent does not document which one wins, carries its
   call on its skip.
4. **Claude Code's skill listing** counts names, leaves out skills the model cannot invoke, and
   applies `skillOverrides` from the working directory's settings.
5. **A new limit,** `claude-code.agent_descriptions_tokens`, in a new unit, `tokens`: advice,
   because every subagent still loads past it.
6. **`agentcheckup tokens`** sums the plans up per agent, lists the largest calls with the model
   each runs on, and with `--by-directory` ranks the directories a session can start in (at most
   50, counting the rest). The report keeps each directory's totals, not its plans, so its size
   grows with directories rather than with directories × agents × entries. A baseline comparison
   lists the calls that moved, apart from each entry, since one CLAUDE.md edit moves every Claude
   Code call.
7. **Policy budgets** take `subagentStartupTokens`, checked per subagent, additive in policy
   version 1: an older agentcheckup rejects the unknown field and stops, so the budget cannot
   pass by being ignored. The check fails closed on a call it cannot measure, or measure in
   full, checks either of two definitions that may run, and reads the startup budget's plans; a
   note counts the subagents below the root that none of them lists.

Estimates stay characters ÷ 4 and never cause a finding.

## Consequences

- Session-start totals now include the subagents listing and drop Claude Code skills the model
  cannot pick: a baseline from 0.2 shows a one-time change, and a startup budget can fail where it
  passed. Release notes say so.
- The number a team sees per subagent call matches what Claude Code documents, so a review can
  weigh a large `CLAUDE.md` against every subagent that loads it, or set `omitClaudeMd`.
- Calibrating the estimate per kind of text was considered. It needs the model's tokenizer, which
  for Claude runs only through an API; agentcheckup makes no network requests
  ([ADR 0003](0003-treat-scanned-repositories-as-hostile.md)), so the estimate stays as it is and
  says so.
- A rule for preloads that do not load was considered. Its answer depends on the skills listing
  of the session's working directory, which only the loader computes; a rule would repeat that
  loading behavior. The plans and `agentcheckup context` show such preloads instead.
- A subagent's `MEMORY.md` is written by the agent at runtime, but a project-scope one is in the
  repository and in every call: the scan reads it as an artifact, so the rules that read every
  file, such as hidden Unicode, check it too.
- Planning a session beside every nested agent folder for the subagent budget was considered. A
  baseline written with `--context` has only the root's plans, so every nested violation would
  count as new on every pull request; the note says what the budget does not cover instead.
- What a session actually spends stays out of scope: agentcheckup reads no transcripts and no
  telemetry. [What agent configuration costs in context](../tokens.md) points to the agents' own
  views.
