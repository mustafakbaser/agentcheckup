<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `mcp/literal-secret`

Configuration file contains a literal credential.

|            |                                                                                                                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity   | `error`                                                                                                                                                                                                                                               |
| Category   | `risk`                                                                                                                                                                                                                                                |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin Local, Cline                                                                                                                                                                            |
| Applies to | `claude-settings`, `claude-plugin-manifest`, `cursor-hooks`, `cursor-mcp`, `gemini-settings`, `mcp-json`, `codex-hooks`, `copilot-hooks`, `copilot-mcp`, `copilot-settings`, `vscode-mcp`, `devin-config`, `devin-mcp`, `devin-hooks`, `codex-config` |
| Fixable    | Yes, `review`                                                                                                                                                                                                                                         |
| Since      | 2026.10                                                                                                                                                                                                                                               |

## Why

MCP configurations, settings and hook files are committed with the project, so a token written into one is readable by everyone who can read the repository, its forks and its history. Keys exposed in public GitHub repositories have been used within two minutes. `claude plugin validate` also warns about header values that look like literal credentials.

The rule reports only tokens with a known vendor prefix and shape (GitHub, OpenAI, Anthropic, Slack, AWS access key IDs, GitLab, Stripe live keys, Google API keys, npm, Hugging Face, PyPI, DigitalOcean, Shopify, Doppler). Slack's rotating app-level tokens (`xoxe.xapp-`) and workflow tokens (`xwfp-`) count, and a Claude Enterprise admin key, which starts with `sk-ant-api01-` like an API key, is reported as an Anthropic API key: the prefix cannot tell them apart. It skips placeholders such as `ghp_xxxx…` and AWS's `…EXAMPLE` keys, and never reports variable references. The message shows only the first four characters and the length. An AWS access key ID is a warning rather than an error: without its secret access key it grants no access, but it identifies the account and the secret is often committed next to it.

Revoke and rotate the credential; deleting it from the file does not remove it from git history. Then read it from the environment: `${VAR}` in `.mcp.json`, `${env:VAR}` in `.cursor/mcp.json`, `$VAR` in `.gemini/settings.json`. Codex's `.codex/config.toml` expands no variables: forward one with `env_vars`, or name it in `env_http_headers` or `bearer_token_env_var`; the rule offers no fix there.

## Evidence

- [Orca Security: 2023 Honeypotting in the Cloud Report (exposed keys used within two minutes)](https://orca.security/resources/press-releases/orca-security-2023-honeypotting-in-the-cloud-report/), verified, checked 2026-10-14
- [Claude Code: Plugins reference](https://code.claude.com/docs/en/plugins-reference), verified, checked 2026-10-14
- [Claude Code: MCP](https://code.claude.com/docs/en/mcp), verified, checked 2026-10-14
- [Cursor: MCP](https://cursor.com/docs/mcp), verified, checked 2026-10-14
- [Gemini CLI: MCP servers](https://geminicli.com/docs/tools/mcp-server/), verified, checked 2026-10-14
- [Codex: MCP](https://learn.chatgpt.com/docs/extend/mcp), verified, checked 2026-10-30
- [GitHub: About authentication to GitHub (token prefixes)](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github), verified, checked 2026-10-30
- [GitHub blog: Behind GitHub's new authentication token formats](https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/), verified, checked 2026-10-14
- [GitHub changelog: new format for GitHub App installation tokens](https://github.blog/changelog/2026-04-24-notice-about-upcoming-new-format-for-github-app-installation-tokens/), verified, checked 2026-10-14
- [Claude API: Get an API key (sk-ant- prefix)](https://platform.claude.com/docs/en/get-api-key), verified, checked 2026-10-30
- [Claude API: Admin API keys (sk-ant-admin01- for Claude Console; Claude Enterprise keys start with sk-ant-api01-, like API keys)](https://platform.claude.com/docs/en/manage-claude/admin-api-keys), verified, checked 2026-10-30
- [Slack: Tokens (xoxb-, xoxp-, xapp-, rotating xoxe.xapp-, workflow xwfp-)](https://docs.slack.dev/authentication/tokens), verified, checked 2026-10-30
- [AWS IAM: Unique identifier prefixes (AKIA, ASIA)](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html), verified, checked 2026-10-14
- [GitLab: Token prefixes](https://docs.gitlab.com/security/tokens/), verified, checked 2026-10-14
- [Stripe: API keys](https://docs.stripe.com/keys), verified, checked 2026-10-14
- [Google Cloud: API keys](https://docs.cloud.google.com/docs/authentication/api-keys), verified, checked 2026-10-30
- [GitHub blog: npm's new access token format](https://github.blog/2021-09-23-announcing-npms-new-access-token-format/), verified, checked 2026-10-14
- [Hugging Face: User access tokens](https://huggingface.co/docs/hub/security-tokens), verified, checked 2026-10-14
- [PyPI: Secret reporting API (an API token is pypi- and a base64-serialized macaroon)](https://docs.pypi.org/api/secrets/), verified, checked 2026-10-30
- [DigitalOcean: API token format](https://docs.digitalocean.com/notes/2022/api-token-format), verified, checked 2026-10-14
- [Shopify: Access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens), verified, checked 2026-10-30
- [Doppler: Auth token formats](https://docs.doppler.com/reference/auth-token-formats), verified, checked 2026-10-14
- [gitleaks default rules (token lengths that vendors do not document)](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml), unverified, checked 2026-10-14

## Fix

Classes: `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Replaces only the token with a variable reference in the syntax of the agent that reads the file: "${NAME}" in .mcp.json and plugin servers, "${env:NAME}" in .cursor/mcp.json, "$NAME" in .gemini/settings.json. Applied only when you name the rule or accept the fix, always with a warning to rotate the credential.

Preview the fix with `agentcheckup fix --rule mcp/literal-secret`.

## Configuration

```json
{
  "rules": {
    "mcp/literal-secret": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line mcp/literal-secret -- reason -->
```
