/**
 * Reads a policy file. Pure: src/io reads the file and parses the JSON (as untrusted input, with
 * null-prototype objects); this module checks every field and returns the normalized policy, or
 * one line per problem. Only own properties are read, so `__proto__` is an ordinary, unknown key.
 *
 * Every string grammar is a regex literal in ./schema.ts that the published schema shares. A
 * string is accepted exactly when its literal matches; the other checks here only explain why a
 * string was rejected.
 */
import { formatInteger } from '../core/format.js';
import { normalizeRelative } from '../core/paths.js';
import { npmPin } from '../inventory/package-spec.js';
import { HOOK_EVENTS, HOOK_PLATFORMS, type HookPlatform } from '../platforms/hooks.js';
import { CONTEXT_AGENTS, type ContextAgent } from '../platforms/load/types.js';
import { platformName, quote } from '../rules/shared/format.js';
import { nearest } from './text.js';
import {
  COMMAND_NAME,
  MAX_NAME_LENGTH,
  MAX_STARTUP_TOKENS,
  NPM_ENTRY,
  OCI_ENTRY,
  ORIGIN_ENTRY,
  POLICY_VERSION,
  PYPI_ENTRY,
  TOOL_NAME,
} from './schema.js';
import {
  type AllowEntry,
  EXISTING_MODES,
  type ExistingMode,
  FORBID_NAMES,
  type ForbidName,
  type HookRequirement,
  type Policy,
  POLICY_MODES,
  type PolicyMode,
} from './types.js';

export type PolicyParseResult =
  { readonly policy: Policy } | { readonly errors: readonly string[] };

/** The sentence every unknown-field error ends with. */
export const UNKNOWN_FIELD_REASON =
  'Unknown fields are an error, so a typo cannot switch a check off.';

const TOP_FIELDS = [
  '$schema',
  'policyVersion',
  'name',
  'mode',
  'existing',
  'mcp',
  'forbid',
  'permissions',
  'hooks',
  'budgets',
] as const;
const MCP_FIELDS = ['allow', 'allowLocal', 'requirePin'] as const;
const PERMISSION_FIELDS = ['denyTools', 'denyCommands'] as const;
const HOOKS_FIELDS = ['require'] as const;
const REQUIREMENT_FIELDS = ['agent', 'event', 'matcher', 'script', 'command'] as const;
const BUDGET_FIELDS = ['startupTokens'] as const;

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON value as a message shows it: quoted and bounded for strings. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return 'an object';
}

