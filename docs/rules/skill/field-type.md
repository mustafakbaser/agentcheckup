<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/field-type`

Skill frontmatter field has the wrong type or length.

|            |                    |
| ---------- | ------------------ |
| Severity   | `warn`             |
| Category   | `correctness`      |
| Platforms  | Claude Code, Codex |
| Applies to | `skill`            |
| Fixable    | No                 |
| Since      | 2026.10            |

## Why

The Agent Skills specification gives each optional field a type: `metadata` maps string keys to string values, `compatibility` is text of up to 500 characters, `allowed-tools` is a space-separated string, and `license` is text. Codex cannot read frontmatter whose `metadata` is text, a number or a boolean, and skips the skill. The skills-ref validator and the anthropics/skills packager reject a `compatibility` that is not text or is longer than 500 characters. Claude Code also accepts a YAML list for `allowed-tools`, but the specification defines a space-separated string.

Use the types from the specification, and quote values that YAML would read as numbers or booleans.

## Evidence

- [Agent Skills specification](https://agentskills.io/specification), verified, checked 2026-10-14
- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-14
- [Codex source: SKILL.md frontmatter parser (parser.rs)](https://github.com/openai/codex/blob/main/codex-rs/skills/src/parser.rs), verified, checked 2026-10-14
- [agentskills skills-ref reference validator](https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py), verified, checked 2026-10-14
- [anthropics/skills packager validation (quick_validate.py)](https://github.com/anthropics/skills/blob/main/skills/skill-creator/scripts/quick_validate.py), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "skill/field-type": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/field-type -- reason -->
```
