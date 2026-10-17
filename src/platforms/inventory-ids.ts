/**
 * Ids of security inventory items (src/inventory): the one implementation of each id format. The
 * inventory builder names its items with these functions, and the loaders name the item a load
 * entry points at (`LoadEntry.inventoryId`) with the same ones, so every such entry resolves.
 *
 * - MCP server: `mcp:<file>#<name>`.
 * - Hook: `hook:<file>#<event>:<digest>`. The digest is the last 8 hex digits of hash53 of the
 *   handler's redacted command line ({@link hookCommandLine}), or, for a handler without a
 *   command, of what it calls ({@link hookTarget}). Ids never depend on a credential: a hook
 *   whose token changes keeps its id (docs/adr/0007, decision 10).
 * - Permission: `perm:<file>#<key>=<value>`.
 * - Environment override: `env:<file>#<key>`.
 *
 * `file` is the root-relative path of the artifact that declares the item, never a symlink alias.
 * Within one file, an id that repeats gets `:2`, `:3`, … in document order ({@link numberRepeats}).
 */
import { compareStrings } from '../core/compare.js';
import { hash53 } from '../core/fingerprint.js';
import { redactArgs, redactCommand, urlOrigin } from '../inventory/redact.js';
import { type JsonObject, own } from '../parse/json-access.js';
import type { HookHandler, HookPlatform } from './hooks.js';
import type { McpServer } from './mcp.js';

/**
 * `ids` made unique in order: the first of each keeps its id, later ones get `:<n>` from 2 on,
 * skipping any id already taken.
 */
export function numberRepeats(ids: readonly string[]): string[] {
  const used = new Set<string>();
  const counts = new Map<string, number>();
  return ids.map((base) => {
    let id = base;
    if (used.has(id)) {
      let count = counts.get(base) ?? 1;
      do {
        count++;
        id = `${base}:${String(count)}`;
      } while (used.has(id));
      counts.set(base, count);
    }
    used.add(id);
    return id;
  });
}

/** Ids of the MCP servers `file` declares, in the same order. */
export function mcpInventoryIds(
  file: string,
  servers: readonly Pick<McpServer, 'name'>[],
): string[] {
  return numberRepeats(servers.map((server) => `mcp:${file}#${server.name}`));
}

/**
 * Ids of the hook handlers `file` declares, in the same order. Pass every handler in the file,
 * those under unknown events included, as `hookHandlers(doc, platform, { includeUnknown: true })`
 * lists them, and the platform whose file it is: a GitHub Copilot hook's id covers every command
 * field ({@link hookCommandLines}).
 */
export function hookInventoryIds(
  file: string,
  handlers: readonly Pick<HookHandler, 'event' | 'handler'>[],
  platform?: HookPlatform,
): string[] {
  return numberRepeats(
    handlers.map(({ event, handler }) => {
      const what =
        (platform === 'copilot' ? copilotCommandText(handler) : hookCommandLine(handler)) ??
        canonicalJson(hookTarget(handler) ?? {});
      return `hook:${file}#${event}:${hash53(what).slice(-8)}`;
    }),
  );
}

/** Every command field of a Copilot hook as `field: line`, one per line, or undefined. */
function copilotCommandText(handler: JsonObject): string | undefined {
  const lines = hookCommandLines(handler, 'copilot');
  return lines.length === 0
    ? undefined
    : lines.map(({ field, line }) => `${field}: ${line}`).join('\n');
}

/** `perm:<file>#<key>=<value>`. `value` must already have credentials masked. */
export function permInventoryId(file: string, key: string, value: string): string {
  return `perm:${file}#${key}=${value}`;
}

/** `env:<file>#<key>`. */
export function envInventoryId(file: string, key: string): string {
  return `env:${file}#${key}`;
}

// ---------------------------------------------------------------------------------------------
// What a hook runs, as the inventory shows it
// ---------------------------------------------------------------------------------------------

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function quoteArg(arg: string): string {
  return arg === '' || /[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg;
}

/** `program` and the string items of `args`, redacted, each argument quoted when it needs to be. */
function execLine(program: string, args: unknown): string {
  const redacted = redactCommand(program);
  if (!Array.isArray(args)) return redacted;
  const strings = args.filter((arg): arg is string => typeof arg === 'string');
  return [redacted, ...redactArgs(strings).map(quoteArg)].join(' ');
}

/**
 * A command hook's command line with credentials removed (src/inventory/redact.ts). Claude Code's
 * exec form keeps the program in `command` and its arguments in `args`; they are joined, each
 * argument quoted when it needs to be. With `platform` set to `copilot`, the first of the
 * handler's command fields ({@link hookCommandLines}). Undefined for a handler without one.
 */
export function hookCommandLine(handler: JsonObject, platform?: HookPlatform): string | undefined {
  if (platform === 'copilot') return hookCommandLines(handler, platform)[0]?.line;
  const command = stringOf(own(handler, 'command'));
  return command === undefined ? undefined : execLine(command, own(handler, 'args'));
}

/**
 * Fields of a GitHub Copilot hook that hold a shell command: the CLI's `bash` and `powershell`
 * with `command` as the fallback for both (SOURCES.copilotHooksReference), and VS Code's
 * per-system overrides of `command` (SOURCES.vscodeHooksReference). The CLI's `exec` with `args`
 * runs a program without a shell.
 */
const COPILOT_COMMAND_FIELDS = ['bash', 'command', 'powershell', 'linux', 'osx', 'windows'];

export interface HookCommandLine {
  /** The field that holds the command, such as `command`, `bash` or `exec`. */
  readonly field: string;
  /** The command line, redacted. */
  readonly line: string;
}

/**
 * Every command a hook handler can run, redacted, field by field: for a GitHub Copilot hook each
 * of its command fields and `exec`, on the systems and surfaces that read them; for the other
 * platforms the one {@link hookCommandLine}.
 */
export function hookCommandLines(handler: JsonObject, platform?: HookPlatform): HookCommandLine[] {
  if (platform !== 'copilot') {
    const line = hookCommandLine(handler);
    return line === undefined ? [] : [{ field: 'command', line }];
  }
  const lines: HookCommandLine[] = [];
  for (const field of COPILOT_COMMAND_FIELDS) {
    const value = stringOf(own(handler, field));
    if (value !== undefined) lines.push({ field, line: redactCommand(value) });
  }
  const exec = stringOf(own(handler, 'exec'));
  if (exec !== undefined) lines.push({ field: 'exec', line: execLine(exec, own(handler, 'args')) });
  return lines;
}

/**
 * What a hook without a command calls, as far as decision 10 lets an id or digest see it: an
 * HTTP hook's URL origin, an MCP tool hook's server and tool names. A prompt or agent hook's
 * prompt is not covered.
 */
export function hookTarget(handler: JsonObject): object | undefined {
  const url = stringOf(own(handler, 'url'));
  if (url !== undefined) return { url: urlOrigin(url.trim()).origin };
  const server = stringOf(own(handler, 'server'));
  const tool = stringOf(own(handler, 'tool'));
  if (server !== undefined || tool !== undefined) return { server, tool };
  return undefined;
}

/** JSON with object keys sorted by code point and `undefined` fields left out. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}
