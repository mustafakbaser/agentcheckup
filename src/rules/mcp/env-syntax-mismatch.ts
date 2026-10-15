import { RULESET_VERSION } from '../../core/meta.js';
import type { PlatformId } from '../../core/types.js';
import { defineRule } from '../define.js';
import { at, collectStrings, FileFindings, spanOf } from '../json/access.js';
import { quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { isClaudeMcpConfig, mcpPlatform, mcpServers } from './servers.js';
import { MCP_SOURCES } from './sources.js';

/** Cursor's built-in config variables (https://cursor.com/docs/mcp). */
const CURSOR_VARIABLES: ReadonlySet<string> = new Set([
  'userHome',
  'workspaceFolder',
  'workspaceFolderBasename',
  'pathSeparator',
  '/',
]);

/** Claude Code expands variables in these server fields. */
const CLAUDE_FIELDS: ReadonlySet<string> = new Set(['command', 'args', 'env', 'url', 'headers']);
/** Fields that never pass through a shell, where `$NAME` and `%NAME%` stay literal. */
const LITERAL_FIELDS: ReadonlySet<string> = new Set(['env', 'url', 'headers']);

interface Mismatch {
  readonly reference: string;
  readonly kind: 'cursor-env' | 'cursor-builtin' | 'bare' | 'percent';
  readonly name: string;
}

function isNameStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;
}

function isNameChar(code: number): boolean {
  return isNameStart(code) || (code >= 0x30 && code <= 0x39);
}

function isUpperNameChar(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || code === 0x5f || (code >= 0x30 && code <= 0x39);
}

/** Longest `${…}` body examined. */
const MAX_REFERENCE = 128;

function findBraced(value: string): Mismatch | undefined {
  // The close search only moves forward, so the scan stays linear on `${${${…` input.
  let close = -1;
  for (let open = value.indexOf('${'); open !== -1; open = value.indexOf('${', open + 2)) {
    if (close < open + 2) close = value.indexOf('}', open + 2);
    if (close === -1) break;
    if (close - open > MAX_REFERENCE) continue;
    const inner = value.slice(open + 2, close);
    const reference = value.slice(open, close + 1);
    if (inner.startsWith('env:') && inner.length > 4) {
      return { reference, kind: 'cursor-env', name: inner.slice(4) };
    }
    if (CURSOR_VARIABLES.has(inner)) return { reference, kind: 'cursor-builtin', name: inner };
  }
  return undefined;
}

/** `$NAME` (upper-case, not `${`) or `%NAME%`, as written in shells and Windows. */
function findUnbraced(value: string): Mismatch | undefined {
  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i);
    if (
      char === '$' &&
      value.charAt(i + 1) !== '{' &&
      (i === 0 || !isNameChar(value.charCodeAt(i - 1)))
    ) {
      let end = i + 1;
      while (end < value.length && isUpperNameChar(value.charCodeAt(end))) end++;
      const name = value.slice(i + 1, end);
      if (
        name.length >= 2 &&
        isNameStart(value.charCodeAt(i + 1)) &&
        !isNameChar(value.charCodeAt(end))
      ) {
        return { reference: `$${name}`, kind: 'bare', name };
      }
    } else if (char === '%' && isNameStart(value.charCodeAt(i + 1))) {
      let end = i + 1;
      while (end < value.length && isNameChar(value.charCodeAt(end))) end++;
      // At least three characters: percent-encoding (`%E2%9C%93`) has two between the signs.
      if (value.charAt(end) === '%' && end - i > 3) {
        const name = value.slice(i + 1, end);
        return { reference: `%${name}%`, kind: 'percent', name };
      }
      i = end - 1;
    }
  }
  return undefined;
}

function claudeMessage(mismatch: Mismatch): string {
  const ref = quote(mismatch.reference);
  const fixed = '"${' + mismatch.name + '}"';
  switch (mismatch.kind) {
    case 'cursor-env':
      return `${ref} is Cursor's variable syntax, which Claude Code does not expand, so the server gets this text instead of the value of ${mismatch.name}. Write ${fixed}.`;
    case 'cursor-builtin':
      return `${ref} is a Cursor variable that Claude Code does not have, so the server gets this text unchanged.`;
    case 'bare':
    case 'percent':
      return `Claude Code does not expand ${ref} in this field, so the server gets this text instead of the value of ${mismatch.name}. Write ${fixed}.`;
  }
}

function geminiMessage(mismatch: Mismatch): string {
  const ref = quote(mismatch.reference);
  if (mismatch.kind === 'cursor-builtin') {
    return `${ref} is a Cursor variable. Gemini CLI reads it as an environment variable named ${quote(mismatch.name)}, which is normally not set, so the server does not get the value Cursor would use.`;
  }
  return `${ref} is Cursor's variable syntax, which Gemini CLI does not expand, so the server does not get the value of ${mismatch.name}. Write "$${mismatch.name}".`;
}

export const envSyntaxMismatchRule = defineRule({
  meta: {
    id: 'mcp/env-syntax-mismatch',
    title: "MCP configuration uses another agent's variable syntax",
    rationale: [
      "Each agent expands environment variables in MCP configuration with its own syntax. Claude Code expands `${VAR}` and `${VAR:-default}` in the `command`, `args`, `env`, `url` and `headers` of `.mcp.json` servers. Cursor uses `${env:VAR}` and built-ins such as `${workspaceFolder}`. Gemini CLI expands `$VAR`, `${VAR}` and `${VAR:-default}` in every string of `settings.json`. A reference in another agent's syntax is not an error: the server starts without the value, so authentication fails or a path does not exist.",
      'In `.mcp.json` the rule also reports `$VAR` and `%VAR%` in `env`, `url` and `headers`, where no shell expands them.',
      'Rewrite the reference in the syntax of the agent that reads the file.',
    ].join('\n\n'),
    category: 'portability',
    severity: 'warn',
    appliesTo: ['mcp-json', 'claude-plugin-manifest', 'gemini-settings'],
    platforms: ['claude-code', 'gemini'],
    sources: [
      SOURCES.claudeMcp,
      SOURCES.claudePlugins,
      SOURCES.cursorMcp,
      SOURCES.geminiMcp,
      MCP_SOURCES.geminiConfiguration,
      MCP_SOURCES.geminiEnvResolver,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const platform: PlatformId | undefined = mcpPlatform(artifact);
      if (platform === undefined || !context.targets.has(platform)) continue;
      if (platform === 'claude-code' && !isClaudeMcpConfig(context.snapshot, artifact)) continue;
      const doc = context.json(artifact);
      if (!doc.ok) continue;
      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, "variable references in another agent's syntax");
      for (const server of mcpServers(artifact, doc)) {
        for (const field of Object.keys(server.config)) {
          if (platform === 'claude-code' && !CLAUDE_FIELDS.has(field)) continue;
          for (const item of collectStrings(server.config[field], [...server.path, field])) {
            let mismatch = findBraced(item.value);
            if (mismatch === undefined && platform === 'claude-code' && LITERAL_FIELDS.has(field)) {
              mismatch = findUnbraced(item.value);
            }
            if (mismatch === undefined) continue;
            findings.report({
              artifact,
              ...at(spanOf(doc, item.path)),
              message:
                platform === 'claude-code' ? claudeMessage(mismatch) : geminiMessage(mismatch),
              platforms: [platform],
            });
          }
        }
      }
      findings.finish();
    }
  },
});
