/**
 * Pins corpus/repos.json entries to their default branch's HEAD commit and keeps the file sorted.
 *
 *   npx tsx scripts/corpus/pin.ts                  pin entries whose "sha" is "" (newly added)
 *   npx tsx scripts/corpus/pin.ts --all            re-pin every entry to today's HEAD
 *   npx tsx scripts/corpus/pin.ts --only owner/name   re-pin one entry (repeatable)
 *
 * Renamed or transferred repositories are rewritten to their current owner/name. Uses one
 * GraphQL query per 20 repositories.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { compareRepos, loadRepos, log, REPOS_FILE, type RepoEntry } from './common.js';
import { fetchHeads, GitHub } from './github.js';

const { values } = parseArgs({
  options: {
    all: { type: 'boolean', default: false },
    only: { type: 'string', multiple: true, default: [] },
  },
  strict: true,
});

const entries = await loadRepos(REPOS_FILE, { unpinned: true });
const only = new Set(values.only.map((name) => name.toLowerCase()));
const wanted = entries.filter(
  (entry) => values.all || entry.sha === '' || only.has(entry.repo.toLowerCase()),
);

const heads = await fetchHeads(
  new GitHub({ reserve: 0 }),
  wanted.map((entry) => entry.repo),
);

const problems: string[] = [];
const updated: RepoEntry[] = entries.map((entry) => {
  if (!heads.has(entry.repo)) return entry;
  const head = heads.get(entry.repo);
  if (head === undefined) {
    problems.push(`${entry.repo}: not found or no default branch`);
    return entry;
  }
  if (head.nameWithOwner !== entry.repo) log(`${entry.repo} is now ${head.nameWithOwner}`);
  if (head.sha !== entry.sha)
    log(
      `${head.nameWithOwner}: ${entry.sha || '(unpinned)'} -> ${head.sha} (${head.defaultBranch})`,
    );
  return { repo: head.nameWithOwner, sha: head.sha, why: entry.why };
});
updated.sort((a, b) => compareRepos(a.repo, b.repo));

await writeFile(REPOS_FILE, `${JSON.stringify(updated, null, 2)}\n`);
log(`${String(wanted.length)} pinned, ${String(updated.length)} entries in corpus/repos.json`);
if (problems.length > 0) {
  log(problems.join('\n'));
  process.exitCode = 1;
}
