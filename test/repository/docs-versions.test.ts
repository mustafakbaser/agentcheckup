/**
 * Versions the documentation shows must not go stale: examples that pin agentcheckup to a version
 * follow the package, and the GitHub Action example stays within one minor version of it.
 */
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../src/core/compare.js';
import { VERSION } from '../../src/core/version.js';
import { releasePleaseBump, releasePleaseExtraFiles } from '../helpers/release-please.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NEXT = '98.76.54';

/** `npx agentcheckup@<version>`, the form every pinned command in the docs takes. */
const PIN = /npx agentcheckup@(\d+\.\d+\.\d+(?:-[\w.]+)?)/g;
/** `mustafakbaser/agentcheckup-action@<ref>`, with the version comment after a commit SHA. */
const ACTION = /mustafakbaser\/agentcheckup-action@([^\s#]+)(?: # (\S+))?/g;
const COMMIT_SHA = /^[\da-f]{40}$/;
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * README.md and every Markdown file below docs/ that the repository tracks, as sorted POSIX paths.
 * Files git does not track, such as a maintainer's local notes, are not documentation it ships;
 * without git (a source archive), every file below docs/ counts.
 */
async function documents(): Promise<string[]> {
  let tracked: string[] | undefined;
  try {
    // Outside a checkout git exits with an error: keep its message out of the test output.
    tracked = execFileSync('git', ['ls-files', '-z', '--', 'docs'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter((path) => path.endsWith('.md'));
  } catch {
    tracked = undefined;
  }
  if (tracked === undefined) {
    const entries = await readdir(join(ROOT, 'docs'), { recursive: true, withFileTypes: true });
    tracked = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join('/'));
  }
  return ['README.md', ...tracked].sort(compareStrings);
}

async function read(path: string): Promise<string> {
  return readFile(join(ROOT, ...path.split('/')), 'utf8');
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

/** `text` with every occurrence of `version` that is not part of a longer version replaced. */
function replaceVersion(text: string, version: string, next: string): string {
  let out = '';
  let from = 0;
  for (let at = text.indexOf(version); at >= 0; at = text.indexOf(version, at + 1)) {
    const before = text[at - 1];
    const after = text[at + version.length];
    const longer =
      isDigit(before) ||
      before === '.' ||
      isDigit(after) ||
      (after === '.' && isDigit(text[at + version.length + 1]));
    if (longer) continue;
    out += text.slice(from, at) + next;
    from = at + version.length;
  }
  return out + text.slice(from);
}

function parseVersion(version: string): [number, number, number] {
  const [major, minor, patch] = version.split('.').map(Number);
  return [major ?? NaN, minor ?? NaN, patch ?? NaN];
}

/**
 * Whether the Action example may point at `tag` while the package is at `current`: no newer
 * than the package, and at most one minor version behind it. The Action is released after the
 * package, with the same version, so release-please's pull request bumps the package before
 * the Action it would point at exists. After each Action release, update the example; one that
 * falls two minor versions behind fails the next release pull request.
 */
function actionTagIsCurrent(tag: string, current: string): boolean {
  const match = TAG.exec(tag);
  if (match === null) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const [currentMajor, currentMinor, currentPatch] = parseVersion(current);
  const newer =
    major > currentMajor ||
    (major === currentMajor &&
      (minor > currentMinor || (minor === currentMinor && patch > currentPatch)));
  if (newer) return false;
  if (major === currentMajor) return minor === currentMinor || minor === currentMinor - 1;
  return major === currentMajor - 1 && currentMinor === 0;
}

describe('versions in the documentation', () => {
  it('pins every npx agentcheckup command to the package version', async () => {
    const pins: string[] = [];
    for (const path of await documents()) {
      for (const match of (await read(path)).matchAll(PIN)) pins.push(`${path} ${match[1]}`);
    }
    expect(pins.length).toBeGreaterThan(10);
    expect(pins.filter((pin) => !pin.endsWith(` ${VERSION}`))).toEqual([]);
  });

  it('lets release-please bump every pinned version and nothing else', async () => {
    const extraFiles = await releasePleaseExtraFiles(join(ROOT, 'release-please-config.json'));
    for (const path of await documents()) {
      const text = await read(path);
      if (text.match(PIN) === null) continue;
      expect(extraFiles, `${path} is not in release-please's extra-files`).toContain(path);
      expect(releasePleaseBump(text, NEXT), path).toBe(replaceVersion(text, VERSION, NEXT));
    }
  });

  it('marks blocks only with whole comment lines, each closed before the next opens', async () => {
    // release-please's generic updater takes any line that mentions the start marker for the start
    // of a block, also prose that names it, and bumps every line after it up to the end marker.
    const START = '<!-- x-release-please-start-version -->';
    const END = '<!-- x-release-please-end -->';
    for (const path of await documents()) {
      let open = false;
      for (const [index, line] of (await read(path)).split('\n').entries()) {
        const start = line.includes('x-release-please-start-version');
        if (!start && !line.includes('x-release-please-end')) continue;
        const where = `${path}:${String(index + 1)}`;
        expect(line, where).toBe(start ? START : END);
        expect(open, `${where}: ${start ? 'opens a block in a block' : 'ends no block'}`).toBe(
          !start,
        );
        open = start;
      }
      expect(open, `${path}: a block is not closed`).toBe(false);
    }
  });

  it('pins the Action example to a release commit at most one minor version behind', async () => {
    const refs: string[] = [];
    for (const path of await documents()) {
      for (const match of (await read(path)).matchAll(ACTION)) {
        const [, ref = '', tag = ''] = match;
        refs.push(ref);
        expect(ref, `${path}: pin the Action to a full commit SHA`).toMatch(COMMIT_SHA);
        expect(actionTagIsCurrent(tag, VERSION), `${path}: Action ${tag}, package ${VERSION}`).toBe(
          true,
        );
      }
    }
    expect(refs.length).toBeGreaterThan(0);
  });
});

describe('actionTagIsCurrent', () => {
  it.each([
    ['v0.3.1', '0.3.1'],
    ['v0.3.0', '0.3.1'],
    ['v0.2.5', '0.3.1'],
    ['v0.3.1', '0.4.0'],
    ['v0.9.2', '1.0.0'],
    ['v1.0.0', '1.0.3'],
  ])('accepts %s for package %s', (tag, current) => {
    expect(actionTagIsCurrent(tag, current)).toBe(true);
  });

  it.each([
    ['v0.1.0', '0.3.1', 'two minor versions behind'],
    ['v0.3.2', '0.3.1', 'newer than the package'],
    ['v0.4.0', '0.3.1', 'newer than the package'],
    ['v0.9.2', '1.1.0', 'a major version behind, past its first minor'],
    ['0.3.1', '0.3.1', 'without the v'],
    ['', '0.3.1', 'without a version comment'],
  ])('rejects %s for package %s: %s', (tag, current) => {
    expect(actionTagIsCurrent(tag, current)).toBe(false);
  });
});

describe('replaceVersion', () => {
  it('replaces only whole versions', () => {
    expect(replaceVersion('0.3.1 10.3.1 0.3.10 0.3.1.2 v0.3.1.', '0.3.1', 'X')).toBe(
      'X 10.3.1 0.3.10 0.3.1.2 vX.',
    );
  });
});
