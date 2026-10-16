<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/import-unresolved`

Imported file does not exist.

|            |                                                                         |
| ---------- | ----------------------------------------------------------------------- |
| Severity   | `error`                                                                 |
| Category   | `correctness`                                                           |
| Platforms  | Claude Code, Gemini CLI                                                 |
| Applies to | `claude-md`, `claude-local-md`, `claude-rule`, `agents-md`, `gemini-md` |
| Fixable    | Yes, `review`                                                           |
| Since      | 2026.10                                                                 |

## Why

Claude Code and Gemini CLI replace an `@path` import with the content of the file it names, resolved relative to the importing file. When that file does not exist, Claude Code has nothing to load, and Gemini CLI inserts an "Import failed" comment instead of the text.

Claude Code expands imports in `CLAUDE.md`, `CLAUDE.local.md` and any `AGENTS.md` it reads; agentcheckup also checks `.claude/rules/` files, although Claude Code's documentation does not mention imports there, and reports what it finds there as information. Gemini CLI expands imports in `GEMINI.md`. A file that a `CLAUDE.md` or `GEMINI.md` symlink points to is checked as that file, with imports resolved from the link's directory, as Gemini CLI does. Where the link sits in another directory than its target, Claude Code's documentation does not say which directory it uses, so findings that depend on it are information. To skip mentions such as `@octocat`, agentcheckup reports only paths that start with `./` or `../` or end in a file extension (for Gemini CLI also dotfiles and `@README`). Gemini CLI keeps trailing punctuation, so `@./guide.md.` fails even when `guide.md` exists. Paths in directories agentcheckup did not list, such as `node_modules`, are never reported.

Fix the path, or put a mention you do not want imported in backticks.

## Evidence

- [Claude Code: Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory), verified, checked 2026-10-14
- [Gemini CLI: Memory import processor](https://geminicli.com/docs/reference/memport/), verified, checked 2026-10-14
- [Gemini CLI source: memoryImportProcessor.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryImportProcessor.ts), verified, checked 2026-10-14
- [Claude Code: Memory (imports are documented for CLAUDE.md, CLAUDE.local.md, AGENTS.md and user-level rules, not for project .claude/rules files)](https://code.claude.com/docs/en/memory), unverified, checked 2026-10-14
- [Claude Code: Memory (CLAUDE.md is read through a symlink; whether its relative imports then resolve from the link or from its target is not documented)](https://code.claude.com/docs/en/memory), unverified, checked 2026-10-15
- [Gemini CLI source: memoryDiscovery.ts (reads each GEMINI.md at the path it found, through symlinks, and resolves its imports from that path's directory)](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryDiscovery.ts), verified, checked 2026-10-15

## Configuration

```json
{
  "rules": {
    "instr/import-unresolved": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line instr/import-unresolved -- reason -->
```
