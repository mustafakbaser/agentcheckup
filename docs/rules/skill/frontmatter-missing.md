<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/frontmatter-missing`

Skill has no YAML frontmatter on line 1.

|            |                                |
| ---------- | ------------------------------ |
| Severity   | `error`                        |
| Category   | `loading`                      |
| Platforms  | Claude Code, Codex, Gemini CLI |
| Applies to | `skill`                        |
| Fixable    | Yes, `safe` or `review`        |
| Since      | 2026.10                        |

## Why

Agents read a skill's `name` and `description` from YAML frontmatter: a `---` line at the very start of SKILL.md, the fields, and a closing `---` line. Codex and Gemini CLI skip a SKILL.md without it, and one whose frontmatter is never closed; a line such as `----` does not close it. Claude Code still loads the skill, but takes its name from the directory and its description from the first non-empty line of the body, so automatic invocation depends on how the body starts. When the frontmatter is indented or starts after a blank line, Claude Code reads it as instructions. The Agent Skills specification requires the frontmatter.

Start the file with `---`, add `name` and `description`, and close the block with another `---` line.

## Evidence

- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-17
- [Codex source: SKILL.md frontmatter parser (parser.rs)](https://github.com/openai/codex/blob/main/codex-rs/skills/src/parser.rs), verified, checked 2026-10-14
- [Gemini CLI source: skillLoader.ts (byte order mark removed, FRONTMATTER_REGEX)](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/skills/skillLoader.ts), verified, checked 2026-10-30
- [Agent Skills specification](https://agentskills.io/specification), verified, checked 2026-10-14

## Fix

Classes: `safe`, `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Moves the frontmatter to line 1 and removes the indentation of its delimiters (safe), or adds frontmatter with the directory name and the first body line as the description (review). An unclosed block is left to you.

Preview the fix with `agentcheckup fix --rule skill/frontmatter-missing`.

## Configuration

```json
{
  "rules": {
    "skill/frontmatter-missing": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/frontmatter-missing -- reason -->
```
