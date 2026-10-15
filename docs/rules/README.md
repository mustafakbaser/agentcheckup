<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# Rules

Rule set `2026.10`: 62 rules.

Severity policy: `error` means a documented platform behavior skips, ignores, truncates or
breaks the file. `warn` means degraded behavior or a portability problem. `info` is advice
and never affects the score. See [ADR 0004](../adr/0004-evidence-backed-rules.md).

| Rule                                                                        | Severity | Category    | Problem                                                               |
| --------------------------------------------------------------------------- | -------- | ----------- | --------------------------------------------------------------------- |
| [`analysis/partial`](analysis/partial.md)                                   | info     | clarity     | File was only partly analyzed                                         |
| [`copilot/apply-to`](copilot/apply-to.md)                                   | warn     | loading     | Path-specific GitHub Copilot instructions have no valid applyTo       |
| [`copilot/instructions-misplaced`](copilot/instructions-misplaced.md)       | error    | loading     | GitHub Copilot instructions file is not where Copilot looks for it    |
| [`cursor/legacy-cursorrules`](cursor/legacy-cursorrules.md)                 | info     | loading     | .cursorrules is a legacy file that Cursor plans to deprecate          |
| [`cursor/md-file-ignored`](cursor/md-file-ignored.md)                       | error    | loading     | Cursor ignores .md files in .cursor/rules                             |
| [`cursor/rule-frontmatter`](cursor/rule-frontmatter.md)                     | warn     | correctness | Cursor rule frontmatter field is unknown or has the wrong type        |
| [`cursor/rule-never-applied`](cursor/rule-never-applied.md)                 | info     | loading     | Cursor rule is applied only when @-mentioned                          |
| [`directive/missing-reason`](directive/missing-reason.md)                   | warn     | correctness | Suppression directive has no rule id or no reason                     |
| [`directive/unknown-rule`](directive/unknown-rule.md)                       | warn     | correctness | Suppression directive names a rule that does not exist                |
| [`directive/unused`](directive/unused.md)                                   | warn     | correctness | Suppression directive does not suppress anything                      |
| [`hooks/fails-open`](hooks/fails-open.md)                                   | info     | risk        | Tool-gating hook lets the tool call proceed when it fails             |
| [`hooks/script-missing`](hooks/script-missing.md)                           | error    | correctness | Hook command runs a script that does not exist                        |
| [`hooks/timeout-units`](hooks/timeout-units.md)                             | warn     | correctness | Hook timeout looks like the wrong unit                                |
| [`hooks/unknown-event`](hooks/unknown-event.md)                             | error    | loading     | Hook event name is not one the agent fires                            |
| [`instr/agents-md-ignored-by-claude`](instr/agents-md-ignored-by-claude.md) | warn     | loading     | Claude Code skips AGENTS.md because a CLAUDE.md exists                |
| [`instr/claude-md-too-long`](instr/claude-md-too-long.md)                   | info     | budget      | CLAUDE.md is longer than 200 lines                                    |
| [`instr/claude-rule-frontmatter`](instr/claude-rule-frontmatter.md)         | warn     | loading     | Claude Code rule frontmatter is invalid or ignored                    |
| [`instr/codex-size-budget`](instr/codex-size-budget.md)                     | error    | budget      | AGENTS.md files exceed the Codex size limit                           |
| [`instr/empty-file`](instr/empty-file.md)                                   | warn     | loading     | Instruction file is empty                                             |
| [`instr/encoding`](instr/encoding.md)                                       | error    | loading     | Instruction file is not UTF-8                                         |
| [`instr/filename-case`](instr/filename-case.md)                             | warn     | loading     | Instruction file name has the wrong letter case                       |
| [`instr/import-depth`](instr/import-depth.md)                               | error    | loading     | Import is nested deeper than the agent follows                        |
| [`instr/import-outside-root`](instr/import-outside-root.md)                 | warn     | portability | Import points outside the repository                                  |
| [`instr/import-unresolved`](instr/import-unresolved.md)                     | error    | correctness | Imported file does not exist                                          |
| [`instr/override-shadows-agents-md`](instr/override-shadows-agents-md.md)   | error    | loading     | AGENTS.override.md hides AGENTS.md from Codex                         |
| [`instr/subagent-invalid`](instr/subagent-invalid.md)                       | error    | loading     | Claude Code skips a subagent with invalid frontmatter                 |
| [`instr/symlink-materialized`](instr/symlink-materialized.md)               | error    | loading     | Instruction file is a symlink checked out as plain text               |
| [`instr/vague-directive`](instr/vague-directive.md)                         | info     | clarity     | Instruction is generic advice that says nothing about the project     |
| [`instr/windsurf-rule-too-long`](instr/windsurf-rule-too-long.md)           | info     | budget      | Windsurf rule file exceeds Cascade's 12,000-character limit           |
| [`json/duplicate-key`](json/duplicate-key.md)                               | warn     | correctness | JSON object repeats a key                                             |
| [`json/invalid-syntax`](json/invalid-syntax.md)                             | error    | loading     | Configuration file is not valid JSON                                  |
| [`mcp/env-syntax-mismatch`](mcp/env-syntax-mismatch.md)                     | warn     | portability | MCP configuration uses another agent's variable syntax                |
| [`mcp/gemini-server-name`](mcp/gemini-server-name.md)                       | warn     | correctness | Gemini CLI MCP server name contains an underscore                     |
| [`mcp/gemini-trust`](mcp/gemini-trust.md)                                   | warn     | risk        | Gemini CLI MCP server is trusted and skips tool confirmations         |
| [`mcp/insecure-transport`](mcp/insecure-transport.md)                       | warn     | risk        | MCP server uses an unencrypted connection to another host             |
| [`mcp/literal-secret`](mcp/literal-secret.md)                               | error    | risk        | Configuration file contains a literal credential                      |
| [`mcp/url-without-type`](mcp/url-without-type.md)                           | error    | loading     | MCP server has a "url" but no "type"                                  |
| [`risk/hidden-comment`](risk/hidden-comment.md)                             | info     | risk        | HTML comment hides instructions for the agent from human readers      |
| [`risk/hidden-unicode`](risk/hidden-unicode.md)                             | error    | risk        | File contains invisible or text-reordering Unicode characters         |
| [`risk/remote-script-execution`](risk/remote-script-execution.md)           | warn     | risk        | Command downloads a script and runs it in one step                    |
| [`settings/auto-approve-project-mcp`](settings/auto-approve-project-mcp.md) | warn     | risk        | Settings approve every project MCP server automatically               |
| [`settings/ignored-permission-mode`](settings/ignored-permission-mode.md)   | warn     | loading     | Claude Code ignores this permission mode in project settings          |
| [`settings/local-file-not-ignored`](settings/local-file-not-ignored.md)     | warn     | risk        | CLAUDE.local.md is not gitignored                                     |
| [`settings/plugin-manifest`](settings/plugin-manifest.md)                   | error    | loading     | Plugin manifest has an invalid name or component path                 |
| [`skill/body-too-long`](skill/body-too-long.md)                             | info     | budget      | Skill body is longer than recommended                                 |
| [`skill/broad-allowed-tools`](skill/broad-allowed-tools.md)                 | warn     | risk        | Skill pre-approves shell commands or file edits without limits        |
| [`skill/broken-reference`](skill/broken-reference.md)                       | error    | correctness | Skill links to a missing file or outside its directory                |
| [`skill/description-missing`](skill/description-missing.md)                 | error    | loading     | Skill description is missing or empty                                 |
| [`skill/description-quality`](skill/description-quality.md)                 | info     | clarity     | Skill description is too short or does not say when to use it         |
| [`skill/description-too-long`](skill/description-too-long.md)               | error    | budget      | Skill description exceeds the upload or Claude Code listing limit     |
| [`skill/duplicate-name`](skill/duplicate-name.md)                           | warn     | loading     | Two skills in one skills directory have the same name                 |
| [`skill/field-type`](skill/field-type.md)                                   | warn     | correctness | Skill frontmatter field has the wrong type or length                  |
| [`skill/frontmatter-bom`](skill/frontmatter-bom.md)                         | error    | loading     | Skill file starts with a byte order mark                              |
| [`skill/frontmatter-invalid`](skill/frontmatter-invalid.md)                 | error    | loading     | Skill frontmatter is not valid YAML                                   |
| [`skill/frontmatter-missing`](skill/frontmatter-missing.md)                 | error    | loading     | Skill has no YAML frontmatter on line 1                               |
| [`skill/name-dir-mismatch`](skill/name-dir-mismatch.md)                     | error    | correctness | Skill name does not match its directory name                          |
| [`skill/name-format`](skill/name-format.md)                                 | error    | correctness | Skill name does not follow the Agent Skills naming rules              |
| [`skill/name-missing`](skill/name-missing.md)                               | error    | portability | Skill name is missing or empty                                        |
| [`skill/name-reserved-word`](skill/name-reserved-word.md)                   | warn     | portability | Skill name uses a reserved word or name                               |
| [`skill/non-portable-field`](skill/non-portable-field.md)                   | warn     | portability | Skill frontmatter uses a field outside the Agent Skills specification |
| [`skill/shell-preprocessing`](skill/shell-preprocessing.md)                 | warn     | risk        | Skill runs a risky shell command before Claude reads it               |
| [`skill/yaml-portability`](skill/yaml-portability.md)                       | warn     | portability | Skill frontmatter uses YAML that parsers read differently             |
