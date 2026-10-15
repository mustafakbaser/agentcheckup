<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/encoding`

Instruction file is not UTF-8.

|            |                                                                                                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity   | `error`                                                                                                                                                                                                                                                          |
| Category   | `loading`                                                                                                                                                                                                                                                        |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf, Cline                                                                                                                                                                                          |
| Applies to | `agents-md`, `agents-override-md`, `claude-md`, `claude-local-md`, `claude-rule`, `claude-agent`, `gemini-md`, `windsurf-rule`, `windsurf-legacy-rules`, `cline-rule`, `cursor-rule`, `cursor-legacy-rules`, `copilot-instructions`, `copilot-path-instructions` |
| Fixable    | No                                                                                                                                                                                                                                                               |
| Since      | 2026.10                                                                                                                                                                                                                                                          |

## Why

Codex decodes `AGENTS.md` as UTF-8 (`String::from_utf8_lossy`), and Gemini CLI reads `GEMINI.md` with Node.js's UTF-8 decoder. A UTF-16 file, as written by Windows PowerShell's `>` redirection or Notepad's "Unicode" option, reaches them as garbled text with NUL characters between the letters. Bytes that are not valid UTF-8, usually from a legacy encoding such as Windows-1252, become U+FFFD replacement characters, and the original characters are lost.

The other agents do not document how they decode instruction files, so for them this is information only.

Save the file as UTF-8.

## Evidence

- [Codex source: agents_md.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs), verified, checked 2026-10-14
- [Gemini CLI source: memoryDiscovery.ts (reads GEMINI.md as UTF-8)](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryDiscovery.ts), verified, checked 2026-10-14
- [Claude Code: Memory (file encoding is not documented)](https://code.claude.com/docs/en/memory), unverified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "instr/encoding": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line instr/encoding -- reason -->
```
