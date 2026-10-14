import type { ScanResult } from './engine.js';

/**
 * Prefixes every path in a scan result with `prefix` (a POSIX directory, no trailing slash).
 *
 * Paths in a ScanResult are relative to the scanned directory. GitHub annotations and SARIF
 * locations resolve against the repository root, and terminal users expect paths relative to
 * where they ran the command. The CLI therefore rebases onto the working directory when
 * scanning a subdirectory; otherwise alerts would land on the wrong files.
 */
export function rebaseResult(result: ScanResult, prefix: string): ScanResult {
  if (prefix === '' || prefix === '.') return result;
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const join = (path: string): string => `${base}/${path}`;

  return {
    ...result,
    artifacts: result.artifacts.map((artifact) => ({ ...artifact, path: join(artifact.path) })),
    findings: result.findings.map((finding) => ({
      ...finding,
      path: join(finding.path),
      related: finding.related.map((related) => ({ ...related, path: join(related.path) })),
    })),
    score: {
      ...result.score,
      artifacts: result.score.artifacts.map((artifact) => ({
        ...artifact,
        path: join(artifact.path),
      })),
    },
    skipped: result.skipped.map((entry) => ({ ...entry, path: join(entry.path) })),
    unresolvedSymlinks: result.unresolvedSymlinks.map((entry) => ({
      ...entry,
      path: join(entry.path),
    })),
  };
}