function own(record: JsonRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** `mcp` + `allow` -> `mcp.allow`; `''` + `name` -> `name`. */
function child(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

const oneOf = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(', ');

class Validator {
  readonly issues: string[] = [];

  add(path: string, problem: string): void {
    this.issues.push(path === '' ? problem : `${path}: ${problem}`);
  }

  /** Reports every own key of `record` that is not in `allowed`. */
  unknownFields(record: JsonRecord, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(record)) {
      if (allowed.includes(key)) continue;
      const guess = nearest(key, allowed);
      const hint = guess === undefined ? '' : ` (did you mean ${quote(child(path, guess))}?)`;
      this.issues.push(`Unknown field ${quote(child(path, key))}${hint}. ${UNKNOWN_FIELD_REASON}`);
    }
  }

  record(value: unknown, path: string): JsonRecord | undefined {
    if (isRecord(value)) return value;
    this.add(path, `expected an object, got ${describe(value)}.`);
    return undefined;
  }

  array(value: unknown, path: string): readonly unknown[] | undefined {
    if (Array.isArray(value)) return value as readonly unknown[];
    this.add(path, `expected an array, got ${describe(value)}.`);
    return undefined;
  }

  boolean(value: unknown, path: string): boolean | undefined {
    if (typeof value === 'boolean') return value;
    this.add(path, `expected true or false, got ${describe(value)}.`);
    return undefined;
  }

  choice<T extends string>(value: unknown, choices: readonly T[], path: string): T | undefined {
    if (typeof value === 'string' && (choices as readonly string[]).includes(value)) {
      return value as T;
    }
    this.add(path, `expected one of ${oneOf(choices)}, got ${describe(value)}.`);
    return undefined;
  }

  /** Strings of an array that `check` accepts; `check` reports the others. */
  strings<T>(
    value: unknown,
    path: string,
    check: (text: string, at: string) => T | undefined,
  ): T[] | undefined {
    const list = this.array(value, path);
    if (list === undefined) return undefined;
    const out: T[] = [];
    list.forEach((item, index) => {
      const at = `${path}[${index}]`;
      if (typeof item !== 'string') {
        this.add(at, `expected a string, got ${describe(item)}.`);
        return;
      }
      const parsed = check(item, at);
      if (parsed !== undefined) out.push(parsed);
    });
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/**
 * Validates a parsed policy file. Returns the policy with defaults applied, or every problem, one
 * line each. Never throws on bad input.
 */
export function parsePolicy(json: unknown): PolicyParseResult {
  const v = new Validator();
  if (!isRecord(json)) return { errors: [`expected a JSON object, got ${describe(json)}.`] };
  v.unknownFields(json, TOP_FIELDS, '');

  if (Object.hasOwn(json, '$schema') && typeof json['$schema'] !== 'string') {
    v.add('$schema', `expected a string, got ${describe(json['$schema'])}.`);
  }
  checkVersion(v, json);
  const name = checkName(v, json);

  const mode: PolicyMode = Object.hasOwn(json, 'mode')
    ? (v.choice(json['mode'], POLICY_MODES, 'mode') ?? 'enforce')
    : 'enforce';
  const existing: ExistingMode = Object.hasOwn(json, 'existing')
    ? (v.choice(json['existing'], EXISTING_MODES, 'existing') ?? 'report')
    : 'report';

  const mcp = checkMcp(v, own(json, 'mcp'));
  const forbid = Object.hasOwn(json, 'forbid') ? checkForbid(v, json['forbid']) : [];
  const permissions = checkPermissions(v, own(json, 'permissions'));
  const requireHooks = checkHooks(v, own(json, 'hooks'));
  const budgets = checkBudgets(v, own(json, 'budgets'));

  if (v.issues.length > 0) return { errors: v.issues };
  return {
    policy: {
      name,
      mode,
      existing,
      mcp,
      forbid,
      denyTools: permissions.denyTools,
      denyCommands: permissions.denyCommands,
      requireHooks,
      budgets,
    },
  };
}

function checkVersion(v: Validator, json: JsonRecord): void {
  if (!Object.hasOwn(json, 'policyVersion')) {
    v.add('', `policyVersion is required. Add "policyVersion": ${POLICY_VERSION}.`);
    return;
  }
  const version = json['policyVersion'];
  if (version === POLICY_VERSION) return;
  if (typeof version === 'number' && Number.isInteger(version) && version > POLICY_VERSION) {
    v.add(
      '',
      `policyVersion ${version} is newer than this agentcheckup reads (${POLICY_VERSION}). Update agentcheckup to use this policy.`,
    );
    return;
  }
  v.add('policyVersion', `expected ${POLICY_VERSION}, got ${describe(version)}.`);
}

function checkName(v: Validator, json: JsonRecord): string {
  if (!Object.hasOwn(json, 'name')) {
    v.add('', 'name is required. Reports show it, so readers know which policy failed.');
    return '';
  }
  const name = json['name'];
  if (typeof name !== 'string') {
    v.add('name', `expected a string, got ${describe(name)}.`);
    return '';
  }
  // Code points, as JSON Schema's maxLength counts them.
  let length = 0;
  for (const _char of name) length++;
  if (length === 0) v.add('name', 'must not be empty.');
  else if (length > MAX_NAME_LENGTH) {
    v.add('name', `must be at most ${MAX_NAME_LENGTH} characters, got ${length}.`);
  }
  return name;
}

// ---------------------------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------------------------

function checkMcp(v: Validator, value: unknown): Policy['mcp'] {
  const defaults = { allowLocal: false, requirePin: false };
  if (value === undefined) return defaults;
  const mcp = v.record(value, 'mcp');
  if (mcp === undefined) return defaults;
  v.unknownFields(mcp, MCP_FIELDS, 'mcp');
  const allow = Object.hasOwn(mcp, 'allow')
    ? v.strings(mcp['allow'], 'mcp.allow', (text, at) => {
        const entry = parseAllowEntry(text);
        if (!('error' in entry)) return entry;
        v.add(at, entry.error);
        return undefined;
      })
    : undefined;
  const allowLocal = Object.hasOwn(mcp, 'allowLocal')
    ? v.boolean(mcp['allowLocal'], 'mcp.allowLocal')
    : undefined;
  const requirePin = Object.hasOwn(mcp, 'requirePin')
    ? v.boolean(mcp['requirePin'], 'mcp.requirePin')
    : undefined;
  return {
    ...(allow === undefined ? {} : { allow }),
    allowLocal: allowLocal ?? false,
    requirePin: requirePin ?? false,
  };
}

/** PEP 503: lower case, and every run of `-`, `_` and `.` becomes one `-`. */
export function pep503(name: string): string {
  return name.toLowerCase().replace(/[-._]+/g, '-');
}

/**
 * An image name with Docker's defaults: the registry is `docker.io` unless the first component
 * names a host (it holds a `.` or a `:`, or is `localhost`), `index.docker.io` is `docker.io`,
 * and an image directly on `docker.io` is in `library/`. Registry hosts are compared in lower
 * case.
 */
export function normalizeImage(image: string): string {
  const slash = image.indexOf('/');
  const first = slash < 0 ? '' : image.slice(0, slash);
  const hasRegistry =
    slash >= 0 && (first.includes('.') || first.includes(':') || first === 'localhost');
  let registry = hasRegistry ? first.toLowerCase() : 'docker.io';
  if (registry === 'index.docker.io') registry = 'docker.io';
  const path = hasRegistry ? image.slice(slash + 1) : image;
  return registry === 'docker.io' && !path.includes('/')
    ? `docker.io/library/${path}`
    : `${registry}/${path}`;
}

/** An exact PEP 440 version as compared: lower case, without a leading `v`. */
export function pep440Core(version: string): string {
  const lower = version.toLowerCase();
  return lower.startsWith('v') ? lower.slice(1) : lower;
}

/** The port a scheme uses when a URL names none. */
function defaultPort(scheme: string): string {
  return scheme === 'https' || scheme === 'wss' ? '443' : '80';
}

/** An exact semver as npm compares it: without a leading `=` or `v`. */
export function semverCore(version: string): string {
  return version.startsWith('=') || version.startsWith('v') ? version.slice(1) : version;
}

/**
 * Host and port of an origin entry, as the URL parser writes them in a server's origin: lower
 * case, IPv4 and IPv6 addresses in canonical form, the default port left out. A host the URL
 * parser rejects keeps its lower-case spelling, so it can never match a server.
 */
function canonicalHost(
  scheme: string,
  host: string,
  port: string,
  wildcard: boolean,
): { host: string; port: string } {
  // A wildcard's suffix is parsed below a placeholder label, then the label is removed again.
  const placeholder = wildcard ? 'x.' : '';
  const text = `${scheme}://${placeholder}${host}${port === '' ? '' : `:${port}`}`;
  if (URL.canParse(text)) {
    const url = new URL(text);
    if (url.hostname.startsWith(placeholder)) {
      return { host: url.hostname.slice(placeholder.length), port: url.port };
    }
  }
  const lower = host.toLowerCase();
  return { host: lower, port: port === defaultPort(scheme) ? '' : port };
}

/** One `mcp.allow` entry, or why it is not one. */
export function parseAllowEntry(text: string): AllowEntry | { readonly error: string } {
  if (NPM_ENTRY.test(text)) {
    const body = text.slice('npm:'.length);
    const at = body.indexOf('@', body.startsWith('@') ? 1 : 0);
    if (at < 0) return { kind: 'npm', text, name: body };
    return {
      kind: 'npm',
      text,
      name: body.slice(0, at),
      version: semverCore(body.slice(at + 1)),
    };
  }
  if (PYPI_ENTRY.test(text)) {
    const body = text.slice('pypi:'.length);
    const equals = body.indexOf('==');
    if (equals < 0) return { kind: 'pypi', text, name: pep503(body) };
    return {
      kind: 'pypi',
      text,
      name: pep503(body.slice(0, equals)),
      version: body.slice(equals + 2),
    };
  }
  if (OCI_ENTRY.test(text)) {
    const body = text.slice('oci:'.length);
    const at = body.indexOf('@');
    if (at < 0) return { kind: 'oci', text, image: normalizeImage(body) };
    return {
      kind: 'oci',
      text,
      image: normalizeImage(body.slice(0, at)),
      digest: body.slice(at + 1),
    };
  }
  if (ORIGIN_ENTRY.test(text)) {
    const separator = text.indexOf('://');
    const scheme = text.slice(0, separator);
    let authority = text.slice(separator + 3);
    const wildcard = authority.startsWith('*.');
    if (wildcard) authority = authority.slice(2);
    // The pattern allows a colon only before the port, or inside an IPv6 address's brackets.
    const close = authority.lastIndexOf(']');
    const colon = authority.lastIndexOf(':');
    const hasPort = colon > close;
    const host = hasPort ? authority.slice(0, colon) : authority;
    const port = hasPort ? authority.slice(colon + 1) : '';
    return {
      kind: 'origin',
      text,
      scheme,
      ...canonicalHost(scheme, host, port, wildcard),
      wildcard,
    };
  }
  return { error: entryError(text) };
}

const SCHEMES: readonly string[] = ['http', 'https', 'ws', 'wss'];

/** Why `text` is not an allowlist entry, as one sentence or two. */
function entryError(text: string): string {
  const shown = quote(text);
  if (text.startsWith('npm:')) {
    const body = text.slice('npm:'.length);
    const at = body.indexOf('@', body.startsWith('@') ? 1 : 0);
    const pin = at < 0 ? undefined : npmPin(body.slice(at + 1));
    if (pin === 'range') {
      return `${shown} names a version range. Ranges are not allowed: give an exact version or none.`;
    }
    if (pin === 'tag') {
      return `${shown} names a moving tag. Tags are not allowed: give an exact version or none.`;
    }
    return `${shown} is not a valid npm entry. Use npm:<name> or npm:<name>@<exact version>.`;
  }
  if (text.startsWith('pypi:')) {
    const body = text.slice('pypi:'.length);
    if (/[!*,<>~]/.test(body) || body.includes('===')) {
      return `${shown} names a version range. Ranges are not allowed: use pypi:<name>==<exact version> or no version.`;
    }
    return `${shown} is not a valid PyPI entry. Use pypi:<name> or pypi:<name>==<exact version>.`;
  }
  if (text.startsWith('oci:')) {
    const body = text.slice('oci:'.length);
    const at = body.indexOf('@');
    const reference = at < 0 ? body : body.slice(0, at);
    if (reference.includes(':', reference.lastIndexOf('/') + 1)) {
      return `${shown} names a tag. Tags move, so they are not allowed: pin with @sha256:<digest> or give no version.`;
    }
    if (at >= 0) {
      return `${shown} has an invalid digest. Use @sha256: followed by 64 lowercase hex digits.`;
    }
    return `${shown} is not a valid image entry. Use oci:<image> or oci:<image>@sha256:<digest>, in lower case.`;
  }
  const separator = text.indexOf('://');
  if (separator >= 0) {
    if (!SCHEMES.includes(text.slice(0, separator))) {
      return `${shown} uses an unsupported scheme. Use an http, https, ws or wss origin.`;
    }
    const authority = text.slice(separator + 3);
    if (['/', '?', '#', '@', '\\'].some((char) => authority.includes(char))) {
      return `${shown} is not an origin. A URL entry must be an origin, scheme://host[:port], without a path, query or user name.`;
    }
    if (authority.includes('*') && !(authority.startsWith('*.') && !authority.includes('*', 1))) {
      return `${shown} has a wildcard that is not at the start. Only a leading "*." wildcard is allowed, such as https://*.example.com.`;
    }
    return `${shown} is not a valid origin. Write scheme://host[:port], such as https://mcp.example.com.`;
  }
  return `${shown} is not an allowlist entry. Use npm:<name>, pypi:<name>, oci:<image> or an origin such as https://mcp.example.com.`;
}

// ---------------------------------------------------------------------------------------------
// forbid and permissions
// ---------------------------------------------------------------------------------------------

function checkForbid(v: Validator, value: unknown): ForbidName[] {
  const list = v.array(value, 'forbid');
  if (list === undefined) return [];
  const out: ForbidName[] = [];
  list.forEach((item, index) => {
    const at = `forbid[${index}]`;
    if (typeof item === 'string' && (FORBID_NAMES as readonly string[]).includes(item)) {
      out.push(item as ForbidName);
      return;
    }
    const guess = typeof item === 'string' ? nearest(item, FORBID_NAMES) : undefined;
    const hint = guess === undefined ? '' : ` Did you mean ${quote(guess)}?`;
    v.add(
      at,
      `unknown setting ${describe(item)}.${hint} forbid is a closed list: ${FORBID_NAMES.join(', ')}.`,
    );
  });
  return out;
}

function checkPermissions(
  v: Validator,
  value: unknown,
): { denyTools: string[]; denyCommands: string[] } {
  const empty = { denyTools: [], denyCommands: [] };
  if (value === undefined) return empty;
  const permissions = v.record(value, 'permissions');
  if (permissions === undefined) return empty;
  v.unknownFields(permissions, PERMISSION_FIELDS, 'permissions');
  const denyTools = Object.hasOwn(permissions, 'denyTools')
    ? v.strings(permissions['denyTools'], 'permissions.denyTools', (text, at) => {
        if (TOOL_NAME.test(text)) return text;
        v.add(
          at,
          `${quote(text)} is not a tool name. Give the name only, such as WebFetch; deny programs with permissions.denyCommands.`,
        );
        return undefined;
      })
    : undefined;
  const denyCommands = Object.hasOwn(permissions, 'denyCommands')
    ? v.strings(permissions['denyCommands'], 'permissions.denyCommands', (text, at) => {
        if (COMMAND_NAME.test(text)) return text.toLowerCase();
        v.add(at, `${quote(text)} is not a program name. Give the name only, such as curl.`);
        return undefined;
      })
    : undefined;
  return { denyTools: denyTools ?? [], denyCommands: denyCommands ?? [] };
}

// ---------------------------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------------------------

function checkHooks(v: Validator, value: unknown): HookRequirement[] {
  if (value === undefined) return [];
  const hooks = v.record(value, 'hooks');
  if (hooks === undefined) return [];
  v.unknownFields(hooks, HOOKS_FIELDS, 'hooks');
  if (!Object.hasOwn(hooks, 'require')) return [];
  const list = v.array(hooks['require'], 'hooks.require');
  if (list === undefined) return [];
  const out: HookRequirement[] = [];
  list.forEach((item, index) => {
    const requirement = checkRequirement(v, item, `hooks.require[${index}]`);
    if (requirement !== undefined) out.push(requirement);
  });
  return out;
}

function checkRequirement(v: Validator, value: unknown, path: string): HookRequirement | undefined {
  const record = v.record(value, path);
  if (record === undefined) return undefined;
  v.unknownFields(record, REQUIREMENT_FIELDS, path);
  let agent: HookPlatform | undefined;
  if (!Object.hasOwn(record, 'agent')) v.add(path, '"agent" is required.');
  else agent = v.choice(record['agent'], HOOK_PLATFORMS, child(path, 'agent'));

  let event: string | undefined;
  if (!Object.hasOwn(record, 'event')) v.add(path, '"event" is required.');
  else if (typeof record['event'] !== 'string') {
    v.add(child(path, 'event'), `expected a string, got ${describe(record['event'])}.`);
  } else {
    event = record['event'];
    if (agent !== undefined && !HOOK_EVENTS[agent].includes(event)) {
      v.add(child(path, 'event'), unknownEvent(agent, event));
    }
  }

  const text = (key: 'matcher' | 'script' | 'command', minLength: number): string | undefined => {
    if (!Object.hasOwn(record, key)) return undefined;
    const field = record[key];
    if (typeof field !== 'string') {
      v.add(child(path, key), `expected a string, got ${describe(field)}.`);
      return undefined;
    }
    if (field.length < minLength) v.add(child(path, key), 'must not be empty.');
    return field;
  };
  const matcher = text('matcher', 0);
  const script = text('script', 1);
  const command = text('command', 1);
  if (agent === undefined || event === undefined) return undefined;
  return {
    agent,
    event,
    ...(matcher === undefined ? {} : { matcher }),
    // `./scripts/x.sh` names the same file as the inventory's `scripts/x.sh`.
    ...(script === undefined ? {} : { script: normalizeRelative(script) ?? script }),
    ...(command === undefined ? {} : { command }),
  };
}

/** Why `event` is not one of the agent's hook events, with the nearest name when there is one. */
function unknownEvent(agent: HookPlatform, event: string): string {
  const label = platformName(agent);
  const events = HOOK_EVENTS[agent];
  const lower = event.toLowerCase();
  const guess = events.find((name) => name.toLowerCase() === lower) ?? nearest(event, events, 3);
  if (guess !== undefined) {
    return `${quote(event)} is not a ${label} hook event. Did you mean ${quote(guess)}?`;
  }
  const owner = HOOK_PLATFORMS.find((other) => HOOK_EVENTS[other].includes(event));
  if (owner !== undefined) {
    return `${quote(event)} is a ${platformName(owner)} hook event, not a ${label} one.`;
  }
  return `${quote(event)} is not a ${label} hook event.`;
}

// ---------------------------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------------------------

function isContextAgent(name: string): name is ContextAgent {
  return (CONTEXT_AGENTS as readonly string[]).includes(name);
}

function checkBudgets(v: Validator, value: unknown): Policy['budgets'] {
  if (value === undefined) return [];
  const budgets = v.record(value, 'budgets');
  if (budgets === undefined) return [];
  const out: { agent: ContextAgent; startupTokens: number }[] = [];
  for (const agent of Object.keys(budgets)) {
    const path = child('budgets', agent);
    if (!isContextAgent(agent)) {
      const guess = nearest(agent, CONTEXT_AGENTS);
      const hint = guess === undefined ? '' : ` (did you mean ${quote(child('budgets', guess))}?)`;
      v.add(
        '',
        `Unknown field ${quote(path)}${hint}. ${UNKNOWN_FIELD_REASON} Budgets apply to agents with a load model: ${CONTEXT_AGENTS.join(', ')}.`,
      );
      continue;
    }
    const budget = v.record(budgets[agent], path);
    if (budget === undefined) continue;
    v.unknownFields(budget, BUDGET_FIELDS, path);
    if (!Object.hasOwn(budget, 'startupTokens')) {
      v.add(path, '"startupTokens" is required.');
      continue;
    }
    const tokens = budget['startupTokens'];
    if (
      typeof tokens !== 'number' ||
      !Number.isInteger(tokens) ||
      tokens < 1 ||
      tokens > MAX_STARTUP_TOKENS
    ) {
      v.add(
        child(path, 'startupTokens'),
        `expected a whole number from 1 to ${formatInteger(MAX_STARTUP_TOKENS)}, got ${describe(tokens)}.`,
      );
      continue;
    }
    out.push({ agent, startupTokens: tokens });
  }
  // CONTEXT_AGENTS order, so the policy's key order changes nothing.
  return out.sort((a, b) => CONTEXT_AGENTS.indexOf(a.agent) - CONTEXT_AGENTS.indexOf(b.agent));
}
