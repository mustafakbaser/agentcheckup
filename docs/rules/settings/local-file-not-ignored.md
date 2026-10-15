<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `settings/local-file-not-ignored`

CLAUDE.local.md is not gitignored.

|            |                   |
| ---------- | ----------------- |
| Severity   | `warn`            |
| Category   | `risk`            |
| Platforms  | Claude Code       |
| Applies to | `claude-local-md` |
| Fixable    | No                |
| Since      | 2026.10           |

## Why

`CLAUDE.local.md` holds personal instructions for one project, such as sandbox URLs and test data, and Claude Code's documentation says to add it to `.gitignore`. Once committed, it loads for everyone who works in the project. In a directory that relies on `AGENTS.md`, it also stops Claude Code from reading `AGENTS.md` for everyone: by default Claude Code reads `AGENTS.md` only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in the working directory or above.

agentcheckup skips files that a `.gitignore` in the repository excludes, so a reported `CLAUDE.local.md` is not covered by one. It does not read `.git/info/exclude` or your global excludes file: those keep the file out of your clone only, while a `.gitignore` entry covers every clone. `.claude/settings.local.json` is not reported, because Claude Code adds it to your global git excludes when it creates the file.

Add `CLAUDE.local.md` to `.gitignore`. If it is already committed, also run `git rm --cached CLAUDE.local.md`.

## Evidence

- [Claude Code: Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory), verified, checked 2026-10-14
- [Claude Code: Settings](https://code.claude.com/docs/en/settings), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "settings/local-file-not-ignored": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line settings/local-file-not-ignored -- reason -->
```
