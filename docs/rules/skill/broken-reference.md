<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/broken-reference`

Skill links to a missing file or outside its directory.

|            |                                                        |
| ---------- | ------------------------------------------------------ |
| Severity   | `error`                                                |
| Category   | `correctness`                                          |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI |
| Applies to | `skill`                                                |
| Fixable    | Yes, `safe` or `review`                                |
| Since      | 2026.10                                                |

## Why

SKILL.md links to supporting files with paths relative to the skill directory, as the Agent Skills specification asks. A link to a missing file leads the agent nowhere. A path that differs from the file only in letter case works on macOS and Windows but not on Linux, and backslashes do not separate directories on Linux or macOS. Skills are installed and uploaded one directory at a time, so a link that leaves the skill directory, such as `../shared/style.md`, breaks when the skill is installed on its own.

Not reported: links into another skill of the same collection, and, for a skill used in this repository, paths that exist relative to the repository root. In a symlinked SKILL.md, a link that resolves from the real file's directory counts as found.

Fix the path, or move the file into the skill directory.

## Evidence

- [Agent Skills specification](https://agentskills.io/specification), verified, checked 2026-10-14
- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-17
- [VS Code: Use Agent Skills (GitHub Copilot)](https://code.visualstudio.com/docs/agent-customization/agent-skills), verified, checked 2026-10-14
- [Claude API: Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices), verified, checked 2026-10-14

## Fix

Classes: `safe`, `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Replaces backslashes in a link with `/` (safe), or writes the link in the letter case of the only file it matches (review). Other broken links are left to you.

Preview the fix with `agentcheckup fix --rule skill/broken-reference`.

## Configuration

```json
{
  "rules": {
    "skill/broken-reference": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/broken-reference -- reason -->
```
