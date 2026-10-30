import { RULESET_VERSION } from '../../core/meta.js';
import { type Artifact, type ArtifactKind, type Fix, PLATFORM_IDS } from '../../core/types.js';
import { replaceSpan } from '../../fix/edits.js';
import { configDocument, JSON_KINDS, TOML_KINDS } from '../../platforms/kinds.js';
import { defineRule } from '../define.js';
import {
  at,
  collectStrings,
  type JsonPath,
  type ParsedJson,
  pathLabel,
  spanOf,
} from '../json/access.js';
import { editable, sharedFileGuidance } from '../json/fix-support.js';
import { formatInteger } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { findSecret, type SecretMatch } from './secrets.js';
import { MCP_SOURCES } from './sources.js';

const ID = 'mcp/literal-secret';

/** Findings per file before the rule stops reporting. */
export const MAX_SECRET_FINDINGS = 20;

/**
 * Printed before and after a credential fix (`Fix.warning`). A warning also marks the fix as one
 * that handles a credential: reports redact every span its edits replace.
 */
export const ROTATION_WARNING =
  'Revoke and rotate this credential now. Editing the file does not remove it from git history.';

const ENV_NAME = /^[a-z_]\w{0,63}$/i;

function variableName(path: JsonPath, fallback: string): string {
  const last = path[path.length - 1];
  const parent = path[path.length - 2];
  return parent === 'env' && typeof last === 'string' && ENV_NAME.test(last) ? last : fallback;
}

/** Server fields in which Claude Code and Cursor expand variable references. */
const EXPANDED_FIELDS: ReadonlySet<string> = new Set(['command', 'args', 'env', 'url', 'headers']);

/**
 * The fields of a remote server in which Claude Code reads credential variables as empty
 * (`REMOTE_EMPTY_EXAMPLES` in src/platforms/mcp.ts).
 */
const REMOTE_FIELDS: ReadonlySet<string> = new Set(['url', 'headers']);

/**
 * The server name and field of an inline MCP server entry that `path` lies in, or undefined
 * outside one: `mcpServers.<name>.<field>…`, and `mcpServers[i].<name>.<field>…` in a plugin
 * manifest.
 */
function serverAt(
  artifact: Artifact,
  path: JsonPath,
): { readonly name: string; readonly field: string } | undefined {
  if (path[0] !== 'mcpServers') return undefined;
  const indexed = artifact.kind === 'claude-plugin-manifest' && typeof path[1] === 'number';
  const name = indexed ? path[2] : path[1];
  const field = indexed ? path[3] : path[2];
  return typeof name === 'string' && typeof field === 'string' ? { name, field } : undefined;
}

function serverField(artifact: Artifact, path: JsonPath): string | undefined {
  return serverAt(artifact, path)?.field;
}

/** Longest variable name the fix writes, as {@link ENV_NAME} allows. */
const MAX_NAME = 64;

/**
 * A variable name of the server's own for `variable`: the server's name in upper case, letters
 * and digits kept and every other run of characters made one `_`, then the variable.
 * `registry` and `NPM_TOKEN` give `REGISTRY_NPM_TOKEN`; `npm` and `NPM_TOKEN` give
 * `NPM_MCP_TOKEN`.
 */
export function serverVariable(server: string, variable: string): string {
  let prefix = '';
  for (let i = 0; i < server.length; i++) {
    const code = server.charCodeAt(i);
    if (code >= 0x61 && code <= 0x7a) prefix += String.fromCharCode(code - 0x20);
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39)) {
      prefix += server.charAt(i);
    } else if (prefix !== '' && !prefix.endsWith('_')) prefix += '_';
  }
  while (prefix.endsWith('_')) prefix = prefix.slice(0, -1);
  const first = prefix.charCodeAt(0);
  if (prefix === '' || (first >= 0x30 && first <= 0x39))
    prefix = `MCP${prefix === '' ? '' : '_'}${prefix}`;
  const rest = variable.startsWith(`${prefix}_`)
    ? `MCP_${variable.slice(prefix.length + 1)}`
    : variable;
  const room = Math.max(1, MAX_NAME - rest.length - 1);
  let cut = prefix.slice(0, room);
  while (cut.endsWith('_')) cut = cut.slice(0, -1);
  return `${cut}_${rest}`.slice(0, MAX_NAME);
}

/**
 * The variable the fix references: the `env` key a token sits under, else the vendor's usual
 * name. In a remote server's `url` and `headers` Claude Code reads credential variables as
 * empty, whether or not they are set, and names only examples of them (SOURCES.claudeMcp), so
 * there the name is the server's own ({@link serverVariable}), as the documentation advises:
 * "copy it into a variable with a name of your own".
 */
