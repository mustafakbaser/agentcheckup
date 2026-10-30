<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `mcp/env-syntax-mismatch`

MCP configuration uses another agent's variable syntax.

|            |                                                                         |
| ---------- | ----------------------------------------------------------------------- |
| Severity   | `warn`                                                                  |
| Category   | `portability`                                                           |
| Platforms  | Claude Code, Gemini CLI, Codex                                          |
| Applies to | `mcp-json`, `claude-plugin-manifest`, `gemini-settings`, `codex-config` |
| Fixable    | Yes, `review`                                                           |
| Since      | 2026.10                                                                 |

## Why

Each agent expands environment variables in MCP configuration with its own syntax. Claude Code expands `${VAR}` and `${VAR:-default}` in the `command`, `args`, `env`, `url` and `headers` of `.mcp.json` servers. Cursor uses `${env:VAR}` and built-ins such as `${workspaceFolder}`. Gemini CLI expands `$VAR`, `${VAR}` and `${VAR:-default}` in every string of `settings.json`. A reference in another agent's syntax is not an error: the server starts without the value, so authentication fails or a path does not exist.

In `.mcp.json` the rule also reports `$VAR` and `%VAR%` in `env`, `url` and `headers`, where no shell expands them.

Codex expands no references in `.codex/config.toml`: it passes `${VAR}` on as text. It takes values from the environment by name instead, through `env_vars`, `env_http_headers` and `bearer_token_env_var`. Since a literal `${VAR}` can be intended, Codex findings are `info`.

Rewrite the reference in the syntax of the agent that reads the file.

## Evidence

- [Claude Code: MCP](https://code.claude.com/docs/en/mcp), verified, checked 2026-10-14
- [Claude Code: Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference), verified, checked 2026-10-30
- [Cursor: MCP](https://cursor.com/docs/mcp), verified, checked 2026-10-14
- [Gemini CLI: MCP servers](https://geminicli.com/docs/tools/mcp-server/), verified, checked 2026-10-14
- [Codex: MCP](https://learn.chatgpt.com/docs/extend/mcp), verified, checked 2026-10-30
- [Gemini CLI: Configuration (environment variables in settings)](https://geminicli.com/docs/reference/configuration/), verified, checked 2026-10-30
- [Gemini CLI source: envVarResolver.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/utils/envVarResolver.ts), verified, checked 2026-10-14

## Fix

Classes: `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Rewrites every reference in the string in the syntax of the agent that reads the file: "${NAME}" for Claude Code, "$NAME" for Gemini CLI. Not offered for Cursor built-ins such as "${workspaceFolder}", which the other agents do not have, or for a file that other paths link to.

Preview the fix with `agentcheckup fix --rule mcp/env-syntax-mismatch`.

## Configuration

```json
{
  "rules": {
    "mcp/env-syntax-mismatch": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line mcp/env-syntax-mismatch -- reason -->
```
