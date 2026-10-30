import type { RuleSource } from '../../core/types.js';

/** Evidence used only by the mcp family. Checked 2026-10-14. */
const CHECKED = '2026-10-14';

/** Sources re-read in the source audit of 2026-10-30. */
const AUDIT_CHECKED = '2026-10-30';

const verified = (title: string, url: string, checked = CHECKED): RuleSource => ({
  title,
  url,
  checked,
  status: 'verified',
});

export const MCP_SOURCES = {
  geminiConfiguration: verified(
    'Gemini CLI: Configuration (environment variables in settings)',
    'https://geminicli.com/docs/reference/configuration/',
    AUDIT_CHECKED,
  ),
  geminiEnvResolver: verified(
    'Gemini CLI source: envVarResolver.ts',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/utils/envVarResolver.ts',
  ),
  geminiPolicyEngine: verified(
    'Gemini CLI: Policy engine (MCP server names and underscores)',
    'https://geminicli.com/docs/reference/policy-engine/',
  ),
  geminiMcpToolName: verified(
    'Gemini CLI source: mcp-tool.ts (FQN parsing)',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/mcp-tool.ts',
  ),
  githubTokenFormats: verified(
    'GitHub: About authentication to GitHub (token prefixes)',
    'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github',
    AUDIT_CHECKED,
  ),
  githubTokenBlog: verified(
    "GitHub blog: Behind GitHub's new authentication token formats",
    'https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/',
  ),
  githubInstallationTokens: verified(
    'GitHub changelog: new format for GitHub App installation tokens',
    'https://github.blog/changelog/2026-04-24-notice-about-upcoming-new-format-for-github-app-installation-tokens/',
  ),
  anthropicKeys: verified(
    'Claude API: Get an API key (sk-ant- prefix)',
    'https://platform.claude.com/docs/en/get-api-key',
    AUDIT_CHECKED,
  ),
  anthropicAdminKeys: verified(
    'Claude API: Admin API keys (sk-ant-admin01- for Claude Console; Claude Enterprise keys start with sk-ant-api01-, like API keys)',
    'https://platform.claude.com/docs/en/manage-claude/admin-api-keys',
    AUDIT_CHECKED,
  ),
  slackTokens: verified(
    'Slack: Tokens (xoxb-, xoxp-, xapp-, rotating xoxe.xapp-, workflow xwfp-)',
    'https://docs.slack.dev/authentication/tokens',
    AUDIT_CHECKED,
  ),
  awsIdentifiers: verified(
    'AWS IAM: Unique identifier prefixes (AKIA, ASIA)',
    'https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html',
  ),
  gitlabTokens: verified('GitLab: Token prefixes', 'https://docs.gitlab.com/security/tokens/'),
  stripeKeys: verified('Stripe: API keys', 'https://docs.stripe.com/keys'),
  googleApiKeys: verified(
    'Google Cloud: API keys',
    'https://docs.cloud.google.com/docs/authentication/api-keys',
    AUDIT_CHECKED,
  ),
  npmTokens: verified(
    "GitHub blog: npm's new access token format",
    'https://github.blog/2021-09-23-announcing-npms-new-access-token-format/',
  ),
  huggingFaceTokens: verified(
    'Hugging Face: User access tokens',
    'https://huggingface.co/docs/hub/security-tokens',
  ),
  pypiTokens: verified(
    'PyPI: Secret reporting API (an API token is pypi- and a base64-serialized macaroon)',
    'https://docs.pypi.org/api/secrets/',
    AUDIT_CHECKED,
  ),
  digitalOceanTokens: verified(
    'DigitalOcean: API token format',
    'https://docs.digitalocean.com/notes/2022/api-token-format',
  ),
  shopifyTokens: verified(
    'Shopify: Access tokens',
    'https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens',
    AUDIT_CHECKED,
  ),
  dopplerTokens: verified(
    'Doppler: Auth token formats',
    'https://docs.doppler.com/reference/auth-token-formats',
  ),
  orcaHoneypot: verified(
    'Orca Security: 2023 Honeypotting in the Cloud Report (exposed keys used within two minutes)',
    'https://orca.security/resources/press-releases/orca-security-2023-honeypotting-in-the-cloud-report/',
  ),
  gitleaksRules: {
    title: 'gitleaks default rules (token lengths that vendors do not document)',
    url: 'https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml',
    checked: CHECKED,
    status: 'unverified',
  },
} as const satisfies Record<string, RuleSource>;
