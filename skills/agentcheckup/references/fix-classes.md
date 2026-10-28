# Fix classes and the fix output

Commands on this page leave out the `npx agentcheckup@...` prefix. Run them with the exact
prefix that SKILL.md uses.

## Safe, review and manual

- **safe**: deterministic, one correct form, keeps the author's text, and adds or changes no MCP
  server, hook, permission or env override. `fix --write` applies only these. Examples: adding
  `@AGENTS.md` as line 1 of a `CLAUDE.md`, saving a `SKILL.md` without its byte order mark,
  removing a suppression comment that suppresses nothing.
- **review**: every other fix agentcheckup can write. `fix --write --review --rule RULE_ID`
  applies one rule's. Examples: renaming a Cursor rule from `.md` to `.mdc` and adding
  `alwaysApply: true`, which puts it in every conversation; adding `"type"` to an MCP server,
  which lets the agent start it; copying the first body line of a skill into `description`, for
  the user to reword.
- **manual**: no fix. The `manual` line says what to do; `tasks` turns it into a task.

A fix that adds or changes an MCP server, hook, permission, env override or hidden Unicode is
always `review`, even when the rule calls it safe.

## Reading the preview

```text
safe    instr/agents-md-ignored-by-claude  Add "@AGENTS.md" as line 1 of CLAUDE.md
--- a/CLAUDE.md
+++ b/CLAUDE.md
...
  effect: Claude Code session start ≈48 → ≈67 tokens
  effect: Cursor, Copilot CLI, Copilot in VS Code, Copilot cloud agent and Devin Local session start ≈64 → ≈67 tokens
  note: GitHub Copilot CLI also reads CLAUDE.md, so it may load AGENTS.md twice ...

manual  instr/import-unresolved  CLAUDE.md:5  create "docs/setup.md" or correct the path; no file named "setup.md" exists
Verified on an in-memory copy: 1 finding resolved, 0 new, 1 left · 1 needs judgment: agentcheckup tasks
```

- `effect:` lines say what the fix changes for the agents: session-start tokens, one line for
  the agents that share a change, or an MCP server, hook, permission or env override with the
  gate class that flags it in a pull request, such as `(gate class mcp)`. Tell the user about
  every gate effect before asking.
- `note:` lines are what the rule knows about the change, such as a side effect nobody verified
  or a reminder to reword copied text.
- `skipped:` lines are fixes that will not apply in this run: they overlap a fix that goes first
  (run `fix` again), the file changed since the scan, or a re-scan showed the fix does not
  resolve its finding or adds a problem.
- The last line compares the fixed copy with the repository. `new info` findings are advice and
  do not stop a fix; a new error or warning always does.

## What fix never does

It never deletes a file, renames a directory, makes a case-only rename, runs git or any other
program, writes through a symlink or hard link, writes inside `.git`, overwrites a file by
creating one, or writes a file that changed since the scan. Each fix is all or nothing.

## Credentials

`mcp/literal-secret` fixes replace a literal token with a reference to an environment variable.
They are never part of `fix --write --review`, and this skill never applies them. The user must
revoke and rotate the credential first: editing the file does not remove it from git history.

## Exit codes of fix

| Code | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| 0    | Nothing to change, or every selected fix was applied and verified on disk |
| 1    | The preview would change files, or a selected fix was not applied         |
| 2    | Invalid arguments or configuration, such as an unknown `--rule`           |
| 3    | Internal error: a rule or the scanner crashed, and nothing was written    |
