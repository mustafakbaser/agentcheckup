<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/frontmatter-invalid`

Skill frontmatter is not valid YAML.

|            |                                                                            |
| ---------- | -------------------------------------------------------------------------- |
| Severity   | `error`                                                                    |
| Category   | `loading`                                                                  |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin Local, Cline |
| Applies to | `skill`                                                                    |
| Fixable    | No                                                                         |
| Since      | 2026.10                                                                    |

## Why

When the YAML between the `---` lines does not parse, Claude Code loads the skill with no fields set: `/name` works, but Claude cannot match requests against the description. Codex skips the skill, unless quoting values that contain `: ` or start with `[`, `{`, `@` or a backtick makes the YAML parse; it retries once that way. Codex also skips a skill that repeats `name`, `description` or `metadata`. For a skill that is installed or uploaded on its own, the skills-ref validator and the anthropics/skills packager reject the file.

Cline skips a skill whose YAML does not parse, and one that repeats any key, without a retry.

TOML (`+++`) and `---js` blocks are not frontmatter to any agent: Codex and Gemini CLI skip the skill, and Claude Code reads the block as instructions.

Quote values that contain `: ` or start with a YAML indicator such as `[`, `{`, `@` or a backtick, indent with spaces, and do not repeat keys.

## Evidence

- [Claude Code: Skills](https://code.claude.com/docs/en/skills), verified, checked 2026-10-17
- [Codex source: SKILL.md frontmatter parser (parser.rs)](https://github.com/openai/codex/blob/main/codex-rs/skills/src/parser.rs), verified, checked 2026-10-14
- [Gemini CLI source: skillLoader.ts (byte order mark removed, FRONTMATTER_REGEX)](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/skills/skillLoader.ts), verified, checked 2026-10-30
- [Cline source: user-instruction-config-loader.ts (.md, .markdown and .txt rules; root AGENTS.md)](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/config/user-instruction-config-loader.ts), verified, checked 2026-10-17
- [agentskills skills-ref reference validator](https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py), verified, checked 2026-10-14
- [anthropics/skills packager validation (quick_validate.py)](https://github.com/anthropics/skills/blob/main/skills/skill-creator/scripts/quick_validate.py), verified, checked 2026-10-14
- [StrictYAML (used by skills-ref): features removed from YAML](https://hitchdev.com/strictyaml/features-removed/), verified, checked 2026-10-14

## Fix

Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](../../fix.md#safe-review-and-manual)).

## Configuration

```json
{
  "rules": {
    "skill/frontmatter-invalid": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/frontmatter-invalid -- reason -->
```
