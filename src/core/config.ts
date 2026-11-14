import picomatch from 'picomatch';
import { similarRuleIds } from './directive-fixes.js';
import { CONFIG_FILE_NAME } from './meta.js';
import {
  PLATFORM_IDS,
  type PlatformId,
  type RuleMeta,
  type RuleOptionMeta,
  type Severity,
} from './types.js';

/**
 * User configuration, read from `agentcheckup.config.json`. JSON only: agentcheckup never executes
 * code from the repository it scans, so JS/TS config files are deliberately unsupported.
 *
 * The validator is hand-written (the schema is small, and a validation library would be most of
 * the bundle). CONFIG_JSON_SCHEMA describes the same shape for editors; a property test checks
 * that both accept and reject exactly the same documents.
 */

export const SEVERITY_SETTINGS = ['off', 'info', 'warn', 'error'] as const;
export type SeveritySetting = (typeof SEVERITY_SETTINGS)[number];
export type RuleSettingInput =
  SeveritySetting | readonly [SeveritySetting, Readonly<Record<string, unknown>>];

export interface UserConfig {
  readonly $schema?: string;
  readonly targets?: readonly PlatformId[];
  readonly rules?: Readonly<Record<string, RuleSettingInput>>;
  readonly ignore?: readonly string[];
  readonly overrides?: readonly {
    readonly files: readonly string[];
    readonly rules: Readonly<Record<string, SeveritySetting>>;
  }[];
}

