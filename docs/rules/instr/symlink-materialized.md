<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/symlink-materialized`

Instruction file is a symlink checked out as plain text.

|            |                                                                                                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity   | `error`                                                                                                                                                                                                                                                          |
| Category   | `loading`                                                                                                                                                                                                                                                        |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin Local, Cline                                                                                                                                                                                       |
| Applies to | `agents-md`, `agents-override-md`, `claude-md`, `claude-local-md`, `claude-rule`, `claude-agent`, `gemini-md`, `windsurf-rule`, `windsurf-legacy-rules`, `cline-rule`, `cursor-rule`, `cursor-legacy-rules`, `copilot-instructions`, `copilot-path-instructions` |
| Fixable    | Yes, `review`                                                                                                                                                                                                                                                    |
| Since      | 2026.10                                                                                                                                                                                                                                                          |

## Why

When a repository commits a symlink such as `CLAUDE.md -> AGENTS.md`, Git checks it out as a one-line text file that holds the target path unless `core.symlinks` is enabled. This is common on Windows, where creating symlinks needs Administrator rights or Developer Mode. Agents then read the path instead of the instructions it points to. Claude Code's documentation warns about this for `CLAUDE.md`.

For `CLAUDE.md`, replace the symlink with a file that contains the import `@AGENTS.md`, which works on every platform. Otherwise enable symlinks (`git config core.symlinks true`) and check the file out again.

## Evidence

- [Claude Code: Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory), verified, checked 2026-10-14
- [Git: core.symlinks](https://git-scm.com/docs/git-config#Documentation/git-config.txt-coresymlinks), verified, checked 2026-10-14

## Fix

Classes: `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Replaces the path in a CLAUDE.md or GEMINI.md with an import of the file it links to; other files need symlinks enabled in Git.

Preview the fix with `agentcheckup fix --rule instr/symlink-materialized`.

## Configuration

```json
{
  "rules": {
    "instr/symlink-materialized": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line instr/symlink-materialized -- reason -->
```
