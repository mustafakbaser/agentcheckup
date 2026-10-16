import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, Fix, PlatformId } from '../../core/types.js';
import { jsonReplaceValue } from '../../fix/edits.js';
import { defineRule } from '../define.js';
import { at, collectStrings, FileFindings, spanOf, type StringValue } from '../json/access.js';
import { editable, sharedFileGuidance } from '../json/fix-support.js';
import { plural, quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { isClaudeMcpConfig, mcpPlatform, mcpServers } from './servers.js';
import { MCP_SOURCES } from './sources.js';

const ID = 'mcp/env-syntax-mismatch';

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
  /** Offset of the reference in the string. */
  readonly index: number;
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

function findBraced(value: string, from = 0): Mismatch | undefined {
  // The close search only moves forward, so the scan stays linear on `${${${…` input.
  let close = -1;
  for (let open = value.indexOf('${', from); open !== -1; open = value.indexOf('${', open + 2)) {
    if (close < open + 2) close = value.indexOf('}', open + 2);
    if (close === -1) break;
    if (close - open > MAX_REFERENCE) continue;
    const inner = value.slice(open + 2, close);
    const reference = value.slice(open, close + 1);
    if (inner.startsWith('env:') && inner.length > 4) {
      return { reference, kind: 'cursor-env', name: inner.slice(4), index: open };
    }
    if (CURSOR_VARIABLES.has(inner)) {
      return { reference, kind: 'cursor-builtin', name: inner, index: open };
    }
  }
  return undefined;
}

/** `$NAME` (upper-case, not `${`) or `%NAME%`, as written in shells and Windows. */
function findUnbraced(value: string, from = 0): Mismatch | undefined {
  for (let i = from; i < value.length; i++) {
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
        return { reference: `$${name}`, kind: 'bare', name, index: i };
      }
    } else if (char === '%' && isNameStart(value.charCodeAt(i + 1))) {
      let end = i + 1;
      while (end < value.length && isNameChar(value.charCodeAt(end))) end++;
      // At least three characters: percent-encoding (`%E2%9C%93`) has two between the signs.
      if (value.charAt(end) === '%' && end - i > 3) {
        const name = value.slice(i + 1, end);
        return { reference: `%${name}%`, kind: 'percent', name, index: i };
      }
      i = end - 1;
    }
  }
  return undefined;
}

/**
 * The first reference in another agent's syntax at or after `from`: `${env:…}` and Cursor
 * built-ins, and with `unbraced` also `$NAME` and `%NAME%`.
 */
function findMismatch(value: string, unbraced: boolean, from = 0): Mismatch | undefined {
  const braced = findBraced(value, from);
  if (!unbraced) return braced;
  const other = findUnbraced(value, from);
  if (braced === undefined) return other;
  return other !== undefined && other.index < braced.index ? other : braced;
}

/** Most references rewritten in one string. */
const MAX_REWRITES = 64;

const ENV_NAME = /^[a-z_]\w{0,127}$/i;

/** The reference in the reader's syntax, or undefined when it cannot be rewritten. */
function rewritten(platform: PlatformId, mismatch: Mismatch, next: number): string | undefined {
  if (mismatch.kind === 'cursor-builtin' || !ENV_NAME.test(mismatch.name)) return undefined;
  if (platform === 'gemini') {
    return isNameChar(next) ? '${' + mismatch.name + '}' : '$' + mismatch.name;
  }
  return '${' + mismatch.name + '}';
}

/**
 * The string with every reference in another agent's syntax rewritten, or undefined when one of
 * them cannot be: a Cursor built-in has no equivalent, so the finding would stay.
 */
