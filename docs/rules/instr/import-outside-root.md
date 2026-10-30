<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/import-outside-root`

Import points outside the repository.

|            |                                                                         |
| ---------- | ----------------------------------------------------------------------- |
| Severity   | `warn`                                                                  |
| Category   | `portability`                                                           |
| Platforms  | Claude Code, Gemini CLI                                                 |
| Applies to | `claude-md`, `claude-local-md`, `claude-rule`, `agents-md`, `gemini-md` |
| Fixable    | No                                                                      |
| Since      | 2026.10                                                                 |

## Why

An `@path` import of an absolute path, a `~/` path or a relative path that leaves the repository names a file that other clones and CI runners do not have. Claude Code also asks for approval before it loads imports outside the working directory, and loads none of them if you decline. Gemini CLI never loads an import outside the project root (the nearest directory with `.git`) and inserts an "Import failed ... Path traversal attempt" comment instead; that case is an error.

Claude Code's documentation suggests `~/` imports for personal instructions, so those are information only, and imports in `CLAUDE.local.md` are not reported. Relative imports are checked only when a `.git` entry shows where the repository ends: at the scanned directory for Claude Code, at or above the file for Gemini CLI. Imports reached only through `.claude/rules/` files are information, because Claude Code's documentation does not say it expands imports there. A file that a `CLAUDE.md` or `GEMINI.md` symlink points to is checked as that file, with imports resolved from the link's directory, as Gemini CLI does. Where the link sits in another directory than its target, Claude Code's documentation does not say which directory it uses, so findings that depend on it are information.

Copy shared instructions into the repository and import them with a relative path.

## Evidence

- [Claude Code: Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory), verified, checked 2026-10-30
- [Gemini CLI: Memory import processor](https://geminicli.com/docs/reference/memport/), verified, checked 2026-10-14
- [Gemini CLI source: memoryImportProcessor.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryImportProcessor.ts), verified, checked 2026-10-14
- [Claude Code: Memory (imports are documented for CLAUDE.md, CLAUDE.local.md, AGENTS.md and user-level rules, not for project .claude/rules files)](https://code.claude.com/docs/en/memory), unverified, checked 2026-10-14
- [Claude Code: Memory (CLAUDE.md is read through a symlink; whether its relative imports then resolve from the link or from its target is not documented)](https://code.claude.com/docs/en/memory), unverified, checked 2026-10-15
- [Gemini CLI source: memoryDiscovery.ts (reads each GEMINI.md at the path it found, through symlinks, and resolves its imports from that path's directory)](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/memoryDiscovery.ts), verified, checked 2026-10-15

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "instr/import-outside-root": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line instr/import-outside-root -- reason -->
```
