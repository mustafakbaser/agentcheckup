<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/agents-md-ignored-by-claude`

Claude Code skips AGENTS.md because a CLAUDE.md exists.

|            |                         |
| ---------- | ----------------------- |
| Severity   | `warn`                  |
| Category   | `loading`               |
| Platforms  | Claude Code             |
| Applies to | `agents-md`             |
| Fixable    | Yes, `safe` or `review` |
| Since      | 2026.10                 |

## Why

By default, Claude Code (v2.1.277 and later) reads `AGENTS.md` only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in the working directory or any directory above it. Otherwise it reads only the `CLAUDE.md` files, so the instructions that Codex, Cursor and GitHub Copilot get from `AGENTS.md` never reach Claude Code.

agentcheckup assumes the default **Project instructions** setting, `claude-md-or-agents-md`. It does not report an `AGENTS.md` that a `CLAUDE.md` or `.claude/rules/` file imports, symlinks or copies; one inside a skill, a template, example or fixture directory, or a directory whose name starts with a dot, such as `.github/`; or one whose status depends on a file agentcheckup did not read, such as a gitignored `CLAUDE.local.md`.

Add the line `@AGENTS.md` to the `CLAUDE.md`; Claude Code never reads an imported `AGENTS.md` twice. If you keep separate files on purpose, suppress the finding with a reason.

## Evidence

- [Claude Code: Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory), verified, checked 2026-10-30

## Fix

Classes: `safe`, `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Adds "@AGENTS.md" as the first line of the CLAUDE.md in the same directory (safe), or creates a CLAUDE.md with that line when the CLAUDE file Claude Code reads instead is in a parent directory or is a CLAUDE.local.md (review).

Preview the fix with `agentcheckup fix --rule instr/agents-md-ignored-by-claude`.

## Configuration

```json
{
  "rules": {
    "instr/agents-md-ignored-by-claude": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line instr/agents-md-ignored-by-claude -- reason -->
```
