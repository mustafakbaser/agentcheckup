/**
 * Validates the part of a JSON report that `--baseline` reads. Pure: src/io reads the file and
 * parses it with JSON.parse into null-prototype objects; this module checks the shape and returns
 * a typed {@link BaselineReport} or one precise error.
 *
 * The baseline is untrusted input (docs/adr/0003):
 * - Only own properties are read (`Object.hasOwn`), so `__proto__` and `constructor` are ordinary
 *   keys and nothing is inherited from a prototype.
 * - Results are built here with fixed keys. The only input strings used as property names are
 *   validated platform ids.
 * - Nesting follows the fixed report shape, so the checks never recurse on input depth, and the
 *   work is linear in the input size.
 * - Error messages name the field and the JSON type found. They never echo input text.
 *
 * Fields the comparison does not use are not checked, and unknown fields are ignored.
 */
import type {
  EnvItem,
  HookItem,
  Inventory,
  McpServerItem,
  PackageSpec,
  PermissionItem,
} from '../inventory/types.js';
import { CONTEXT_AGENTS, type ContextAgent } from '../platforms/load/types.js';
import { FINGERPRINT_VERSION, REPORT_SCHEMA_VERSION } from './meta.js';
import { type Finding, PLATFORM_IDS, type PlatformId } from './types.js';

/** Report schema versions a baseline may have. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [REPORT_SCHEMA_VERSION];

export type BaselineFinding = Pick<Finding, 'ruleId' | 'path' | 'fingerprint'>;

/** The load-entry fields a plan comparison reads. A LoadEntry is assignable to it. */
export interface BaselineLoadEntry {
  readonly id: string;
  readonly path: string;
  readonly trigger: string;
  readonly certainty: string;
  readonly size?: { readonly chars: number };
  readonly truncated?: { readonly atByte: number; readonly line: number };
}

/** The skipped-load fields a plan comparison reads. A SkippedLoad is assignable to it. */
export interface BaselineSkippedLoad {
  readonly id: string;
  readonly path: string;
  readonly code: string;
  readonly ruleId?: string;
  readonly certainty: string;
}

/** The limit-usage fields a plan comparison reads. A LimitUsage is assignable to it. */
export interface BaselineLimitUsage {
  readonly key: string;
  readonly subject: string;
  readonly label?: string;
  readonly used: number;
  readonly limit: number | null;
}

/** The load-plan fields a plan comparison reads. A LoadPlan is assignable to it. */
export interface BaselinePlan {
  readonly agent: ContextAgent;
  readonly cwd: string;
  readonly entries: readonly BaselineLoadEntry[];
  readonly skipped: readonly BaselineSkippedLoad[];
  readonly limits: readonly BaselineLimitUsage[];
  readonly totals: { readonly startup: { readonly tokens: number } };
}

/**
 * The subset of a report that a baseline comparison reads. A ScanResult is assignable to it, so
 * a scan can also serve as a baseline directly.
 */
export interface BaselineReport {
  readonly schemaVersion: number;
  readonly tool: { readonly name: string; readonly version: string };
  readonly ruleset: string;
  /**
   * How the report's fingerprints were computed. `validateBaseline` accepts only
   * FINGERPRINT_VERSION, and reads a report without the field as version 1.
   */
  readonly fingerprintVersion?: number;
  /** The prefix the report's paths carry, as in ScanResult. Absent means none. */
  readonly pathBase?: string;
  readonly findings: readonly BaselineFinding[];
  /** Absent in reports made before the inventory existed. */
  readonly inventory?: Inventory;
  /** Plans for agents this version does not model are left out. */
  readonly context?: { readonly plans: readonly BaselinePlan[] };
}

/**
 * - `unsupported-schema`: a report, but with a schema version this agentcheckup cannot read, or
 *   fingerprints from another fingerprint version, which no finding of this version would match.
 * - `invalid`: not a report, or a field has the wrong shape.
 * Both make the CLI exit with code 2.
 */