export interface RuleSettingResolved {
  readonly severity: Severity | 'off';
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface ResolvedConfig {
  readonly targets: readonly PlatformId[] | undefined;
  readonly isIgnored: (path: string) => boolean;
  /** Effective setting for a rule on a path, or undefined to use the rule's defaults. */
  readonly ruleSetting: (ruleId: string, path: string) => RuleSettingResolved | undefined;
  /** Rule ids mentioned anywhere in the config, for unknown-rule validation. */
  readonly referencedRuleIds: readonly string[];
}

/**
 * A configuration that cannot be used: exit code 2 in the CLI. `lines` holds the message one
 * line per entry, so that a caller can sanitize each line on its own and keep the line breaks;
 * values quoted from the configuration never contain one.
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly lines: readonly string[];

  constructor(message: string | readonly string[], options?: ErrorOptions) {
    const lines = typeof message === 'string' ? [message] : [...message];
    super(lines.join('\n'), options);
    this.lines = lines;
  }
}

// ---------------------------------------------------------------------------------------------
// JSON Schema (draft 2020-12), published as schemas/config.schema.json
// ---------------------------------------------------------------------------------------------

const severitySchema = { enum: [...SEVERITY_SETTINGS] } as const;

export const CONFIG_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    targets: {
      description: 'Agents to check against. Default: all supported agents.',
      type: 'array',
      minItems: 1,
      items: { enum: [...PLATFORM_IDS] },
    },
    rules: {
      description: 'Severity, or [severity, options], per rule id.',
      type: 'object',
      additionalProperties: {
        anyOf: [
          severitySchema,
          {
            type: 'array',
            prefixItems: [severitySchema, { type: 'object' }],
            minItems: 2,
            maxItems: 2,
          },
        ],
      },
    },
    ignore: {
      description: 'Globs, relative to the scanned directory, of files to skip.',
      type: 'array',
      items: { type: 'string' },
    },
    overrides: {
      description: 'Severity changes for files matching `files`. Later entries win.',
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['files', 'rules'],
        properties: {
          files: { type: 'array', minItems: 1, items: { type: 'string' } },
          rules: { type: 'object', additionalProperties: severitySchema },
        },
      },
    },
  },
} as const;

/** The JSON Schema of each option type, as {@link OPTION_TYPES} checks it. */
const OPTION_SCHEMAS: Readonly<Record<RuleOptionMeta['type'], Record<string, unknown>>> = {
  'positive-integer': { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
};

/** The JSON Schema of one option. */
function optionSchema(option: RuleOptionMeta): Record<string, unknown> {
  return { description: option.description, ...OPTION_SCHEMAS[option.type] };
}

/**
 * {@link CONFIG_JSON_SCHEMA} with a property for each rule in `rules`: its title, and the options
 * it takes, so that an editor completes rule ids and flags an option the rule does not take or a
 * value of the wrong type, as {@link validateConfig} with `rules` does. Ids not in `rules` keep
 * the generic shape: an unknown rule id is only a warning. Published as
 * schemas/config.schema.json.
 */
export function configJsonSchema(rules: readonly RuleMeta[]): Record<string, unknown> {
  const severity = { $ref: '#/$defs/severity' };
  const properties: Record<string, unknown> = {};
  for (const meta of [...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const options = Object.entries(meta.options ?? {});
    properties[meta.id] =
      options.length === 0
        ? { description: meta.title, $ref: '#/$defs/ruleWithoutOptions' }
        : {
            description: meta.title,
            anyOf: [
              severity,
              {
                type: 'array',
                prefixItems: [
                  severity,
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: Object.fromEntries(
                      options.map(([name, option]) => [name, optionSchema(option)]),
                    ),
                  },
                ],
                minItems: 2,
                maxItems: 2,
              },
            ],
          };
  }
  return {
    ...CONFIG_JSON_SCHEMA,
    properties: {
      ...CONFIG_JSON_SCHEMA.properties,
      rules: { ...CONFIG_JSON_SCHEMA.properties.rules, properties },
    },
    $defs: {
      severity: severitySchema,
      ruleWithoutOptions: {
        anyOf: [
          severity,
          {
            type: 'array',
            prefixItems: [severity, { type: 'object', additionalProperties: false }],
            minItems: 2,
            maxItems: 2,
          },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

type Issues = string[];

const describe = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return typeof value;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSeverity = (value: unknown): value is SeveritySetting =>
  typeof value === 'string' && (SEVERITY_SETTINGS as readonly string[]).includes(value);

/** Copies own keys into a null-prototype object, so `__proto__` is just a key. */
function ownEntries(value: Record<string, unknown>): [string, unknown][] {
  return Object.keys(value).map((key) => [key, value[key]]);
}

function nullProto<T>(entries: Iterable<[string, T]>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, entry] of entries) out[key] = entry;
  return out;
}

function stringArray(
  value: unknown,
  path: string,
  issues: Issues,
  minItems = 0,
): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(`${path}: expected an array of strings, got ${describe(value)}.`);
    return undefined;
  }
  if (value.length < minItems)
    issues.push(`${path}: needs at least ${minItems} entr${minItems === 1 ? 'y' : 'ies'}.`);
  const out: string[] = [];
  value.forEach((item: unknown, index) => {
    if (typeof item === 'string') out.push(item);
    else issues.push(`${path}[${index}]: expected a string, got ${describe(item)}.`);
  });
  return out;
}

/** Each option type: what a value must be, in words for the issue, and the check. */
const OPTION_TYPES: Readonly<
  Record<RuleOptionMeta['type'], { readonly expected: string; ok(value: unknown): boolean }>
> = {
  'positive-integer': {
    expected: 'a positive integer',
    ok: (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
  },
};

/**
 * Problems with the options a configuration gives a rule, against the options its metadata
 * declares (`RuleMeta.options`): an option the rule does not take, or a value of the wrong type.
 * `path` locates the options in the configuration, such as `rules["instr/claude-md-too-long"]`.
 */
export function ruleOptionIssues(
  meta: Pick<RuleMeta, 'id' | 'options'>,
  options: Readonly<Record<string, unknown>> | undefined,
  path = `rules["${meta.id}"]`,
): string[] {
  if (options === undefined) return [];
  const declared = meta.options ?? {};
  const names = Object.keys(declared);
  const issues: string[] = [];
  for (const key of Object.keys(options)) {
    const option = Object.hasOwn(declared, key) ? declared[key] : undefined;
    if (option === undefined) {
      issues.push(
        names.length === 0
          ? `${path}: unknown option "${key}". ${meta.id} takes no options.`
          : `${path}: unknown option "${key}". ${meta.id} takes ${names.map((name) => `"${name}"`).join(', ')}.`,
      );
      continue;
    }
    const value = options[key];
    const type = OPTION_TYPES[option.type];
    if (!type.ok(value))
      issues.push(`${path}.${key}: expected ${type.expected}, got ${describe(value)}.`);
  }
  return issues;
}

/** `rules["…"]` entries that name no rule in `known`, with the closest id when there is one. */
function unknownRuleIssues(ids: readonly string[], known: ReadonlySet<string>): string[] {
  return ids
    .filter((id) => !known.has(id))
    .map((id) => {
      const [similar, other] = similarRuleIds(id, known);
      const hint =
        similar !== undefined && other === undefined ? ` Did you mean "${similar}"?` : '';
      return `rules["${id}"]: unknown rule (alone, only a warning).${hint}`;
    });
}

function ruleSettingInput(
  value: unknown,
  path: string,
  issues: Issues,
): RuleSettingInput | undefined {
  if (isSeverity(value)) return value;
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    isSeverity(value[0]) &&
    isPlainObject(value[1])
  ) {
    return [value[0], nullProto(ownEntries(value[1]))];
  }
  issues.push(
    `${path}: expected one of ${SEVERITY_SETTINGS.map((s) => `"${s}"`).join(', ')}, or [severity, options], got ${describe(value)}.`,
  );
  return undefined;
}

/**
 * Validates parsed JSON. Returns the issues instead of throwing, for tests and editors.
 *
 * With `rules`, the metadata of every rule there is, it also checks the options of each rule
 * against the options it declares, and, when the configuration has another issue, lists the
 * rule ids it does not know too: alone, an unknown rule id is only a warning (the scan's
 * `configWarnings`), but an error message that left them out would hide them.
 */
export function validateConfig(
  raw: unknown,
  rules?: readonly RuleMeta[],
): { config?: UserConfig; issues: readonly string[] } {
  const result = validateShape(raw);
  if (rules === undefined) return withoutInvalid(result);
  const metas = new Map(rules.map((meta) => [meta.id, meta]));
  const issues = [...result.issues];
  const settings: Readonly<Record<string, RuleSettingInput>> = result.config?.rules ?? {};
  for (const id of Object.keys(settings)) {
    const meta = metas.get(id);
    const setting = settings[id];
    if (meta === undefined || typeof setting !== 'object') continue;
    issues.push(...ruleOptionIssues(meta, setting[1]));
  }
  if (issues.length === 0) return withoutInvalid(result);
  const referenced = new Set(Object.keys(settings));
  for (const override of result.config?.overrides ?? []) {
    for (const id of Object.keys(override.rules)) referenced.add(id);
  }
  issues.push(...unknownRuleIssues([...referenced], new Set(metas.keys())));
  return { issues };
}

/** The configuration only when there is no issue. */
function withoutInvalid(result: { config?: UserConfig; issues: readonly string[] }): {
  config?: UserConfig;
  issues: readonly string[];
} {
  return result.issues.length === 0 ? result : { issues: result.issues };
}

/** The shape check: the issues, and the configuration as far as it is valid. */
function validateShape(raw: unknown): { config?: UserConfig; issues: readonly string[] } {
  const issues: Issues = [];
  if (!isPlainObject(raw)) return { issues: [`expected a JSON object, got ${describe(raw)}.`] };

  const config: {
    $schema?: string;
    targets?: PlatformId[];
    rules?: Record<string, RuleSettingInput>;
    ignore?: string[];
    overrides?: { files: string[]; rules: Record<string, SeveritySetting> }[];
  } = {};

  for (const [key, value] of ownEntries(raw)) {
    switch (key) {
      case '$schema':
        if (typeof value === 'string') config.$schema = value;
        else issues.push(`$schema: expected a string, got ${describe(value)}.`);
        break;
      case 'targets': {
        const list = stringArray(value, 'targets', issues, 1);
        if (list === undefined) break;
        const targets: PlatformId[] = [];
        list.forEach((id, index) => {
          if ((PLATFORM_IDS as readonly string[]).includes(id)) targets.push(id as PlatformId);
          else
            issues.push(
              `targets[${index}]: unknown platform ${describe(id)}. Use one of: ${PLATFORM_IDS.join(', ')}.`,
            );
        });
        config.targets = targets;
        break;
      }
      case 'rules': {
        if (!isPlainObject(value)) {
          issues.push(`rules: expected an object, got ${describe(value)}.`);
          break;
        }
        const entries: [string, RuleSettingInput][] = [];
        for (const [id, setting] of ownEntries(value)) {
          const parsed = ruleSettingInput(setting, `rules["${id}"]`, issues);
          if (parsed !== undefined) entries.push([id, parsed]);
        }
        config.rules = nullProto(entries);
        break;
      }
      case 'ignore': {
        const list = stringArray(value, 'ignore', issues);
        if (list !== undefined) config.ignore = list;
        break;
      }
      case 'overrides': {
        if (!Array.isArray(value)) {
          issues.push(`overrides: expected an array, got ${describe(value)}.`);
          break;
        }
        const overrides: { files: string[]; rules: Record<string, SeveritySetting> }[] = [];
        value.forEach((entry: unknown, index) => {
          const path = `overrides[${index}]`;
          if (!isPlainObject(entry)) {
            issues.push(`${path}: expected an object, got ${describe(entry)}.`);
            return;
          }
          for (const key of Object.keys(entry)) {
            if (key !== 'files' && key !== 'rules') issues.push(`${path}: unknown field "${key}".`);
          }
          if (!('files' in entry)) issues.push(`${path}: "files" is required.`);
          if (!('rules' in entry)) issues.push(`${path}: "rules" is required.`);
          const files =
            'files' in entry ? stringArray(entry['files'], `${path}.files`, issues, 1) : undefined;
          const rulesValue = entry['rules'];
          const rules: [string, SeveritySetting][] = [];
          if ('rules' in entry) {
            if (!isPlainObject(rulesValue)) {
              issues.push(`${path}.rules: expected an object, got ${describe(rulesValue)}.`);
            } else {
              for (const [id, setting] of ownEntries(rulesValue)) {
                if (isSeverity(setting)) rules.push([id, setting]);
                else
                  issues.push(
                    `${path}.rules["${id}"]: overrides set severity only; expected one of ${SEVERITY_SETTINGS.map((s) => `"${s}"`).join(', ')}, got ${describe(setting)}.`,
                  );
              }
            }
          }
          if (files !== undefined) overrides.push({ files, rules: nullProto(rules) });
        });
        config.overrides = overrides;
        break;
      }
      default:
        issues.push(`unknown field "${key}". Allowed: $schema, targets, rules, ignore, overrides.`);
    }
  }
  return { config, issues };
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

const GLOB_OPTIONS = { dot: true, windows: false } as const;

function toResolved(setting: RuleSettingInput): RuleSettingResolved {
  if (typeof setting === 'string') return { severity: setting };
  return { severity: setting[0], options: setting[1] };
}

/**
 * Validates parsed JSON and compiles globs. Throws ConfigError with a readable message. With
 * `rules`, the metadata of every rule, it also checks rule options ({@link validateConfig}).
 */
export function resolveConfig(
  raw: unknown,
  source = CONFIG_FILE_NAME,
  rules?: readonly RuleMeta[],
): ResolvedConfig {
  const { config, issues } = validateConfig(raw, rules);
  if (config === undefined) {
    throw new ConfigError([`Invalid ${source}:`, ...issues.map((issue) => `  - ${issue}`)]);
  }

  const ignoreMatchers = (config.ignore ?? []).map((glob) => picomatch(glob, GLOB_OPTIONS));
  const overrides = (config.overrides ?? []).map((override) => ({
    matches: picomatch([...override.files], GLOB_OPTIONS),
    rules: override.rules,
  }));
  const baseRules = config.rules ?? nullProto<RuleSettingInput>([]);

  const referenced = new Set<string>(Object.keys(baseRules));
  for (const override of config.overrides ?? []) {
    for (const id of Object.keys(override.rules)) referenced.add(id);
  }

  return {
    targets: config.targets,
    isIgnored: (path) => ignoreMatchers.some((matches) => matches(path)),
    ruleSetting: (ruleId, path) => {
      const base = Object.hasOwn(baseRules, ruleId) ? baseRules[ruleId] : undefined;
      let resolved = base === undefined ? undefined : toResolved(base);
      for (const override of overrides) {
        const severity = Object.hasOwn(override.rules, ruleId) ? override.rules[ruleId] : undefined;
        if (severity !== undefined && override.matches(path)) {
          resolved =
            resolved?.options === undefined
              ? { severity }
              : { severity, options: resolved.options };
        }
      }
      return resolved;
    },
    referencedRuleIds: [...referenced].sort(),
  };
}

export const EMPTY_CONFIG: ResolvedConfig = resolveConfig({});
