<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/filename-case`

Instruction file name has the wrong letter case.

|            |                                                                                |
| ---------- | ------------------------------------------------------------------------------ |
| Severity   | `warn`                                                                         |
| Category   | `loading`                                                                      |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf, Cline        |
| Applies to | `agents-md`, `agents-override-md`, `claude-md`, `claude-local-md`, `gemini-md` |
| Fixable    | No                                                                             |
| Since      | 2026.10                                                                        |

## Why

Agents look for instruction files by exact name: `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`. Codex, for example, opens a file named exactly `AGENTS.md` in each directory. On the case-insensitive file systems that macOS and Windows use by default, `Agents.md` matches that name and loads; on Linux, including most CI runners and containers, it does not. The same repository then gives agents different instructions on different machines.

Windsurf's Cascade agent documents both `AGENTS.md` and `agents.md`, so agentcheck does not report `agents.md` for Windsurf; other spellings, such as `Agents.md`, are reported.

Rename the file to the exact name if it holds agent instructions, or to a different name if it does not. On a case-insensitive file system, use `git mv` so Git records the rename.

## Evidence

- [Codex source: agents_md.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs), verified, checked 2026-10-14
- [Claude Code: Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory), verified, checked 2026-10-14
- [Gemini CLI: GEMINI.md](https://geminicli.com/docs/cli/gemini-md/), verified, checked 2026-10-14
- [Devin Desktop (Cascade): AGENTS.md ("Both AGENTS.md and agents.md are recognized")](https://docs.devin.ai/desktop/cascade/agents-md), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "instr/filename-case": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line instr/filename-case -- reason -->
```
