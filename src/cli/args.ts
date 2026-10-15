import { parseArgs } from 'node:util';
import { PLATFORM_IDS, type PlatformId, type Severity } from '../core/types.js';

export const OUTPUT_FORMATS = ['stylish', 'json', 'sarif', 'github', 'markdown', 'badge'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export type FailOn = Severity | 'none';

export type Command =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'rules'; readonly format: 'text' | 'json' }
  | { readonly kind: 'explain'; readonly ruleId: string }
  | { readonly kind: 'scan'; readonly options: ScanCommandOptions };

export interface ScanCommandOptions {
  readonly path: string;
  readonly format: OutputFormat;
  readonly output: string | undefined;
  readonly targets: readonly PlatformId[] | undefined;
  readonly failOn: FailOn;
  readonly minScore: number | undefined;
  readonly config: string | undefined;
  readonly useConfig: boolean;
  readonly untrusted: boolean;
  readonly gitignore: boolean;
  readonly showSuppressed: boolean;
  readonly color: boolean | undefined;
}

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

const FAIL_ON = ['error', 'warn', 'info', 'none'] as const;

function oneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(`${flag} must be one of: ${allowed.join(', ')}. Got "${value}".`);
}

function parseTargets(value: string | undefined): PlatformId[] | undefined {
  if (value === undefined) return undefined;
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) throw new UsageError('--targets needs at least one platform.');
  return ids.map((id) => oneOf(id, PLATFORM_IDS, '--targets'));
}

function parseMinScore(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const score = Number(value);
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new UsageError(`--min-score must be an integer from 0 to 100. Got "${value}".`);
  }
  return score;
}

export function parseCommand(argv: readonly string[]): Command {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      format: { type: 'string', short: 'f' },
      output: { type: 'string', short: 'o' },
      targets: { type: 'string', short: 't' },
      'fail-on': { type: 'string' },
      'min-score': { type: 'string' },
      config: { type: 'string', short: 'c' },
      'no-config': { type: 'boolean' },
      untrusted: { type: 'boolean' },
      'no-gitignore': { type: 'boolean' },
      'show-suppressed': { type: 'boolean' },
      color: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });

  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };

  const [first, ...rest] = positionals;
  if (first === 'rules') {
    if (rest.length > 0) throw new UsageError('"rules" takes no arguments.');
    return { kind: 'rules', format: values.json ? 'json' : 'text' };
  }
  if (first === 'explain') {
    const [ruleId, ...extra] = rest;
    if (ruleId === undefined || extra.length > 0) {
      throw new UsageError('Usage: agentcheckup explain <rule-id>');
    }
    return { kind: 'explain', ruleId };
  }

  if (positionals.length > 1) {
    throw new UsageError(`Expected at most one path, got ${positionals.length}.`);
  }
  if (values.config !== undefined && values['no-config']) {
    throw new UsageError('--config and --no-config cannot be combined.');
  }
  if (values.color && values['no-color']) {
    throw new UsageError('--color and --no-color cannot be combined.');
  }

  return {
    kind: 'scan',
    options: {
      path: first ?? '.',
      format: oneOf(values.format ?? 'stylish', OUTPUT_FORMATS, '--format'),
      output: values.output,
      targets: parseTargets(values.targets),
      failOn: oneOf(values['fail-on'] ?? 'error', FAIL_ON, '--fail-on'),
      minScore: parseMinScore(values['min-score']),
      config: values.config,
      // --untrusted implies the repository's own configuration is ignored.
      useConfig: !(values['no-config'] ?? false) && !(values.untrusted ?? false),
      untrusted: values.untrusted ?? false,
      gitignore: !(values['no-gitignore'] ?? false),
      showSuppressed: values['show-suppressed'] ?? false,
      color: values.color ? true : values['no-color'] ? false : undefined,
    },
  };
}