function fixVariable(
  artifact: Artifact,
  path: JsonPath,
  fallback: string,
): {
  readonly name: string;
  readonly remote: boolean;
} {
  const name = variableName(path, fallback);
  const server = serverAt(artifact, path);
  const claude = artifact.kind === 'mcp-json' || artifact.kind === 'claude-plugin-manifest';
  if (!claude || server === undefined || !REMOTE_FIELDS.has(server.field)) {
    return { name, remote: false };
  }
  return { name: serverVariable(server.name, name), remote: true };
}

/**
 * Where Codex takes a value from the environment instead (SOURCES.codexMcp): `env_vars` forwards
 * a variable, `env_http_headers` and `bearer_token_env_var` name the variable that holds a header
 * or the bearer token. Codex expands no `${NAME}` references.
 */
function codexRemedy(path: JsonPath): string {
  const field = path[0] === 'mcp_servers' ? path[2] : undefined;
  if (field === 'env') return 'list the variable in "env_vars" and set it in the environment';
  if (field === 'http_headers') {
    return 'move the header to "env_http_headers", which names the variable that holds it';
  }
  if (field === 'bearer_token') return 'name the variable that holds it in "bearer_token_env_var"';
  return 'read it from the environment';
}

function remedy(artifact: Artifact, path: JsonPath, name: string): string {
  if (artifact.kind === 'codex-config') return codexRemedy(path);
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

/**
 * What Claude Code does with a reference to a variable that is not set: the configuration still
 * loads, and the server gets the text as written (SOURCES.claudeMcp, "Unset variables without a
 * default").
 */
export function unsetNote(name: string): string {
  return `Claude Code keeps an unset "\${${name}}" as literal text and warns in "claude mcp list"; write "\${${name}:-}" to send an empty value.`;
}

function isNameChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

/**
 * The variable reference that replaces the token, in the syntax of the agent that reads the
 * file, or undefined where the agent expands no variables: outside server entries, and in Claude
 * Code and Cursor outside the fields they expand. `next` is the character after the token.
 */
function reference(
  artifact: Artifact,
  path: JsonPath,
  name: string,
  next: number,
): string | undefined {
  if (artifact.kind === 'gemini-settings') {
    // Gemini CLI expands variables in every string of settings.json, `$NAME` and `${NAME}`.
    return isNameChar(next) ? '${' + name + '}' : '$' + name;
  }
  const field = serverField(artifact, path);
  if (field === undefined || !EXPANDED_FIELDS.has(field)) return undefined;
  if (artifact.kind === 'mcp-json' || artifact.kind === 'claude-plugin-manifest') {
    return '${' + name + '}';
  }
  if (artifact.kind === 'cursor-mcp') return '${env:' + name + '}';
  return undefined;
}

/**
 * A fix that replaces exactly the token's characters with a variable reference. Only the token
 * span changes, so the edit's span is the credential itself: fix reports redact it wherever it
 * appears. Undefined when the string holds another credential, or when an escape sequence comes
 * before the token, so its offset in the file is not its offset in the value.
 */
function fixFor(
  artifact: Artifact,
  doc: ParsedJson,
  path: JsonPath,
  value: string,
  secret: SecretMatch,
): Fix | undefined {
  const end = secret.start + secret.length;
  if (findSecret(value.slice(end)) !== undefined) return undefined;
  const span = doc.valueSpan(path);
  if (span === undefined) return undefined;
  const { text } = artifact.decoded;
  const raw = text.slice(span.offset + 1, span.offset + span.length - 1);
  if (text.charAt(span.offset) !== '"' || raw.slice(0, end).includes('\\')) return undefined;
  const offset = span.offset + 1 + secret.start;
  if (text.slice(offset, offset + secret.length) !== value.slice(secret.start, end)) {
    return undefined;
  }
  const { name, remote } = fixVariable(artifact, path, secret.variable);
  const replacement = reference(artifact, path, name, value.charCodeAt(end));
  if (replacement === undefined) return undefined;
  const notes = [`Set ${name} in the environment of everyone who uses this configuration.`];
  if (remote) {
    notes.push(
      `Claude Code reads credential variables such as ANTHROPIC_API_KEY and NPM_TOKEN as empty in a remote server's url and headers, so the reference uses a name of this server's own rather than ${variableName(path, secret.variable)}.`,
    );
  }
  if (artifact.kind === 'mcp-json' || artifact.kind === 'claude-plugin-manifest') {
    notes.push(unsetNote(name));
  }
  return {
    id: `${ID}#reference`,
    class: 'review',
    title: `Replace the literal ${secret.vendor} with ${replacement}`,
    changes: [replaceSpan(artifact, { offset, length: secret.length }, replacement)],
    notes,
    warning: ROTATION_WARNING,
  };
}

export const literalSecretRule = defineRule({
  meta: {
    id: ID,
    title: 'Configuration file contains a literal credential',
    rationale: [
      'MCP configurations, settings and hook files are committed with the project, so a token written into one is readable by everyone who can read the repository, its forks and its history. Keys exposed in public GitHub repositories have been used within two minutes. `claude plugin validate` also warns about header values that look like literal credentials.',
      "The rule reports only tokens with a known vendor prefix and shape (GitHub, OpenAI, Anthropic, Slack, AWS access key IDs, GitLab, Stripe live keys, Google API keys, npm, Hugging Face, PyPI, DigitalOcean, Shopify, Doppler). Slack's rotating app-level tokens (`xoxe.xapp-`) and workflow tokens (`xwfp-`) count, and a Claude Enterprise admin key, which starts with `sk-ant-api01-` like an API key, is reported as an Anthropic API key: the prefix cannot tell them apart. It skips placeholders such as `ghp_xxxx…` and AWS's `…EXAMPLE` keys, and never reports variable references. The message shows only the first four characters and the length. An AWS access key ID is a warning rather than an error: without its secret access key it grants no access, but it identifies the account and the secret is often committed next to it.",
      "Revoke and rotate the credential; deleting it from the file does not remove it from git history. Then read it from the environment: `${VAR}` in `.mcp.json`, `${env:VAR}` in `.cursor/mcp.json`, `$VAR` in `.gemini/settings.json`. Codex's `.codex/config.toml` expands no variables: forward one with `env_vars`, or name it in `env_http_headers` or `bearer_token_env_var`; the rule offers no fix there.",
      "In a remote server's `url` and `headers`, Claude Code reads credential variables such as `ANTHROPIC_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK` and `NPM_TOKEN` as empty, set or not, so `Bearer ${NPM_TOKEN}` sends `Bearer `. There the fix references a variable named after the server, such as `REGISTRY_NPM_TOKEN` for a server named `registry`.",
    ].join('\n\n'),
    category: 'risk',
    severity: 'error',
    appliesTo: [...JSON_KINDS, ...TOML_KINDS] as readonly ArtifactKind[],
    platforms: PLATFORM_IDS,
    sources: [
      MCP_SOURCES.orcaHoneypot,
      SOURCES.claudePlugins,
      SOURCES.claudeMcp,
      SOURCES.cursorMcp,
      SOURCES.geminiMcp,
      SOURCES.codexMcp,
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
    fix: {
      classes: ['review'],
      summary:
        'Replaces only the token with a variable reference in the syntax of the agent that reads the file: "${NAME}" in .mcp.json and plugin servers, with a name of the server\'s own in a remote server\'s url and headers, "${env:NAME}" in .cursor/mcp.json, "$NAME" in .gemini/settings.json. Applied only when you name the rule or accept the fix, always with a warning to rotate the credential.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const doc = configDocument(context, artifact);
      if (!doc.ok) continue;
      const canEdit = editable(artifact);
      // No fix builder edits TOML; the message says what to change.
      const fixable = canEdit && !TOML_KINDS.has(artifact.kind);
      let reported = 0;
      for (const { path, value } of collectStrings(doc.value)) {
        if (reported === MAX_SECRET_FINDINGS) break;
        const secret = findSecret(value);
        if (secret === undefined) continue;
        reported++;
        const token = value.slice(secret.start, secret.start + secret.length);
        const shown = `("${token.slice(0, 4)}…", ${formatInteger(token.length)} characters)`;
        const { name } = fixVariable(artifact, path, secret.variable);
        const fix = fixable ? fixFor(artifact, doc, path, value, secret) : undefined;
        const guidance = canEdit ? undefined : sharedFileGuidance(artifact);
        context.report({
          artifact,
          ...at(spanOf(doc, path)),
          // An access key ID alone grants nothing, so it is a warning and never caps the score.
          ...(secret.identifier ? { severity: 'warn' as const } : {}),
          message: secret.identifier
            ? `${pathLabel(path)} holds a literal ${secret.vendor} ${shown}. The ID alone does not grant access, but it identifies the account, and its secret key is often committed next to it. Check that the secret key is not in the repository, then ${remedy(artifact, path, name)}.`
            : `${pathLabel(path)} holds a literal ${secret.vendor} ${shown} that anyone who can read this file can copy. Revoke and rotate it, then ${remedy(artifact, path, name)}.`,
          platforms: artifact.readers,
          ...(fix === undefined ? {} : { fix }),
          ...(guidance === undefined ? {} : { guidance }),
        });
      }
    }
  },
});
