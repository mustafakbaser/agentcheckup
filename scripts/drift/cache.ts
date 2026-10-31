/**
 * A local cache of the normalized text of each cited source, so that a maintainer can see what
 * changed in a source, not only that its hash did. `pnpm drift:check` and `pnpm drift:update`
 * write it; `pnpm drift:diff <url>` reads it.
 *
 * The text is third-party content and stays on the machine that fetched it: `.drift-cache/` is
 * gitignored, and no report or issue includes any of it.
 *
 * Layout: `.drift-cache/<SHA-256 of the URL>/<SHA-256 of the text>.txt`, one file per version of
 * a source's text, and `url.txt` with the URL. A version is written once and never changed, so
 * the text behind every hash this machine has seen, the baseline's included, stays available.
 * Delete the directory to start over.
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256 } from './normalize.js';

const VERSION_FILE = /^([\da-f]{64})\.txt$/;

function sourceDirectory(cache: string, url: string): string {
  return join(cache, sha256(url));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Keeps one version of a source's text and returns its hash, the SHA-256 the drift check
 * compares. A version that is cached already is left alone.
 */
export async function cacheText(cache: string, url: string, text: string): Promise<string> {
  const hash = sha256(text);
  const directory = sourceDirectory(cache, url);
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${hash}.txt`);
  const known = await stat(file).then(
    () => true,
    (error: unknown) => {
      if (isMissing(error)) return false;
      throw error;
    },
  );
  if (!known) {
    const temporary = `${file}.tmp-${String(process.pid)}`;
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, file);
  }
  await writeFile(join(directory, 'url.txt'), `${url}\n`, 'utf8');
  return hash;
}

/** The cached text of a source with this hash, if this machine has seen it. */
export async function cachedText(
  cache: string,
  url: string,
  hash: string,
): Promise<string | undefined> {
  if (!/^[\da-f]{64}$/.test(hash)) return undefined;
  try {
    return await readFile(join(sourceDirectory(cache, url), `${hash}.txt`), 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export interface CachedVersion {
  readonly hash: string;
  /** When the version was first cached, in milliseconds since the epoch. */
  readonly cachedAt: number;
}

/** The cached versions of a source, newest first. */
export async function cachedVersions(cache: string, url: string): Promise<CachedVersion[]> {
  const directory = sourceDirectory(cache, url);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const versions: CachedVersion[] = [];
  for (const name of names) {
    const hash = VERSION_FILE.exec(name)?.[1];
    if (hash === undefined) continue;
    versions.push({ hash, cachedAt: (await stat(join(directory, name))).mtimeMs });
  }
  return versions.sort((a, b) =>
    a.cachedAt === b.cachedAt ? (a.hash < b.hash ? -1 : 1) : b.cachedAt - a.cachedAt,
  );
}
