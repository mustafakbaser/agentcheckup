/**
 * What release-please does to the files in release-please-config.json's `extra-files`, so tests
 * can check that a release bumps every pinned version and nothing else.
 */
import { readFile } from 'node:fs/promises';

/** A version as release-please's generic updater matches one (src/updaters/generic.ts). */
const SEMVER = /(?<!\d)\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.-]+)?/;

/**
 * release-please's generic updater for the `version` scope: on a line with
 * `x-release-please-version`, and on each line after `x-release-please-start-version` up to and
 * including `x-release-please-end`, it replaces the first version on the line, and only that.
 */
export function releasePleaseBump(content: string, version: string): string {
  const lines: string[] = [];
  let inBlock = false;
  for (const line of content.split(/\r?\n/)) {
    if (line.includes('x-release-please-version')) {
      lines.push(line.replace(SEMVER, version));
    } else if (inBlock) {
      lines.push(line.replace(SEMVER, version));
      if (line.includes('x-release-please-end')) inBlock = false;
    } else {
      if (line.includes('x-release-please-start-version')) inBlock = true;
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/** The paths in `extra-files` of the root package in release-please-config.json. */
export async function releasePleaseExtraFiles(configPath: string): Promise<string[]> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    packages: Record<string, { 'extra-files'?: (string | { path: string })[] }>;
  };
  return (config.packages['.']?.['extra-files'] ?? []).map((entry) =>
    typeof entry === 'string' ? entry : entry.path,
  );
}
