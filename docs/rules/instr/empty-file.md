<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/empty-file`

Instruction file is empty.

|            |                                                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity   | `warn`                                                                                                                                                                                               |
| Category   | `loading`                                                                                                                                                                                            |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf, Cline                                                                                                                              |
| Applies to | `agents-md`, `agents-override-md`, `claude-md`, `claude-local-md`, `claude-rule`, `gemini-md`, `windsurf-rule`, `windsurf-legacy-rules`, `cline-rule`, `cursor-legacy-rules`, `copilot-instructions` |
| Fixable    | No                                                                                                                                                                                                   |
| Since      | 2026.10                                                                                                                                                                                              |

## Why

An instruction file with no content gives agents nothing to follow. Codex skips an empty or whitespace-only `AGENTS.md`. Claude Code strips block-level HTML comments from `CLAUDE.md` before loading it, so a `CLAUDE.md` with only comments is empty for Claude Code. A rule with frontmatter and no body adds no instructions.

An empty file still has effects: an empty `CLAUDE.md` stops Claude Code from reading `AGENTS.md`. An empty `AGENTS.override.md` next to an `AGENTS.md` is reported by `instr/override-shadows-agents-md` instead.

Add the instructions or delete the file.

## Evidence

- [Codex: AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), verified, checked 2026-10-14
- [Codex source: agents_md.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs), verified, checked 2026-10-14
- [Claude Code: Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "instr/empty-file": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line instr/empty-file -- reason -->
```
