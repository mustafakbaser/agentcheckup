<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/import-depth`

Import is nested deeper than the agent follows.

|            |                                                                         |
| ---------- | ----------------------------------------------------------------------- |
| Severity   | `error`                                                                 |
| Category   | `loading`                                                               |
| Platforms  | Claude Code, Gemini CLI                                                 |
| Applies to | `claude-md`, `claude-local-md`, `claude-rule`, `agents-md`, `gemini-md` |
| Fixable    | No                                                                      |
| Since      | 2026.10                                                                 |

## Why

Imported files can import other files, up to a fixed depth: Claude Code follows imports at most four hops from the file it loads, Gemini CLI five. A deeper import is not followed, so the file it names is not loaded.

agentcheckup follows imports only through files it read, such as `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `.claude/rules/` files, and does not report a chain that passes through a file it did not read. A chain that starts at a `.claude/rules/` file is information, because Claude Code's documentation does not say it expands imports there. It also reports import cycles as information: the import that closes a cycle names a file that is already loaded, so it adds no new instructions. Gemini CLI documents that it detects cycles; Claude Code does not document how it handles them.

Import deeply nested files directly from the top-level file.

## Evidence

- [Claude Code: Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory), verified, checked 2026-10-14
- [Gemini CLI: Memory import processor](https://geminicli.com/docs/reference/memport/), verified, checked 2026-10-14
- [Gemini CLI source: memoryImportProcessor.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryImportProcessor.ts), verified, checked 2026-10-14
- [Claude Code: Memory (imports are documented for CLAUDE.md, CLAUDE.local.md, AGENTS.md and user-level rules, not for project .claude/rules files)](https://code.claude.com/docs/en/memory), unverified, checked 2026-10-14
- [Claude Code: Memory (how import cycles are handled is not documented)](https://code.claude.com/docs/en/memory), unverified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "instr/import-depth": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line instr/import-depth -- reason -->
```
