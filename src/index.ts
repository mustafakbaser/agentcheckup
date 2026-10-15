/**
 * Programmatic API. Pre-1.0: may change in minor versions; see CHANGELOG.md.
 */
import { resolveConfig, type ResolvedConfig } from './core/config.js';
import {
  type ContextOptions,
  type ScanOptions,
  scanSnapshot,
  type ScanResult,
  scanWithContext,
} from './core/engine.js';
import type { PlatformId } from './core/types.js';
import { walk, type WalkOptions } from './io/walk.js';
import { builtinRules } from './rules/index.js';

export interface ScanDirectoryOptions {
  /** Parsed contents of an agentcheckup config file. */
  readonly config?: unknown;
  readonly targets?: readonly PlatformId[];
  /** Honor inline suppression directives. Default true. */
  readonly trustDirectives?: boolean;
  readonly walk?: WalkOptions;
  /**
   * Also plan what each agent loads (`result.context`): `true` for every modeled agent among the
   * targets at the scan root, or the options of `scanWithContext`.
   */
  readonly context?: boolean | ContextOptions;
}

/** Scans a directory with the built-in rules. */
export async function scan(root: string, options: ScanDirectoryOptions = {}): Promise<ScanResult> {
  const snapshot = await walk(root, options.walk);
  const config: ResolvedConfig | undefined =
    options.config === undefined ? undefined : resolveConfig(options.config);
  const scanOptions: ScanOptions = {
    rules: builtinRules,
    ...(config ? { config } : {}),
    ...(options.targets ? { targets: options.targets } : {}),
    ...(options.trustDirectives === undefined ? {} : { trustDirectives: options.trustDirectives }),
  };
  const { context } = options;
  if (context === undefined || context === false) return scanSnapshot(snapshot, scanOptions);
  return scanWithContext(snapshot, { ...scanOptions, ...(context === true ? {} : context) });
}

export type * from './core/baseline-types.js';
export { ConfigError, resolveConfig, type ResolvedConfig, type UserConfig } from './core/config.js';
export {
  type ContextOptions,
  type ContextScanResult,
  scanSnapshot,
  type ScanOptions,
  type ScanResult,
  scanWithContext,
} from './core/engine.js';
export { RULESET_VERSION, TOOL_NAME } from './core/meta.js';
export type { ScoreReport } from './core/score.js';
export type * from './core/types.js';
export { ARTIFACT_KINDS, CATEGORIES, PLATFORM_IDS, SEVERITIES } from './core/types.js';
export { VERSION } from './core/version.js';
export type * from './inventory/types.js';
export { WalkError, type WalkOptions } from './io/walk.js';
export type * from './platforms/load/types.js';
export { CONTEXT_AGENTS } from './platforms/load/types.js';
export { builtinRules } from './rules/index.js';
