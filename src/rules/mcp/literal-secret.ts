import { RULESET_VERSION } from '../../core/meta.js';
import { type Artifact, type ArtifactKind, PLATFORM_IDS } from '../../core/types.js';
import { JSON_KINDS } from '../../platforms/kinds.js';
import { defineRule } from '../define.js';
import { at, collectStrings, type JsonPath, pathLabel, spanOf } from '../json/access.js';
import { formatInteger } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { findSecret } from './secrets.js';
import { MCP_SOURCES } from './sources.js';

/** Findings per file before the rule stops reporting. */
export const MAX_SECRET_FINDINGS = 20;

const ENV_NAME = /^[a-z_]\w{0,63}$/i;

function variableName(path: JsonPath, fallback: string): string {
  const last = path[path.length - 1];
  const parent = path[path.length - 2];
  return parent === 'env' && typeof last === 'string' && ENV_NAME.test(last) ? last : fallback;
}

function fix(artifact: Artifact, path: JsonPath, fallback: string): string {
  const name = variableName(path, fallback);
  const inServer = path[0] === 'mcpServers';
  if (artifact.kind === 'mcp-json' || (artifact.kind === 'claude-plugin-manifest' && inServer)) {
    return 'reference it as "${' + name + '}"';
  }
  if (artifact.kind === 'cursor-mcp') return 'reference it as "${env:' + name + '}"';
  if (artifact.kind === 'gemini-settings') return 'reference it as "$' + name + '"';
  if (artifact.kind === 'claude-plugin-manifest')
    return 'declare it in "userConfig" with "sensitive": true';
  if (artifact.kind === 'claude-settings')
    return 'set it in your shell environment instead of this file';
  return 'read it from the environment';
}

export const literalSecretRule = defineRule({
  meta: {
    id: 'mcp/literal-secret',
    title: 'Configuration file contains a literal credential',
    rationale: [
      'MCP configurations, settings and hook files are committed with the project, so a token written into one is readable by everyone who can read the repository, its forks and its history. Keys exposed in public GitHub repositories have been used within two minutes. `claude plugin validate` also warns about header values that look like literal credentials.',
      "The rule reports only tokens with a known vendor prefix and shape (GitHub, OpenAI, Anthropic, Slack, AWS access key IDs, GitLab, Stripe live keys, Google API keys, npm, Hugging Face, PyPI, DigitalOcean, Shopify, Doppler). It skips placeholders such as `ghp_xxxx…` and AWS's `…EXAMPLE` keys, and never reports variable references. The message shows only the first four characters and the length. An AWS access key ID is a warning rather than an error: without its secret access key it grants no access, but it identifies the account and the secret is often committed next to it.",
      'Revoke and rotate the credential; deleting it from the file does not remove it from git history. Then read it from the environment: `${VAR}` in `.mcp.json`, `${env:VAR}` in `.cursor/mcp.json`, `$VAR` in `.gemini/settings.json`.',
    ].join('\n\n'),
    category: 'risk',
    severity: 'error',
    appliesTo: [...JSON_KINDS] as readonly ArtifactKind[],
    platforms: PLATFORM_IDS,
    sources: [
      MCP_SOURCES.orcaHoneypot,
      SOURCES.claudePlugins,
      SOURCES.claudeMcp,
      SOURCES.cursorMcp,
      SOURCES.geminiMcp,
      MCP_SOURCES.githubTokenFormats,
      MCP_SOURCES.githubTokenBlog,
      MCP_SOURCES.githubInstallationTokens,
      MCP_SOURCES.anthropicKeys,
      MCP_SOURCES.anthropicAdminKeys,
      MCP_SOURCES.slackTokens,
      MCP_SOURCES.awsIdentifiers,
      MCP_SOURCES.gitlabTokens,
      MCP_SOURCES.stripeKeys,
      MCP_SOURCES.googleApiKeys,
      MCP_SOURCES.npmTokens,
      MCP_SOURCES.huggingFaceTokens,
      MCP_SOURCES.pypiTokens,
      MCP_SOURCES.digitalOceanTokens,
      MCP_SOURCES.shopifyTokens,
      MCP_SOURCES.dopplerTokens,
      MCP_SOURCES.gitleaksRules,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const doc = context.json(artifact);
      if (!doc.ok) continue;
      let reported = 0;
      for (const { path, value } of collectStrings(doc.value)) {
        if (reported === MAX_SECRET_FINDINGS) break;
        const secret = findSecret(value);
        if (secret === undefined) continue;
        reported++;
        const token = value.slice(secret.start, secret.start + secret.length);
        const shown = `("${token.slice(0, 4)}…", ${formatInteger(token.length)} characters)`;
        const remedy = fix(artifact, path, secret.variable);
        context.report({
          artifact,
          ...at(spanOf(doc, path)),
          // An access key ID alone grants nothing, so it is a warning and never caps the score.
          ...(secret.identifier ? { severity: 'warn' as const } : {}),
          message: secret.identifier
            ? `${pathLabel(path)} holds a literal ${secret.vendor} ${shown}. The ID alone does not grant access, but it identifies the account, and its secret key is often committed next to it. Check that the secret key is not in the repository, then ${remedy}.`
            : `${pathLabel(path)} holds a literal ${secret.vendor} ${shown} that anyone who can read this file can copy. Revoke and rotate it, then ${remedy}.`,
          platforms: artifact.readers,
        });
      }
    }
  },
});
