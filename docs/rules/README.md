<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# Rules

Rule set `2026.10`: 65 rules.

Severity policy: `error` means a documented platform behavior skips, ignores, truncates or
breaks the file. `warn` means degraded behavior or a portability problem. `info` is advice
and never affects the score. See [ADR 0004](../adr/0004-evidence-backed-rules.md).

The Fix column gives the classes of fix a rule can attach for `agentcheckup fix`. `input`
means the fix needs your words, which only `agentcheckup fix -i` asks for. `manual` means
guidance only, with no automatic fix. See [Fixing findings](../fix.md#safe-review-and-manual).

| Rule                                                                        | Severity | Category    | Fix           | Problem                                                               |
| --------------------------------------------------------------------------- | -------- | ----------- | ------------- | --------------------------------------------------------------------- |
| [`analysis/partial`](analysis/partial.md)                                   | info     | clarity     | manual        | File was only partly analyzed                                         |
| [`codex/config-invalid`](codex/config-invalid.md)                           | error    | loading     | manual        | Codex project config is not valid                                     |
| [`codex/ignored-project-key`](codex/ignored-project-key.md)                 | warn     | loading     | manual        | Codex ignores this key in a project config file                       |
| [`copilot/apply-to`](copilot/apply-to.md)                                   | warn     | loading     | safe          | Path-specific GitHub Copilot instructions have no valid applyTo       |
| [`copilot/instructions-misplaced`](copilot/instructions-misplaced.md)       | error    | loading     | review        | GitHub Copilot instructions file is not where Copilot looks for it    |
| [`cursor/legacy-cursorrules`](cursor/legacy-cursorrules.md)                 | info     | loading     | review        | .cursorrules is a legacy file that Cursor plans to deprecate          |
| [`cursor/md-file-ignored`](cursor/md-file-ignored.md)                       | error    | loading     | safe, review  | Cursor ignores .md files in .cursor/rules                             |
| [`cursor/rule-frontmatter`](cursor/rule-frontmatter.md)                     | warn     | correctness | safe, review  | Cursor rule frontmatter field is unknown or has the wrong type        |
| [`cursor/rule-never-applied`](cursor/rule-never-applied.md)                 | info     | loading     | input         | Cursor rule is applied only when @-mentioned                          |
| [`directive/missing-reason`](directive/missing-reason.md)                   | warn     | correctness | manual        | Suppression directive has no rule id or no reason                     |
| [`directive/unknown-rule`](directive/unknown-rule.md)                       | warn     | correctness | review        | Suppression directive names a rule that does not exist                |
| [`directive/unused`](directive/unused.md)                                   | warn     | correctness | safe          | Suppression directive does not suppress anything                      |
| [`gemini/settings-key-ignored`](gemini/settings-key-ignored.md)             | warn     | loading     | manual        | Gemini CLI ignores a top-level key from its old settings format       |
| [`hooks/fails-open`](hooks/fails-open.md)                                   | info     | risk        | review        | Tool-gating hook lets the tool call proceed when it fails             |
| [`hooks/script-missing`](hooks/script-missing.md)                           | error    | correctness | manual        | Hook command runs a script that does not exist                        |
| [`hooks/timeout-units`](hooks/timeout-units.md)                             | warn     | correctness | review        | Hook timeout looks like the wrong unit                                |
| [`hooks/unknown-event`](hooks/unknown-event.md)                             | error    | loading     | review        | Hook event name is not one the agent fires                            |
| [`instr/agents-md-ignored-by-claude`](instr/agents-md-ignored-by-claude.md) | warn     | loading     | safe, review  | Claude Code skips AGENTS.md because a CLAUDE.md exists                |
| [`instr/claude-md-too-long`](instr/claude-md-too-long.md)                   | info     | budget      | manual        | CLAUDE.md is longer than 200 lines                                    |
| [`instr/claude-rule-frontmatter`](instr/claude-rule-frontmatter.md)         | warn     | loading     | review        | Claude Code rule frontmatter is invalid or ignored                    |
| [`instr/codex-size-budget`](instr/codex-size-budget.md)                     | error    | budget      | manual        | AGENTS.md files exceed the Codex size limit                           |
| [`instr/empty-file`](instr/empty-file.md)                                   | warn     | loading     | manual        | Instruction file is empty                                             |
| [`instr/encoding`](instr/encoding.md)                                       | error    | loading     | safe          | Instruction file is not UTF-8                                         |
| [`instr/filename-case`](instr/filename-case.md)                             | warn     | loading     | manual        | Instruction file name has the wrong letter case                       |
| [`instr/import-depth`](instr/import-depth.md)                               | error    | loading     | manual        | Import is nested deeper than the agent follows                        |
| [`instr/import-outside-root`](instr/import-outside-root.md)                 | warn     | portability | manual        | Import points outside the repository                                  |
| [`instr/import-unresolved`](instr/import-unresolved.md)                     | error    | correctness | review        | Imported file does not exist                                          |
| [`instr/override-shadows-agents-md`](instr/override-shadows-agents-md.md)   | error    | loading     | manual        | AGENTS.override.md hides AGENTS.md from Codex                         |
| [`instr/subagent-invalid`](instr/subagent-invalid.md)                       | error    | loading     | safe          | Claude Code skips a subagent with invalid frontmatter                 |
| [`instr/symlink-materialized`](instr/symlink-materialized.md)               | error    | loading     | review        | Instruction file is a symlink checked out as plain text               |
| [`instr/vague-directive`](instr/vague-directive.md)                         | info     | clarity     | manual        | Instruction is generic advice that says nothing about the project     |
| [`instr/windsurf-rule-too-long`](instr/windsurf-rule-too-long.md)           | info     | budget      | manual        | Devin Desktop rule file exceeds Cascade's 12,000-character limit      |
| [`json/duplicate-key`](json/duplicate-key.md)                               | warn     | correctness | safe          | JSON object repeats a key                                             |
| [`json/invalid-syntax`](json/invalid-syntax.md)                             | error    | loading     | review        | Configuration file is not valid JSON                                  |
| [`mcp/env-syntax-mismatch`](mcp/env-syntax-mismatch.md)                     | warn     | portability | review        | MCP configuration uses another agent's variable syntax                |
| [`mcp/gemini-server-name`](mcp/gemini-server-name.md)                       | warn     | correctness | review        | Gemini CLI MCP server name contains an underscore                     |
| [`mcp/gemini-trust`](mcp/gemini-trust.md)                                   | warn     | risk        | review        | Gemini CLI MCP server is trusted and skips tool confirmations         |
| [`mcp/insecure-transport`](mcp/insecure-transport.md)                       | warn     | risk        | review        | MCP server uses an unencrypted connection to another host             |
| [`mcp/literal-secret`](mcp/literal-secret.md)                               | error    | risk        | review        | Configuration file contains a literal credential                      |
| [`mcp/url-without-type`](mcp/url-without-type.md)                           | error    | loading     | review        | MCP server has a "url" but no "type"                                  |
| [`risk/hidden-comment`](risk/hidden-comment.md)                             | info     | risk        | manual        | HTML comment hides instructions for the agent from human readers      |
| [`risk/hidden-unicode`](risk/hidden-unicode.md)                             | error    | risk        | review        | File contains invisible or text-reordering Unicode characters         |
| [`risk/remote-script-execution`](risk/remote-script-execution.md)           | warn     | risk        | manual        | Command downloads a script and runs it in one step                    |
| [`settings/auto-approve-project-mcp`](settings/auto-approve-project-mcp.md) | warn     | risk        | review        | Settings approve every project MCP server automatically               |
| [`settings/ignored-permission-mode`](settings/ignored-permission-mode.md)   | warn     | loading     | review        | Claude Code ignores this permission mode in project settings          |
| [`settings/local-file-not-ignored`](settings/local-file-not-ignored.md)     | warn     | risk        | manual        | CLAUDE.local.md is not gitignored                                     |
| [`settings/plugin-manifest`](settings/plugin-manifest.md)                   | error    | loading     | safe, review  | Plugin manifest has an invalid name or component path                 |
| [`skill/body-too-long`](skill/body-too-long.md)                             | info     | budget      | review        | Skill body is longer than recommended                                 |
| [`skill/broad-allowed-tools`](skill/broad-allowed-tools.md)                 | warn     | risk        | review        | Skill pre-approves shell commands or file edits without limits        |
| [`skill/broken-reference`](skill/broken-reference.md)                       | error    | correctness | safe, review  | Skill links to a missing file or outside its directory                |
| [`skill/description-missing`](skill/description-missing.md)                 | error    | loading     | review, input | Skill description is missing or empty                                 |
| [`skill/description-quality`](skill/description-quality.md)                 | info     | clarity     | input         | Skill description is too short or does not say when to use it         |
| [`skill/description-too-long`](skill/description-too-long.md)               | error    | budget      | manual        | Skill description exceeds the upload or Claude Code listing limit     |
| [`skill/duplicate-name`](skill/duplicate-name.md)                           | warn     | loading     | manual        | Two skills that an agent reads together have the same name            |
| [`skill/field-type`](skill/field-type.md)                                   | warn     | correctness | review        | Skill frontmatter field has the wrong type or length                  |
| [`skill/frontmatter-bom`](skill/frontmatter-bom.md)                         | error    | loading     | safe          | Skill file starts with a byte order mark                              |
| [`skill/frontmatter-invalid`](skill/frontmatter-invalid.md)                 | error    | loading     | manual        | Skill frontmatter is not valid YAML                                   |
| [`skill/frontmatter-missing`](skill/frontmatter-missing.md)                 | error    | loading     | safe, review  | Skill has no YAML frontmatter on line 1                               |
| [`skill/name-dir-mismatch`](skill/name-dir-mismatch.md)                     | error    | correctness | safe, review  | Skill name does not match its directory name                          |
| [`skill/name-format`](skill/name-format.md)                                 | error    | correctness | safe, review  | Skill name does not follow the Agent Skills naming rules              |
| [`skill/name-missing`](skill/name-missing.md)                               | error    | portability | safe          | Skill name is missing or empty                                        |
| [`skill/name-reserved-word`](skill/name-reserved-word.md)                   | warn     | portability | manual        | Skill name uses a reserved word or name                               |
| [`skill/non-portable-field`](skill/non-portable-field.md)                   | warn     | portability | review, input | Skill frontmatter uses a field outside the Agent Skills specification |
| [`skill/shell-preprocessing`](skill/shell-preprocessing.md)                 | warn     | risk        | manual        | Skill runs a risky shell command before Claude reads it               |
| [`skill/yaml-portability`](skill/yaml-portability.md)                       | warn     | portability | review        | Skill frontmatter uses YAML that parsers read differently             |