export type BaselineValidation =
  | { readonly ok: true; readonly baseline: BaselineReport }
  | {
      readonly ok: false;
      readonly reason: 'unsupported-schema' | 'invalid';
      readonly message: string;
    };

/** Checks a parsed JSON report for use as a baseline. Never throws on bad input. */
export function validateBaseline(value: unknown): BaselineValidation {
  try {
    return { ok: true, baseline: readReport(value) };
  } catch (error) {
    if (error instanceof BaselineError) {
      return { ok: false, reason: error.reason, message: error.message };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------------

class BaselineError extends Error {
  readonly reason: 'unsupported-schema' | 'invalid';

  constructor(reason: 'unsupported-schema' | 'invalid', message: string) {
    super(message);
    this.reason = reason;
  }
}

type JsonObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(object: JsonObject, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? 'a number' : 'a number out of range';
  }
  if (typeof value === 'boolean') return 'a boolean';
  // JSON has no other types; anything else is a caller bug, named by its type.
  return typeof value === 'object' ? 'an object' : typeof value;
}

function fail(at: string, expected: string, value: unknown): never {
  throw new BaselineError(
    'invalid',
    value === undefined
      ? `Baseline report: ${at} is missing; expected ${expected}.`
      : `Baseline report: ${at} must be ${expected}, not ${describe(value)}.`,
  );
}

const field = (at: string, key: string): string => (at === '' ? key : `${at}.${key}`);

function object(value: unknown, at: string): JsonObject {
  return isObject(value) ? value : fail(at, 'an object', value);
}

function array(value: unknown, at: string): readonly unknown[] {
  return Array.isArray(value) ? value : fail(at, 'an array', value);
}

function string(value: unknown, at: string): string {
  return typeof value === 'string' ? value : fail(at, 'a string', value);
}

function boolean(value: unknown, at: string): boolean {
  return typeof value === 'boolean' ? value : fail(at, 'true or false', value);
}

function finite(value: unknown, at: string): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fail(at, 'a number', value);
}

function count(value: unknown, at: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fail(at, 'a non-negative integer', value);
}

function oneOf<T extends string>(
  value: unknown,
  at: string,
  allowed: Readonly<Record<T, true>>,
): T {
  if (typeof value === 'string' && Object.hasOwn(allowed, value)) return value as T;
  return fail(at, `one of ${Object.keys(allowed).join(', ')}`, value);
}

function strings(value: unknown, at: string): string[] {
  const list = array(value, at);
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) out.push(string(list[i], `${at}[${i}]`));
  return out;
}

/** Reads optional `key` with `read`; absent stays absent. JSON null is not "absent". */
function optional<T>(
  source: JsonObject,
  key: string,
  at: string,
  read: (value: unknown, at: string) => T,
): T | undefined {
  const value = own(source, key);
  return value === undefined ? undefined : read(value, field(at, key));
}

