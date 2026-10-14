import { describe, expect, it } from 'vitest';
import { rebaseResult } from '../../src/core/rebase.js';
import type { ScanResult } from '../../src/core/engine.js';
import { richResult as rich } from '../report/fixtures.js';

describe('rebaseResult', () => {
  it('returns the same object for an empty prefix', () => {
    expect(rebaseResult(rich, '')).toBe(rich);
    expect(rebaseResult(rich, '.')).toBe(rich);
  });

  it('prefixes every path, and only paths', () => {
    const rebased: ScanResult = rebaseResult(rich, 'packages/app/');
    const paths = [
      ...rebased.artifacts.map((artifact) => artifact.path),
      ...rebased.findings.flatMap((finding) => [
        finding.path,
        ...finding.related.map((related) => related.path),
      ]),
      ...rebased.score.artifacts.map((artifact) => artifact.path),
      ...rebased.skipped.map((entry) => entry.path),
      ...rebased.unresolvedSymlinks.map((entry) => entry.path),
    ];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.startsWith('packages/app/')).toBe(true);
    expect(rebased.findings.map((finding) => finding.message)).toEqual(
      rich.findings.map((finding) => finding.message),
    );
    expect(rebased.score.score).toBe(rich.score.score);
  });
});
