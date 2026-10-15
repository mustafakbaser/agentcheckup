<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/frontmatter-bom`

Skill file starts with a byte order mark.

|            |                                |
| ---------- | ------------------------------ |
| Severity   | `error`                        |
| Category   | `loading`                      |
| Platforms  | Claude Code, Codex, Gemini CLI |
| Applies to | `skill`                        |
| Fixable    | No                             |
| Since      | 2026.10                        |

## Why

A UTF-8 byte order mark (U+FEFF) is invisible in most editors, but it is the first character of the file. Codex decodes SKILL.md without removing it and compares the trimmed first line with `---`; Rust's `trim()` keeps U+FEFF, so Codex finds no frontmatter and skips the skill. Gemini CLI matches `^---` against the raw text and skips the skill too. The skills-ref validator and the anthropics/skills packager require the file to start with `---` and reject it.

Save SKILL.md as UTF-8 without a byte order mark.

## Evidence

- [Codex source: read_file_text decodes UTF-8 without removing a byte order mark](https://github.com/openai/codex/blob/main/codex-rs/file-system/src/lib.rs), verified, checked 2026-10-14
- [Codex source: SKILL.md frontmatter parser (parser.rs)](https://github.com/openai/codex/blob/main/codex-rs/skills/src/parser.rs), verified, checked 2026-10-14
- [Unicode PropList.txt: White_Space (U+FEFF is not whitespace, so Rust trim() keeps it)](https://www.unicode.org/Public/UCD/latest/ucd/PropList.txt), verified, checked 2026-10-14
- [Gemini CLI source: skillLoader.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/skills/skillLoader.ts), verified, checked 2026-10-14
- [agentskills skills-ref reference validator](https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py), verified, checked 2026-10-14
- [anthropics/skills packager validation (quick_validate.py)](https://github.com/anthropics/skills/blob/main/skills/skill-creator/scripts/quick_validate.py), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "skill/frontmatter-bom": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line skill/frontmatter-bom -- reason -->
```