function list<T>(value: unknown, at: string, read: (value: unknown, at: string) => T): T[] {
  const items = array(value, at);
  const out: T[] = [];
  for (let i = 0; i < items.length; i++) out.push(read(items[i], `${at}[${i}]`));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

function readReport(value: unknown): BaselineReport {
  if (!isObject(value)) {
    throw new BaselineError(
      'invalid',
      `Baseline report: expected a JSON report from agentcheckup --format json (an object), not ${describe(value)}.`,
    );
  }
  const version = own(value, 'schemaVersion');
  if (version === undefined) {
    throw new BaselineError(
      'invalid',
      'Baseline report: schemaVersion is missing; expected a JSON report from agentcheckup --format json.',
    );
  }
  const schemaVersion = finite(version, 'schemaVersion');
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
    throw new BaselineError(
      'unsupported-schema',
      `Baseline report: schema version ${String(schemaVersion)} is not supported; this agentcheckup reads version ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}. Create the baseline with the same agentcheckup version.`,
    );
  }

  // Findings match by fingerprint: with another scheme, every finding would look new and every
  // baseline finding resolved, so refuse instead of failing the run on findings nobody added.
  const fingerprintVersion = optional(value, 'fingerprintVersion', '', finite) ?? 1;
  if (fingerprintVersion !== FINGERPRINT_VERSION) {
    throw new BaselineError(
      'unsupported-schema',
      `Baseline report: its finding fingerprints have version ${String(fingerprintVersion)}, and this agentcheckup computes version ${String(FINGERPRINT_VERSION)}, so no finding could be matched. Create the baseline again with this agentcheckup version.`,
    );
  }

  const tool = object(own(value, 'tool'), 'tool');
  const pathBase = optional(value, 'pathBase', '', string);
  const inventory = optional(value, 'inventory', '', readInventory);
  const context = optional(value, 'context', '', readContext);
  return {
    schemaVersion,
    tool: {
      name: string(own(tool, 'name'), 'tool.name'),
      version: string(own(tool, 'version'), 'tool.version'),
    },
    ruleset: string(own(value, 'ruleset'), 'ruleset'),
    fingerprintVersion,
    ...(pathBase === undefined ? {} : { pathBase }),
    findings: list(own(value, 'findings'), 'findings', readFinding),
    ...(inventory === undefined ? {} : { inventory }),
    ...(context === undefined ? {} : { context }),
  };
}

function readFinding(value: unknown, at: string): BaselineFinding {
  const source = object(value, at);
  return {
    ruleId: string(own(source, 'ruleId'), field(at, 'ruleId')),
    path: string(own(source, 'path'), field(at, 'path')),
    fingerprint: string(own(source, 'fingerprint'), field(at, 'fingerprint')),
  };
}

// ---------------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------------

const PLATFORMS: Readonly<Record<PlatformId, true>> = Object.fromEntries(
  PLATFORM_IDS.map((id) => [id, true]),
) as Record<PlatformId, true>;

const TRANSPORTS: Readonly<Record<McpServerItem['transport'], true>> = {
  stdio: true,
  http: true,
  sse: true,
  ws: true,
  unknown: true,
};

const LAUNCHERS: Readonly<Record<PackageSpec['launcher'], true>> = {
  npx: true,
  'pnpm-dlx': true,
  bunx: true,
  'yarn-dlx': true,
  uvx: true,
  pipx: true,
  docker: true,
  local: true,
  unknown: true,
};

const ECOSYSTEMS: Readonly<Record<NonNullable<PackageSpec['ecosystem']>, true>> = {
  npm: true,
  pypi: true,
  oci: true,
};

const PINS: Readonly<Record<PackageSpec['pin'], true>> = {
  exact: true,
  digest: true,
  range: true,
  tag: true,
  none: true,
  local: true,
  unknown: true,
};

type ServerStatus = NonNullable<McpServerItem['status'][PlatformId]>;
const STATUSES: Readonly<Record<ServerStatus, true>> = {
  loads: true,
  'needs-approval': true,
  skipped: true,
};

const ENV_CLASSES: Readonly<Record<EnvItem['class'], true>> = {
  endpoint: true,
  credential: true,
  tls: true,
  'code-exec': true,
  other: true,
};

function readInventory(value: unknown, at: string): Inventory {
  const source = object(value, at);
  return {
    mcpServers: list(own(source, 'mcpServers'), field(at, 'mcpServers'), readServer),
    hooks: list(own(source, 'hooks'), field(at, 'hooks'), readHook),
    permissions: list(own(source, 'permissions'), field(at, 'permissions'), readPermission),
    env: list(own(source, 'env'), field(at, 'env'), readEnv),
    incomplete: strings(own(source, 'incomplete'), field(at, 'incomplete')),
  };
}

interface ItemBaseFields {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly platforms: readonly PlatformId[];
  readonly digest: string;
}

