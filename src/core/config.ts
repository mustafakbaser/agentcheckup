import picomatch from 'picomatch';
import { CONFIG_FILE_NAME } from './meta.js';
import { PLATFORM_IDS, type PlatformId, type Severity } from './types.js';

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

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
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

/** Validates parsed JSON. Returns the issues instead of throwing, for tests and editors. */
export function validateConfig(raw: unknown): { config?: UserConfig; issues: readonly string[] } {
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
  return issues.length === 0 ? { config, issues } : { issues };
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

const GLOB_OPTIONS = { dot: true, windows: false } as const;

function toResolved(setting: RuleSettingInput): RuleSettingResolved {
  if (typeof setting === 'string') return { severity: setting };
  return { severity: setting[0], options: setting[1] };
}

/** Validates parsed JSON and compiles globs. Throws ConfigError with a readable message. */
export function resolveConfig(raw: unknown, source = CONFIG_FILE_NAME): ResolvedConfig {
  const { config, issues } = validateConfig(raw);
  if (config === undefined) {
    throw new ConfigError(
      `Invalid ${source}:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
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