function rewriteAll(
  value: string,
  platform: PlatformId,
  unbraced: boolean,
): { readonly value: string; readonly names: readonly string[] } | undefined {
  let out = '';
  let position = 0;
  const names: string[] = [];
  for (let found = findMismatch(value, unbraced); found !== undefined;) {
    if (names.length === MAX_REWRITES) return undefined;
    const end = found.index + found.reference.length;
    const replacement = rewritten(platform, found, value.charCodeAt(end));
    if (replacement === undefined) return undefined;
    out += value.slice(position, found.index) + replacement;
    names.push(found.name);
    position = end;
    found = findMismatch(value, unbraced, end);
  }
  return names.length === 0 ? undefined : { value: out + value.slice(position), names };
}

function fixFor(
  artifact: Artifact,
  item: StringValue,
  platform: PlatformId,
  unbraced: boolean,
): Fix | undefined {
  const result = rewriteAll(item.value, platform, unbraced);
  if (result === undefined) return undefined;
  const change = jsonReplaceValue(artifact, item.path, result.value);
  if (change === undefined) return undefined;
  const agent = platform === 'gemini' ? 'Gemini CLI' : 'Claude Code';
  const [first] = result.names;
  const title =
    result.names.length === 1 && first !== undefined
      ? `Write the reference to ${first} in ${agent}'s syntax`
      : `Write ${plural(result.names.length, 'variable reference')} in ${agent}'s syntax`;
  const notes =
    platform === 'gemini'
      ? []
      : [
          'Claude Code does not load the server configuration when a referenced variable is not set and has no default; write "${NAME:-}" to allow an empty value.',
        ];
  return {
    id: `${ID}#${platform === 'gemini' ? 'gemini' : 'claude'}`,
    class: 'review',
    title,
    changes: [change],
    ...(notes.length === 0 ? {} : { notes }),
  };
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

/** The manual step for a Cursor built-in, which no other agent has. */
function builtinGuidance(platform: PlatformId, mismatch: Mismatch): string {
  const syntax = platform === 'gemini' ? '"$NAME"' : '"${NAME}"';
  return `replace ${quote(mismatch.reference)} with the value itself or an environment variable written as ${syntax}`;
}

export const envSyntaxMismatchRule = defineRule({
  meta: {
    id: ID,
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
    fix: {
      classes: ['review'],
      summary:
        'Rewrites every reference in the string in the syntax of the agent that reads the file: "${NAME}" for Claude Code, "$NAME" for Gemini CLI. Not offered for Cursor built-ins such as "${workspaceFolder}", which the other agents do not have, or for a file that other paths link to.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const platform: PlatformId | undefined = mcpPlatform(artifact);
      if (platform === undefined || !context.targets.has(platform)) continue;
      if (platform === 'claude-code' && !isClaudeMcpConfig(context.snapshot, artifact)) continue;
      const doc = context.json(artifact);
      if (!doc.ok) continue;
      const canEdit = editable(artifact);
      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, "variable references in another agent's syntax");
      for (const server of mcpServers(artifact, doc)) {
        for (const field of Object.keys(server.config)) {
          if (platform === 'claude-code' && !CLAUDE_FIELDS.has(field)) continue;
          const unbraced = platform === 'claude-code' && LITERAL_FIELDS.has(field);
          for (const item of collectStrings(server.config[field], [...server.path, field])) {
            const mismatch =
              findBraced(item.value) ?? (unbraced ? findUnbraced(item.value) : undefined);
            if (mismatch === undefined) continue;
            const fix = canEdit ? fixFor(artifact, item, platform, unbraced) : undefined;
            const guidance = !canEdit
              ? sharedFileGuidance(artifact)
              : mismatch.kind === 'cursor-builtin'
                ? builtinGuidance(platform, mismatch)
                : undefined;
            findings.report({
              artifact,
              ...at(spanOf(doc, item.path)),
              message:
                platform === 'claude-code' ? claudeMessage(mismatch) : geminiMessage(mismatch),
              platforms: [platform],
              ...(fix === undefined ? {} : { fix }),
              ...(guidance === undefined ? {} : { guidance }),
            });
          }
        }
      }
      findings.finish();
    }
  },
});
