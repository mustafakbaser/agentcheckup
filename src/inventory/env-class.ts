/**
 * What an environment override does, for the security inventory. Every name below is taken from
 * the cited documentation (checked 2026-10-15); a name that is not listed and does not look like a
 * credential is `other`.
 *
 * - Claude Code environment variables: https://code.claude.com/docs/en/env-vars
 * - Claude Code network configuration (proxies, CA certificates, mTLS):
 *   https://code.claude.com/docs/en/network-config
 * - Claude Code settings that run a command, and the OpenTelemetry exporter variables:
 *   https://code.claude.com/docs/en/settings-reference
 * - Node.js environment variables: https://nodejs.org/api/cli.html
 * - The dynamic loader's variables: https://man7.org/linux/man-pages/man8/ld.so.8.html
 */
import type { RuleSource } from '../core/types.js';
import { SOURCES } from '../platforms/sources.js';
import { findSecret } from '../rules/mcp/secrets.js';
import type { EnvItem } from './types.js';

export type EnvClass = EnvItem['class'];

const ENDPOINT: readonly string[] = [
  // Claude Code env-vars: "Override the API endpoint …" and the provider base URLs.
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  // "OTLP/HTTP endpoint for detailed beta tracing … logs and traces go there".
  'BETA_TRACING_ENDPOINT',
  // "Override the host address used to connect to the IDE extension."
  'CLAUDE_CODE_IDE_HOST_OVERRIDE',
  // Network configuration: proxies, including the lowercase https_proxy and http_proxy.
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'NO_PROXY',
];

const CREDENTIAL: readonly string[] = [
  // Claude Code env-vars: API keys, bearer tokens, custom headers, OAuth tokens and secrets.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_AWS_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'MCP_CLIENT_SECRET',
  // Named in the subprocess environment scrub table as a credential the scrub removes.
  'AWS_SECRET_ACCESS_KEY',
];

const TLS: readonly string[] = [
  // Node.js: "If value equals '0', certificate validation is disabled for TLS connections."
  'NODE_TLS_REJECT_UNAUTHORIZED',
  // Node.js and network configuration: extra trusted root certificates.
  'NODE_EXTRA_CA_CERTS',
  // Network configuration: the mTLS client certificate and key, and the CA certificate sources.
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CERT_STORE',
];

const CODE_EXEC: readonly string[] = [
  // Node.js: options read before the command line; `--require` and `--import` are allowed.
  'NODE_OPTIONS',
  // Node.js: "directories prefixed to the module search path".
  'NODE_PATH',
  // ld.so: shared objects "loaded before all others", and the library search path.
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  // Claude Code env-vars: the shell for Bash tool commands, a prefix that wraps every command,
  // hook and stdio MCP server start, a script run before each Bash command, the launcher for the
  // processes Claude Code starts, Git Bash's path, and plugin directories to load.
  'CLAUDE_CODE_SHELL',
  'CLAUDE_CODE_SHELL_PREFIX',
  'CLAUDE_ENV_FILE',
  'CLAUDE_CODE_PROCESS_WRAPPER',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_PLUGIN_DIRS',
  'CLAUDE_CODE_PLUGIN_SEED_DIR',
];

const BY_NAME: ReadonlyMap<string, EnvClass> = new Map([
  ...ENDPOINT.map((name) => [name, 'endpoint'] as const),
  ...CREDENTIAL.map((name) => [name, 'credential'] as const),
  ...TLS.map((name) => [name, 'tls'] as const),
  ...CODE_EXEC.map((name) => [name, 'code-exec'] as const),
]);

/**
 * Claude Code settings keys that run a command: the five credential and header helpers take a
 * command line, `statusLine` and `fileSuggestion` an object with a `command`.
 */
export const COMMAND_SETTINGS: readonly string[] = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'statusLine',
  'fileSuggestion',
];

/** Evidence for the classes above. */
export const ENV_CLASS_SOURCES: readonly RuleSource[] = [
  SOURCES.claudeEnvVars,
  SOURCES.claudeNetworkConfig,
  SOURCES.claudeSettingsReference,
  SOURCES.nodeCliEnv,
  SOURCES.ldSo,
];

const OTLP_PREFIX = 'OTEL_EXPORTER_OTLP_';

/**
 * The OpenTelemetry exporter variables the settings reference names by suffix, in the generic
 * and per-signal forms: `_ENDPOINT` chooses where telemetry goes, `_HEADERS` carries the
 * collector's credentials, `_CERTIFICATE`, `_CLIENT_KEY` and `_INSECURE` change TLS.
 */
function otlpClass(name: string): EnvClass | undefined {
  if (!name.startsWith(OTLP_PREFIX)) return undefined;
  if (name.endsWith('_ENDPOINT')) return 'endpoint';
  if (name.endsWith('_HEADERS')) return 'credential';
  if (name.endsWith('_CERTIFICATE') || name.endsWith('_CLIENT_KEY') || name.endsWith('_INSECURE'))
    return 'tls';
  return undefined;
}

const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'CREDENTIAL',
  'CREDENTIALS',
  'APIKEY',
  'PAT',
]);

/**
 * A name that looks like a credential. Claude Code's subprocess scrub removes variables "because
 * the name looks like a credential", with `NPM_TOKEN` and `DB_PASSWORD` as its examples; this
 * reads the same shape: a `_`-separated word such as TOKEN, SECRET or PASSWORD, or a name that
 * ends in `_KEY` (`OPENAI_API_KEY`, `STRIPE_SECRET_KEY`).
 */
export function looksLikeCredentialName(name: string): boolean {
  const words = name.toUpperCase().split(/[_-]/);
  if (words.some((word) => CREDENTIAL_WORDS.has(word))) return true;
  return words.length > 1 && words[words.length - 1] === 'KEY';
}

/**
 * A value that looks like a credential: a URL with a password (the scrub table's
 * `DATABASE_URL` example) or a token with a known vendor prefix.
 */
function looksLikeCredentialValue(value: string): boolean {
  const text = value.trim();
  if (text.includes('://') && URL.canParse(text) && new URL(text).password !== '') return true;
  return findSecret(text) !== undefined;
}

/**
 * The class of an environment variable. Names are case-sensitive, as on Linux and macOS; only
 * the lowercase proxy variables that Claude Code documents are listed in lowercase.
 */
export function envClass(name: string, value: string | undefined): EnvClass {
  const known = otlpClass(name) ?? BY_NAME.get(name);
  if (known !== undefined) return known;
  if (looksLikeCredentialName(name)) return 'credential';
  if (value !== undefined && looksLikeCredentialValue(value)) return 'credential';
  return 'other';
}