function readItemBase(source: JsonObject, at: string): ItemBaseFields {
  return {
    id: string(own(source, 'id'), field(at, 'id')),
    file: string(own(source, 'file'), field(at, 'file')),
    line: count(own(source, 'line'), field(at, 'line')),
    platforms: list(own(source, 'platforms'), field(at, 'platforms'), (item, path) =>
      oneOf(item, path, PLATFORMS),
    ),
    digest: string(own(source, 'digest'), field(at, 'digest')),
  };
}

function readServer(value: unknown, at: string): McpServerItem {
  const source = object(value, at);
  const declaredType = optional(source, 'declaredType', at, string);
  const command = optional(source, 'command', at, string);
  const args = optional(source, 'args', at, strings);
  const spec = optional(source, 'package', at, readPackage);
  const url = optional(source, 'url', at, readUrl);
  return {
    ...readItemBase(source, at),
    name: string(own(source, 'name'), field(at, 'name')),
    transport: oneOf(own(source, 'transport'), field(at, 'transport'), TRANSPORTS),
    ...(declaredType === undefined ? {} : { declaredType }),
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(spec === undefined ? {} : { package: spec }),
    ...(url === undefined ? {} : { url }),
    envKeys: strings(own(source, 'envKeys'), field(at, 'envKeys')),
    headerKeys: strings(own(source, 'headerKeys'), field(at, 'headerKeys')),
    status: readStatus(own(source, 'status'), field(at, 'status')),
  };
}

function readPackage(value: unknown, at: string): PackageSpec {
  const source = object(value, at);
  const ecosystem = optional(source, 'ecosystem', at, (item, path) =>
    oneOf(item, path, ECOSYSTEMS),
  );
  const name = optional(source, 'name', at, string);
  const version = optional(source, 'version', at, string);
  return {
    launcher: oneOf(own(source, 'launcher'), field(at, 'launcher'), LAUNCHERS),
    ...(ecosystem === undefined ? {} : { ecosystem }),
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
    pin: oneOf(own(source, 'pin'), field(at, 'pin'), PINS),
  };
}

function readUrl(value: unknown, at: string): NonNullable<McpServerItem['url']> {
  const source = object(value, at);
  return {
    origin: string(own(source, 'origin'), field(at, 'origin')),
    tls: boolean(own(source, 'tls'), field(at, 'tls')),
    loopback: boolean(own(source, 'loopback'), field(at, 'loopback')),
  };
}

function readStatus(value: unknown, at: string): McpServerItem['status'] {
  const source = object(value, at);
  const status: Partial<Record<PlatformId, ServerStatus>> = {};
  for (const key of Object.keys(source)) {
    // Validated before use as a property name, so `__proto__` and friends never get here.
    const platform = oneOf(key, `a key of ${at}`, PLATFORMS);
    status[platform] = oneOf(source[key], field(at, platform), STATUSES);
  }
  return status;
}

function readHook(value: unknown, at: string): HookItem {
  const source = object(value, at);
  const matcher = optional(source, 'matcher', at, string);
  const type = optional(source, 'type', at, string);
  const command = optional(source, 'command', at, string);
  const script = optional(source, 'script', at, string);
  return {
    ...readItemBase(source, at),
    event: string(own(source, 'event'), field(at, 'event')),
    known: boolean(own(source, 'known'), field(at, 'known')),
    ...(matcher === undefined ? {} : { matcher }),
    ...(type === undefined ? {} : { type }),
    ...(command === undefined ? {} : { command }),
    ...(script === undefined ? {} : { script }),
    failsOpen: boolean(own(source, 'failsOpen'), field(at, 'failsOpen')),
    remoteScript: boolean(own(source, 'remoteScript'), field(at, 'remoteScript')),
  };
}

function readPermission(value: unknown, at: string): PermissionItem {
  const source = object(value, at);
  return {
    ...readItemBase(source, at),
    key: string(own(source, 'key'), field(at, 'key')),
    value: string(own(source, 'value'), field(at, 'value')),
    broad: boolean(own(source, 'broad'), field(at, 'broad')),
    effective: boolean(own(source, 'effective'), field(at, 'effective')),
  };
}

