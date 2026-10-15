/**
 * Downloads the real-world corpus into .corpus-cache/ (gitignored, never committed).
 *
 *   npx tsx scripts/corpus/fetch.ts [--only owner/name]... [--reserve 1000] [--trees-only]
 *
 * For every repository in corpus/repos.json, at its pinned commit:
 * 1. the recursive git tree (`tree.json`), the full path list used for existence checks;
 * 2. the text of every symlink the walk reaches (`links.json`), to resolve them inside the tree;
 * 3. only the blobs the agentcheck walker would read: paths `classify()` accepts, outside
 *    hard-excluded directories, at most 1 MiB each (`files/<path>`, listed in `files.json`).
 *
 * Every blob is verified against its git object id. Resumable: anything already cached and
 * verified is skipped. Repositories are processed one at a time. The cache is untrusted
 * third-party content: it is only written and read as bytes, never executed, and git is never
 * run in it.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { compareStrings } from '../../src/core/compare.js';
import { isHardExcludedDirectory } from '../../src/io/filters.js';
import { MAX_GITMODULES_BYTES } from '../../src/io/submodules.js';
import { classify } from '../../src/platforms/classify.js';
import {
  type CachedFiles,
  type CachedLinks,
  type CachedTree,
  cacheDirFor,
  FILES_FILE,
  gitBlobSha,
  insideCacheDir,
  LINKS_FILE,
  loadRepos,
  log,
  readJsonIfExists,
  type RepoEntry,
  repoLabel,
  TREE_FILE,
} from './common.js';
import { fetchBlobs, fetchTree, GitHub } from './github.js';
import { type Candidate, VirtualTree, type WalkPlan } from './virtual-walk.js';

const { values } = parseArgs({
  options: {
    only: { type: 'string', multiple: true, default: [] },
    reserve: { type: 'string', default: '1000' },
    'trees-only': { type: 'boolean', default: false },
  },
  strict: true,
});

const reserve = Number(values.reserve);
if (!Number.isSafeInteger(reserve) || reserve < 0) throw new Error('--reserve must be an integer');

async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${String(process.pid)}`;
  await writeFile(temporary, data);
  await rename(temporary, file);
}

function sortedRecord<T>(map: ReadonlyMap<string, T>): Record<string, T> {
  return Object.fromEntries([...map].sort(([a], [b]) => compareStrings(a, b)));
}

async function readVerified(file: string, sha: string): Promise<boolean> {
  try {
    return gitBlobSha(await readFile(file)) === sha;
  } catch {
    return false;
  }
}

interface RepoStats {
  readonly entries: number;
  readonly candidates: number;
  readonly downloaded: number;
  readonly bytes: number;
  readonly failed: number;
  readonly symlinks: number;
  readonly unresolved: number;
  readonly truncated: boolean;
  readonly byKind: ReadonlyMap<string, number>;
}

async function resolveLinks(
  github: GitHub,
  entry: RepoEntry,
  tree: VirtualTree,
  directory: string,
): Promise<{ plan: WalkPlan; failedLinks: number }> {
  const linksFile = path.join(directory, LINKS_FILE);
  const cached = (await readJsonIfExists<CachedLinks>(linksFile)) ?? {};
  const links = new Map(Object.entries(cached));
  const failedLinks = new Set<string>();
  let plan = tree.walk(links);
  // Each round can reveal links behind links; the walk asks only for those it actually reaches.
  for (let round = 0; plan.missingLinkTexts.length > 0 && round < 20; round++) {
    const bySha = new Map<string, string[]>();
    const requests = [];
    for (const linkPath of plan.missingLinkTexts) {
      const node = tree.node(linkPath);
      if (node === undefined) continue;
      const list = bySha.get(node.sha) ?? [];
      list.push(linkPath);
      bySha.set(node.sha, list);
      requests.push({ sha: node.sha, size: node.size });
    }
    const { failed } = await fetchBlobs(github, entry.repo, requests, (sha, bytes) => {
      const text = Buffer.from(bytes).toString('utf8');
      for (const linkPath of bySha.get(sha) ?? []) links.set(linkPath, text);
      return Promise.resolve();
    });
    // A link whose text could not be fetched counts as broken for this run only: it is not saved,
    // so the next run retries it.
    for (const sha of failed) {
      for (const linkPath of bySha.get(sha) ?? []) {
        links.set(linkPath, '');
        failedLinks.add(linkPath);
      }
    }
    const saved = new Map([...links].filter(([linkPath]) => !failedLinks.has(linkPath)));
    await writeAtomic(linksFile, `${JSON.stringify(sortedRecord(saved), null, 2)}\n`);
    plan = tree.walk(links);
  }
  return { plan, failedLinks: failedLinks.size };
}

async function fetchRepo(github: GitHub, entry: RepoEntry): Promise<RepoStats> {
  const directory = cacheDirFor(entry);
  await mkdir(directory, { recursive: true });

  const treeFile = path.join(directory, TREE_FILE);
  let cachedTree = await readJsonIfExists<CachedTree>(treeFile);
  if (cachedTree?.sha !== entry.sha || cachedTree.repo !== entry.repo) {
    cachedTree = await fetchTree(github, entry.repo, entry.sha, isHardExcludedDirectory);
    await writeAtomic(treeFile, JSON.stringify(cachedTree));
  }
  const tree = new VirtualTree(cachedTree);
  const { plan, failedLinks } = await resolveLinks(github, entry, tree, directory);

  const byKind = new Map<string, number>();
  for (const candidate of plan.candidates) {
    const kind = classify(candidate.path)?.kind ?? 'unknown';
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
  const base = {
    entries: cachedTree.entries.length,
    candidates: plan.candidates.length,
    symlinks: plan.symlinksSeen,
    unresolved: plan.unresolvedSymlinks.length,
    truncated: cachedTree.truncated,
    byKind,
  };
  if (values['trees-only']) return { ...base, downloaded: 0, bytes: 0, failed: failedLinks };

  // One download per real file, however many paths reach it.
  const filesFile = path.join(directory, FILES_FILE);
  const files = new Map(Object.entries((await readJsonIfExists<CachedFiles>(filesFile)) ?? {}));
  const needed = new Map<string, Candidate>();
  for (const candidate of plan.candidates) {
    if (!needed.has(candidate.realPath)) needed.set(candidate.realPath, candidate);
  }
  // The root .gitmodules steers the walk (src/io/submodules.ts), so snapshot.ts needs its bytes.
  // The plan above does not depend on it: in a git tree every declared directory is listed anyway.
  const gitmodules = tree.gitmodules();
  if (gitmodules !== undefined && gitmodules.size <= MAX_GITMODULES_BYTES) {
    needed.set('.gitmodules', {
      path: '.gitmodules',
      realPath: '.gitmodules',
      sha: gitmodules.sha,
      size: gitmodules.size,
    });
  }
  // Paths already stored (case-folded): a second path that differs only in case or Unicode
  // normalization would overwrite the first on macOS or Windows, so it is stored by object id.
  const taken = new Set<string>();
  const fold = (relative: string): string => relative.normalize('NFC').toLowerCase();
  for (const stored of files.values()) taken.add(fold(stored.file));

  const missing: Candidate[] = [];
  for (const [realPath, candidate] of needed) {
    const stored = files.get(realPath);
    if (stored?.sha === candidate.sha) {
      const location = insideCacheDir(directory, stored.file);
      if (location !== undefined && (await readVerified(location, candidate.sha))) continue;
    }
    // A previous run may have written the file but been interrupted before saving files.json.
    const defaultFile = `files/${realPath}`;
    const location = insideCacheDir(directory, defaultFile);
    if (location !== undefined && (await readVerified(location, candidate.sha))) {
      files.set(realPath, { sha: candidate.sha, file: defaultFile });
      taken.add(fold(defaultFile));
      continue;
    }
    missing.push(candidate);
  }

  const byBlob = new Map<string, string[]>();
  for (const candidate of missing) {
    const list = byBlob.get(candidate.sha) ?? [];
    list.push(candidate.realPath);
    byBlob.set(candidate.sha, list);
  }

  let downloaded = 0;
  let bytes = 0;
  let sinceSave = 0;
  const save = (): Promise<void> =>
    writeAtomic(filesFile, `${JSON.stringify(sortedRecord(files), null, 2)}\n`);

  const store = async (realPath: string, sha: string, data: Uint8Array): Promise<void> => {
    const preferred = `files/${realPath}`;
    const location = insideCacheDir(directory, preferred);
    if (location !== undefined && !taken.has(fold(preferred))) {
      try {
        await writeAtomic(location, data);
        files.set(realPath, { sha, file: preferred });
        taken.add(fold(preferred));
        return;
      } catch {
        // Unwritable name on this filesystem (too long, clashes with a directory): fall back.
      }
    }
    const fallback = `blobs/${sha}`;
    await writeAtomic(path.join(directory, 'blobs', sha), data);
    files.set(realPath, { sha, file: fallback });
  };

  const { failed } = await fetchBlobs(
    github,
    entry.repo,
    [...new Map(missing.map((candidate) => [candidate.sha, candidate.size]))].map(
      ([sha, size]) => ({ sha, size }),
    ),
    async (sha, data) => {
      for (const realPath of byBlob.get(sha) ?? []) await store(realPath, sha, data);
      downloaded += 1;
      bytes += data.length;
      sinceSave += 1;
      if (sinceSave >= 50) {
        sinceSave = 0;
        await save();
      }
    },
  );
  await save();
  return { ...base, downloaded, bytes, failed: failed.length + failedLinks };
}

const repos = await loadRepos();
const only = new Set(values.only.map((name) => name.toLowerCase()));
const unknown = [...only].filter(
  (name) => !repos.some((entry) => entry.repo.toLowerCase() === name),
);
if (unknown.length > 0) throw new Error(`not in corpus/repos.json: ${unknown.join(', ')}`);
const selected =
  only.size === 0 ? repos : repos.filter((entry) => only.has(entry.repo.toLowerCase()));

const github = new GitHub({ reserve });
const failures: string[] = [];
const totals = { candidates: 0, downloaded: 0, bytes: 0 };
const kinds = new Map<string, number>();

for (const [index, entry] of selected.entries()) {
  const label = `[${String(index + 1)}/${String(selected.length)}] ${repoLabel(entry)}`;
  try {
    const stats = await fetchRepo(github, entry);
    totals.candidates += stats.candidates;
    totals.downloaded += stats.downloaded;
    totals.bytes += stats.bytes;
    for (const [kind, count] of stats.byKind) kinds.set(kind, (kinds.get(kind) ?? 0) + count);
    const kindList = [...stats.byKind]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([kind, count]) => `${kind}=${String(count)}`)
      .join(' ');
    const notes = [
      `${String(stats.entries)} tree entries${stats.truncated ? ' (TRUNCATED)' : ''}`,
      `${String(stats.candidates)} candidates`,
      `${String(stats.downloaded)} downloaded (${String(Math.round(stats.bytes / 1024))} KiB)`,
      `${String(stats.symlinks)} symlinks (${String(stats.unresolved)} unresolved)`,
      ...(stats.failed > 0 ? [`${String(stats.failed)} FAILED`] : []),
    ];
    log(`${label}: ${notes.join(', ')}${kindList === '' ? '' : `\n    ${kindList}`}`);
    if (stats.failed > 0) {
      failures.push(`${entry.repo}: ${String(stats.failed)} downloads failed; run again to retry`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label}: FAILED ${message}`);
    failures.push(`${entry.repo}: ${message}`);
  }
}

const kindSummary = [...kinds]
  .sort(([a], [b]) => compareStrings(a, b))
  .map(([kind, count]) => `${kind}=${String(count)}`)
  .join(' ');
log(
  `\n${String(selected.length)} repositories, ${String(totals.candidates)} candidate files, ` +
    `${String(totals.downloaded)} blobs downloaded (${String(Math.round(totals.bytes / 1024))} KiB); ` +
    `GitHub requests: ${String(github.restCalls)} REST, ${String(github.graphqlCalls)} GraphQL\n${kindSummary}`,
);
if (failures.length > 0) {
  log(
    `\n${String(failures.length)} problem(s):\n${failures.map((line) => `- ${line}`).join('\n')}`,
  );
  process.exitCode = 1;
}
