/**
 * What an environment override does, for the security inventory, and whether Claude Code drops
 * it from repository settings. Every name below is taken from the cited documentation (checked
 * 2026-10-15, the Claude Code pages again 2026-10-30); a name that is not listed and does not look
 * like a credential is `other`.
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
 * command line, `statusLine`, `subagentStatusLine` and `fileSuggestion` an object with a
 * `command` (SOURCES.claudeSettingsReference: `subagentStatusLine` "lets you run your own command
 * to rewrite those rows", in any file).
 */
export const COMMAND_SETTINGS: readonly string[] = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'statusLine',
  'subagentStatusLine',
  'fileSuggestion',
];

/**
 * Variables Claude Code drops from the `env` of project and local settings, "variables that a
 * checked-out repository shouldn't control" (SOURCES.claudeSettingsReference, "Variables Claude
 * Code ignores in `env`", since v2.1.282 for the OpenTelemetry group; SOURCES.claudeEnvVars), and
 * the ones it ignores from every file. The reference lists them as "They include", so names it
 * does not give are not here.
 */
const DROPPED_FROM_REPOSITORY: ReadonlySet<string> = new Set([
  // Where Claude Code stores or writes its own files.
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_TMPDIR',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  // Windows programs and machine-wide configuration.
  'SystemRoot',
  'ComSpec',
  'ProgramData',
  'LOCALAPPDATA',
  'PATHEXT',
  'PSModulePath',
  // Session content.
  'OTEL_LOG_RAW_API_BODIES',
  'ENABLE_BETA_TRACING_DETAILED',
  'BETA_TRACING_ENDPOINT',
  // The OpenTelemetry exporter.
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
  'ENABLE_ENHANCED_TELEMETRY_BETA',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_ASSISTANT_RESPONSES',
  'OTEL_LOG_TOOL_CONTENT',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_EXPORTER_PROMETHEUS_HOST',
  'OTEL_EXPORTER_PROMETHEUS_PORT',
  // How Claude Code starts or syncs.
  'CLAUDE_CODE_PROCESS_WRAPPER',
  'CLAUDE_CODE_SYNC_SKILLS',
  'CLAUDE_CODE_SYNC_PLUGINS',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
  'CLAUDE_CODE_PLUGIN_SEED_DIR',
  // Dialogs and input.
  'CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS',
  'CLAUDE_CODE_DISABLE_ATTACHMENTS',
  'CLAUDE_CODE_DISABLE_FILE_MENTIONS',
  // Ignored from every file.
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_ACCOUNT_UUID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_PROJECT_DIR_NAME',
  'CLAUDE_CODE_RESTRICTED',
]);

/** Name prefixes of the families the reference drops: `XDG_*`, `ProgramFiles*`, `CLAUDE_AX_*`. */
const DROPPED_PREFIXES: readonly string[] = ['XDG_', 'ProgramFiles', 'CLAUDE_AX_'];

/** The `OTEL_EXPORTER_OTLP_*` endings the reference drops, generic and per signal. */
const DROPPED_OTLP_SUFFIXES: readonly string[] = [
  '_ENDPOINT',
  '_HEADERS',
  '_PROTOCOL',
  '_CERTIFICATE',
  '_CLIENT_KEY',
  '_INSECURE',
];

/** The exporter selectors, which still apply from the repository when they turn telemetry off. */
const EXPORTER_SELECTORS: ReadonlySet<string> = new Set([
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
]);

/** Content switches that still apply from the repository when they are off. */
const CONTENT_SWITCHES: ReadonlySet<string> = new Set([
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_TOOL_CONTENT',
  'OTEL_LOG_TOOL_DETAILS',
]);

const OFF_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);

/**
 * True when Claude Code drops `name` from the `env` of project and local settings, with the
 * value it has there: "Only these values still apply from project and local settings, because
 * they turn something off: `none` for the three exporter selectors, and an off value such as `0`"
 * for three content switches. Names are case-sensitive.
 */
export function ignoredInRepositorySettings(name: string, value: string | undefined): boolean {
  const text = value?.trim().toLowerCase();
  if (EXPORTER_SELECTORS.has(name) && text === 'none') return false;
  if (CONTENT_SWITCHES.has(name) && text !== undefined && OFF_VALUES.has(text)) return false;
  if (DROPPED_FROM_REPOSITORY.has(name)) return true;
  if (DROPPED_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  // `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` alike.
  return (
    name.startsWith(OTLP_PREFIX) && DROPPED_OTLP_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

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
