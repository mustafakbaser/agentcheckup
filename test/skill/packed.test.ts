/**
 * The skill as npm packs it, the way `pnpm check:package` (publint --pack npm) and the release
 * job (npm pack) pack the package: it must be in the tarball, unchanged, and pin the version the
 * tarball's package.json carries, so a skill with a stale version never ships.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { PACKAGED_SKILL, pinnedVersions, SKILL_FILES } from '../../src/cli/skill.js';
import { makeTempDir, removeTempDirs } from '../io/helpers.js';
import { REPO_ROOT, skillBytes } from './helpers.js';

afterEach(removeTempDirs);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** A NUL-terminated field of a tar header. */
function field(header: Uint8Array, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** The regular files of a gzipped ustar archive, by path without npm's `package/` prefix. */
function untar(gzipped: Uint8Array): Map<string, Uint8Array> {
  const tar = gunzipSync(gzipped);
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const size = Number.parseInt(field(header, 124, 12).trim(), 8);
    const type = header[156];
    offset += 512;
    if (type === 0x30 || type === 0) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      files.set(
        path.replace(/^package\//, ''),
        new Uint8Array(tar.subarray(offset, offset + size)),
      );
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

describe('the packed skill', () => {
  it(
    'ships unchanged and pins the version of the packed package.json',
    { timeout: 120_000 },
    async () => {
      const destination = await makeTempDir('agentcheckup-pack-');
      const packed = JSON.parse(
        execFileSync(
          npm,
          ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
          {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            shell: process.platform === 'win32',
          },
        ),
      ) as { filename: string }[];
      const tarball = packed[0]?.filename ?? '';
      const files = untar(new Uint8Array(await readFile(join(destination, tarball))));

      const shipped = [...files.keys()].filter((path) => path.startsWith(`${PACKAGED_SKILL}/`));
      expect(shipped.sort()).toEqual(SKILL_FILES.map((path) => `${PACKAGED_SKILL}/${path}`).sort());
      for (const [path, bytes] of await skillBytes()) {
        expect(files.get(`${PACKAGED_SKILL}/${path}`), path).toEqual(bytes);
      }

      const decoder = new TextDecoder();
      const manifest = JSON.parse(decoder.decode(files.get('package.json'))) as { version: string };
      const skill = decoder.decode(files.get(`${PACKAGED_SKILL}/SKILL.md`));
      expect(pinnedVersions(skill).length).toBeGreaterThan(0);
      expect(new Set(pinnedVersions(skill))).toEqual(new Set([manifest.version]));
    },
  );
});
