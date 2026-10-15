import { resolveConfig } from '../../src/core/config.js';
import { analyze, type RuleResult, runRules, type ScanOptions } from '../../src/core/engine.js';
import type { AnyRule, Finding, PlatformId, Snapshot, SourceFile } from '../../src/core/types.js';

export type FileMap = Readonly<Record<string, string | Uint8Array>>;

const encoder = new TextEncoder();

/**
 * Builds an in-memory snapshot. `extraPaths` are files that exist but are not read
 * (e.g. `docs/guide.md` referenced by an import). Parent directories are added automatically.
 */
export interface SnapshotExtras {
  /** Paths that exist but are not read (e.g. `docs/guide.md` referenced by an import). */
  readonly paths?: readonly string[];
  /** Directories (trailing `/`) whose contents are unknown, e.g. `node_modules/`. */
  readonly opaqueDirectories?: readonly string[];
  readonly ignoredFiles?: readonly string[];
  /** Alias path -> real path, for files reached through symlinks. */
  readonly symlinks?: Readonly<Record<string, string>>;
  /** Default true, as in a normal walk. */
  readonly gitignoreApplied?: boolean;
}

export function snapshotFrom(files: FileMap, extras: SnapshotExtras = {}): Snapshot {
  const extraPaths = extras.paths ?? [];
  const symlinks = extras.symlinks ?? {};
  const sourceFiles: SourceFile[] = Object.entries(files)
    .map(([path, content]) => {
      const target = Object.hasOwn(symlinks, path) ? symlinks[path] : undefined;
      return {
        path,
        bytes: typeof content === 'string' ? encoder.encode(content) : content,
        ...(target === undefined ? {} : { symlinkTarget: target }),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const paths = new Set<string>();
  for (const path of [...Object.keys(files), ...extraPaths]) {
    paths.add(path);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) paths.add(`${parts.slice(0, i).join('/')}/`);
  }
  return {
    files: sourceFiles,
    paths,
    opaqueDirectories: new Set(extras.opaqueDirectories ?? []),
    ignoredFiles: new Set(extras.ignoredFiles ?? []),
    gitignoreApplied: extras.gitignoreApplied ?? true,
    unresolvedSymlinks: [],
    skipped: [],
  };
}

export interface LintOptions extends SnapshotExtras {
  readonly rules: readonly AnyRule[];
  readonly targets?: readonly PlatformId[];
  readonly config?: unknown;
  readonly trustDirectives?: boolean;
}

/** The engine options `lint()` scans with. */
export function scanOptionsFrom(options: LintOptions): ScanOptions {
  return {
    rules: options.rules,
    ...(options.targets ? { targets: options.targets } : {}),
    ...(options.config === undefined ? {} : { config: resolveConfig(options.config) }),
    ...(options.trustDirectives === undefined ? {} : { trustDirectives: options.trustDirectives }),
  };
}

/**
 * Scans in-memory files. Goes through `analyze` and `runRules`, the split that `scanSnapshot`
 * composes and that load plans reuse, so every rule test exercises it. test/core/analyze.test.ts
 * checks that both paths give the same result.
 */
export function lint(files: FileMap, options: LintOptions): RuleResult {
  const scanOptions = scanOptionsFrom(options);
  return runRules(analyze(snapshotFrom(files, options), scanOptions), scanOptions);
}

/** Active (unsuppressed) findings, optionally for one rule, in a compact comparable shape. */
export function findings(
  result: RuleResult,
  ruleId?: string,
): Pick<Finding, 'ruleId' | 'severity' | 'path' | 'message' | 'range'>[] {
  if (result.ruleFailures.length > 0) {
    throw new Error(`Rule crashed: ${JSON.stringify(result.ruleFailures)}`);
  }
  return result.findings
    .filter((finding) => !finding.suppressed && (ruleId === undefined || finding.ruleId === ruleId))
    .map(({ ruleId: id, severity, path, message, range }) => ({
      ruleId: id,
      severity,
      path,
      message,
      range,
    }));
}