function readEnv(value: unknown, at: string): EnvItem {
  const source = object(value, at);
  const shown = optional(source, 'shown', at, string);
  return {
    ...readItemBase(source, at),
    key: string(own(source, 'key'), field(at, 'key')),
    class: oneOf(own(source, 'class'), field(at, 'class'), ENV_CLASSES),
    ...(shown === undefined ? {} : { shown }),
  };
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

const AGENTS: ReadonlySet<string> = new Set(CONTEXT_AGENTS);

function isContextAgent(value: string): value is ContextAgent {
  return AGENTS.has(value);
}

function readContext(value: unknown, at: string): { readonly plans: readonly BaselinePlan[] } {
  const source = object(value, at);
  const items = array(own(source, 'plans'), field(at, 'plans'));
  const plans: BaselinePlan[] = [];
  for (let i = 0; i < items.length; i++) {
    const plan = readPlan(items[i], `${field(at, 'plans')}[${i}]`);
    if (plan !== undefined) plans.push(plan);
  }
  return { plans };
}

function readPlan(value: unknown, at: string): BaselinePlan | undefined {
  const source = object(value, at);
  const agent = string(own(source, 'agent'), field(at, 'agent'));
  // A plan for an agent this version does not model has nothing to be compared with.
  if (!isContextAgent(agent)) return undefined;
  const totals = object(own(source, 'totals'), field(at, 'totals'));
  const startup = object(own(totals, 'startup'), field(at, 'totals.startup'));
  return {
    agent,
    cwd: string(own(source, 'cwd'), field(at, 'cwd')),
    entries: list(own(source, 'entries'), field(at, 'entries'), readEntry),
    skipped: list(own(source, 'skipped'), field(at, 'skipped'), readSkipped),
    limits: list(own(source, 'limits'), field(at, 'limits'), readLimit),
    totals: {
      startup: { tokens: count(own(startup, 'tokens'), field(at, 'totals.startup.tokens')) },
    },
  };
}

function readEntry(value: unknown, at: string): BaselineLoadEntry {
  const source = object(value, at);
  const size = optional(source, 'size', at, (item, path) => ({
    chars: count(own(object(item, path), 'chars'), field(path, 'chars')),
  }));
  const truncated = optional(source, 'truncated', at, (item, path) => {
    const cut = object(item, path);
    return {
      atByte: count(own(cut, 'atByte'), field(path, 'atByte')),
      line: count(own(cut, 'line'), field(path, 'line')),
    };
  });
  return {
    id: string(own(source, 'id'), field(at, 'id')),
    path: string(own(source, 'path'), field(at, 'path')),
    trigger: string(own(source, 'trigger'), field(at, 'trigger')),
    certainty: string(own(source, 'certainty'), field(at, 'certainty')),
    ...(size === undefined ? {} : { size }),
    ...(truncated === undefined ? {} : { truncated }),
  };
}

function readSkipped(value: unknown, at: string): BaselineSkippedLoad {
  const source = object(value, at);
  const ruleId = optional(source, 'ruleId', at, string);
  return {
    id: string(own(source, 'id'), field(at, 'id')),
    path: string(own(source, 'path'), field(at, 'path')),
    code: string(own(source, 'code'), field(at, 'code')),
    ...(ruleId === undefined ? {} : { ruleId }),
    certainty: string(own(source, 'certainty'), field(at, 'certainty')),
  };
}

function readLimit(value: unknown, at: string): BaselineLimitUsage {
  const source = object(value, at);
  const limit = own(source, 'limit');
  const label = optional(source, 'label', at, string);
  return {
    key: string(own(source, 'key'), field(at, 'key')),
    subject: string(own(source, 'subject'), field(at, 'subject')),
    ...(label === undefined ? {} : { label }),
    used: finite(own(source, 'used'), field(at, 'used')),
    limit: limit === null ? null : finite(limit, field(at, 'limit')),
  };
}
