<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/description-missing`

Skill description is missing or empty.

|            |                                                        |
| ---------- | ------------------------------------------------------ |
| Severity   | `error`                                                |
| Category   | `loading`                                              |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI |
| Applies to | `skill`                                                |
| Fixable    | No                                                     |
| Since      | 2026.10                                                |

## Why

Agents decide when to use a skill by matching the request against its `description`. Codex skips a skill whose description is missing or empty, and Gemini CLI skips one without the key. When the key is omitted, Claude Code uses the first non-empty line of the body instead, so a heading such as `# Deploy` becomes the text Claude matches requests against; its documentation does not cover an empty value. The Agent Skills specification, Cursor, GitHub Copilot and the Claude API require the field.

Add a `description` that says what the skill does and when to use it.

## Evidence

- [Codex source: SKILL.md frontmatter parser (parser.rs)](https://github.com/openai/codex/blob/main/codex-rs/skills/src/parser.rs), verified, checked 2026-10-14
- [Gemini CLI source: skillLoader.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/skills/skillLoader.ts), verified, checked 2026-10-14
- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-14
- [Agent Skills specification](https://agentskills.io/specification), verified, checked 2026-10-14
- [agentskills skills-ref reference validator](https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py), verified, checked 2026-10-14
- [Cursor: Skills](https://cursor.com/docs/skills), verified, checked 2026-10-14
- [GitHub Copilot: Add skills](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills), verified, checked 2026-10-14
- [Claude API: Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "skill/description-missing": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/description-missing -- reason -->
```
