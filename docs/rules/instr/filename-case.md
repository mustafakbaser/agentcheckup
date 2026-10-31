<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/filename-case`

Instruction file name has the wrong letter case.

|            |                                                                                |
| ---------- | ------------------------------------------------------------------------------ |
| Severity   | `warn`                                                                         |
| Category   | `loading`                                                                      |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin Local, Cline     |
| Applies to | `agents-md`, `agents-override-md`, `claude-md`, `claude-local-md`, `gemini-md` |
| Fixable    | No                                                                             |
| Since      | 2026.10                                                                        |

## Why

Agents look for instruction files by exact name: `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`. Codex, for example, opens a file named exactly `AGENTS.md` in each directory. On the case-insensitive file systems that macOS and Windows use by default, `Agents.md` matches that name and loads; on Linux, including most CI runners and containers, it does not. The same repository then gives agents different instructions on different machines.

Devin Local, the default agent of Devin Desktop (formerly Windsurf), discovers lowercase `agents.md` files as well as `AGENTS.md` since Devin CLI v3000.4.16, and the Devin Desktop FAQ names both, so agentcheckup does not report `agents.md` for Devin Local; other spellings, such as `Agents.md`, are reported. Cline reads every Markdown file in `.clinerules/` and `.cline/rules/` as a rule, whatever its name, so a case variant there is not reported for Cline.

Rename the file to the exact name if it holds agent instructions, or to a different name if it does not. On a case-insensitive file system, use `git mv` so Git records the rename.

## Evidence

- [Codex source: agents_md.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs), verified, checked 2026-10-14
- [Claude Code: Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory), verified, checked 2026-10-30
- [Gemini CLI: GEMINI.md](https://geminicli.com/docs/cli/gemini-md/), verified, checked 2026-10-14
- [Devin CLI: Changelog, stable channel (v3000.4.16: lowercase `agents.md`; v3000.11.1: skills grant tools with `allowed-tools`)](https://docs.devin.ai/cli/changelog/stable), verified, checked 2026-10-30
- [Devin Desktop FAQ ("Devin Desktop reads rules from `AGENTS.md` / `agents.md` files")](https://docs.devin.ai/desktop/devin-desktop-faq), verified, checked 2026-10-30
- [Cline source: cline-rules.ts (workflows, hooks and skills in .clinerules are not rules; rule toggles live in frontmatter; nested rule files never reach the model)](https://github.com/cline/cline/blob/main/apps/vscode/src/core/context/instructions/user-instructions/cline-rules.ts), verified, checked 2026-10-30

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "instr/filename-case": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line instr/filename-case -- reason -->
```
