<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/vague-directive`

Instruction is generic advice that says nothing about the project.

|            |                                                                                                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity   | `info`                                                                                                                                                                                                                     |
| Category   | `clarity`                                                                                                                                                                                                                  |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf, Cline                                                                                                                                                    |
| Applies to | `agents-md`, `claude-md`, `claude-local-md`, `claude-rule`, `gemini-md`, `windsurf-rule`, `windsurf-legacy-rules`, `cline-rule`, `cursor-rule`, `cursor-legacy-rules`, `copilot-instructions`, `copilot-path-instructions` |
| Fixable    | No                                                                                                                                                                                                                         |
| Since      | 2026.10                                                                                                                                                                                                                    |

## Why

Sentences such as "Follow best practices" or "Write clean code" tell an agent nothing about this project. Claude Code's documentation asks for instructions concrete enough to verify ("Use 2-space indentation" instead of "Format code properly"). Windsurf's says generic rules like "write good code" are already in Cascade's training data, and Cursor's says to avoid vague guidance. Gloaguen et al. (2026) found that context files are useful mainly for non-standard practices, and that they raise inference cost by over 20% on average.

agentcheckup reports a sentence only when the whole sentence is one of a fixed list of generic directives, and only in English text.

Replace it with the specific command, convention or path you mean, or delete it.

## Evidence

- [Claude Code: Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory), verified, checked 2026-10-14
- [Devin Desktop (Windsurf): Memories and rules](https://docs.devin.ai/desktop/cascade/memories), verified, checked 2026-10-14
- [Cursor: Rules](https://cursor.com/docs/rules), verified, checked 2026-10-14
- [Agentic AI Foundation: Writing an effective AGENTS.md](https://aaif.io/blog/writing-an-effective-agents-md), verified, checked 2026-10-14
- [Gloaguen et al., Evaluating AGENTS.md (arXiv:2602.11988)](https://arxiv.org/abs/2602.11988), verified, checked 2026-10-14
- [Augment Code: How to write good AGENTS.md files](https://www.augmentcode.com/blog/how-to-write-good-agents-dot-md-files), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "instr/vague-directive": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line instr/vague-directive -- reason -->
```
