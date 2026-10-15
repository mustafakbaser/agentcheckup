<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `skill/yaml-portability`

Skill frontmatter uses YAML that parsers read differently.

|            |                                                        |
| ---------- | ------------------------------------------------------ |
| Severity   | `warn`                                                 |
| Category   | `portability`                                          |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI |
| Applies to | `skill`                                                |
| Fixable    | No                                                     |
| Since      | 2026.10                                                |

## Why

Agents and validators parse SKILL.md frontmatter with different YAML libraries: Codex uses serde_yaml, Gemini CLI js-yaml, the skills-ref validator strictyaml, and the anthropics/skills packager PyYAML, a YAML 1.1 parser. YAML 1.1 reads unquoted `yes`, `no`, `on` and `off` as booleans; YAML 1.2 reads them as text. YAML 1.2 parsers read `1.0` as the number 1, while strictyaml keeps the text. strictyaml rejects anchors, aliases and explicit tags, and reads an empty value as text where other parsers read null. These findings are reported only for skills that are installed or uploaded on their own.

Quote values that must stay text, write booleans as `true` or `false`, avoid anchors, aliases and tags, and remove keys that have no value.

## Evidence

- [StrictYAML (used by skills-ref): features removed from YAML](https://hitchdev.com/strictyaml/features-removed/), verified, checked 2026-10-14
- [YAML 1.1: Boolean type](https://yaml.org/type/bool.html), verified, checked 2026-10-14
- [anthropics/skills packager validation (quick_validate.py)](https://github.com/anthropics/skills/blob/main/skills/skill-creator/scripts/quick_validate.py), verified, checked 2026-10-14
- [agentskills skills-ref reference validator](https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py), verified, checked 2026-10-14
- [Gemini CLI source: skillLoader.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/skills/skillLoader.ts), verified, checked 2026-10-14
- [Codex source: SKILL.md frontmatter parser (parser.rs)](https://github.com/openai/codex/blob/main/codex-rs/skills/src/parser.rs), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "skill/yaml-portability": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line skill/yaml-portability -- reason -->
```
