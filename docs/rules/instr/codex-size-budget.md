<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `instr/codex-size-budget`

AGENTS.md files exceed the Codex size limit.

|            |                                   |
| ---------- | --------------------------------- |
| Severity   | `error`                           |
| Category   | `budget`                          |
| Platforms  | Codex                             |
| Applies to | `agents-md`, `agents-override-md` |
| Fixable    | No                                |
| Since      | 2026.10                           |

## Why

Codex reads one instruction file per directory, from the project root down to the working directory: `AGENTS.override.md` if it exists, otherwise `AGENTS.md`. It reads at most `project_doc_max_bytes` (32,768 bytes by default) across the whole chain: the file that crosses the limit is cut at that byte, and later files are dropped. Whitespace-only files and the global `~/.codex/AGENTS.md` do not count. Codex's configuration pages call the key a per-file limit; the `AGENTS.md` page and the source code apply it to the chain.

agentcheckup starts each chain at the nearest directory with a `.git` entry (a directory, or a file in submodules and worktrees). Without one, Codex reads only the working directory's file, so agentcheckup judges each file alone. It warns at 80% of the limit, and skips skills and directories that start with a dot or hold templates, examples or fixtures.

Move instructions for one part of the repository into an `AGENTS.md` in that directory, or cut content. If you raised `project_doc_max_bytes`, set the `maxBytes` option to the same value.

## Evidence

- [Codex: AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), verified, checked 2026-10-14
- [Codex source: agents_md.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs), verified, checked 2026-10-14
- [Codex source: defaults.toml (project_doc_max_bytes = 32768, project_root_markers)](https://github.com/openai/codex/blob/main/codex-rs/config/defaults.toml), verified, checked 2026-10-14
- [Codex source: find_up.rs (nearest ancestor with a project root marker)](https://github.com/openai/codex/blob/main/codex-rs/file-system/src/find_up.rs), verified, checked 2026-10-14

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "instr/codex-size-budget": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line instr/codex-size-budget -- reason -->
```
