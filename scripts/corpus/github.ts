/**
 * GitHub access for the corpus harness, through the `gh` CLI (its stored credentials, no token
 * handling here). `gh` is always started with execFile and an argument array: no shell, so
 * nothing from a repository name or a path can be interpreted as shell syntax.
 *
 * The REST quota (5 000 requests per hour) is shared with everything else using the same `gh`
 * login, so this module keeps a reserve: when fewer than `reserve` requests are left it waits
 * for the reset instead of draining the quota. Blob contents are fetched in batches through
 * GraphQL (a separate quota; one point per batch) and verified against their git object id.
 */
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { type CachedTree, gitBlobSha, log, SHA_PATTERN, type TreeEntry } from './common.js';

export class GhError extends Error {
  override readonly name = 'GhError';
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

const GH_ENV = {
  ...process.env,
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
  CLICOLOR: '0',
};

function runGh(args: readonly string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      [...args],
      { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, timeout: 180_000, env: GH_ENV },
      (error, stdout, stderr) => {
        if (error) {
          const text = stderr.toString('utf8').trim();
          reject(
            new GhError(`gh ${args.slice(0, 2).join(' ')} failed: ${text || error.message}`, text),
          );
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(input ?? '');
  });
}

const TRANSIENT =
  /HTTP 5\d\d|secondary rate limit|abuse|timed? ?out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|unexpected EOF|was submitted too quickly/i;
const PRIMARY_LIMIT = /API rate limit exceeded|rate limit exceeded for/i;

type Resource = 'core' | 'graphql';

interface RateState {
  remaining: number;
  reset: number;
}

export interface GitHubOptions {
  /** REST/GraphQL requests to leave for other users of the same login. */
  readonly reserve: number;
}

/** A small client around `gh api` with retries and a rate-limit reserve. */
export class GitHub {
  readonly #reserve: number;
  readonly #state = new Map<Resource, RateState>();
  #sinceCheck = new Map<Resource, number>();
  restCalls = 0;
  graphqlCalls = 0;

  constructor(options: GitHubOptions) {
    this.#reserve = options.reserve;
  }

  /** GET a REST path (no leading slash) and parse the JSON response. */
  async rest<T>(apiPath: string): Promise<T> {
    await this.#ensureBudget('core');
    const out = await this.#withRetries(() => runGh(['api', '--method', 'GET', apiPath]));
    this.restCalls += 1;
    this.#spend('core');
    return JSON.parse(out.toString('utf8')) as T;
  }

  /** Runs a GraphQL query with variables (sent as a JSON body on stdin, never interpolated). */
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    await this.#ensureBudget('graphql');
    const body = JSON.stringify({ query, variables });
    const out = await this.#withRetries(() => runGh(['api', 'graphql', '--input', '-'], body));
    this.graphqlCalls += 1;
    this.#spend('graphql');
    const parsed = JSON.parse(out.toString('utf8')) as {
      data?: T;
      errors?: { message: string }[];
    };
    if (parsed.errors && parsed.errors.length > 0 && parsed.data === undefined) {
      throw new GhError(`GraphQL error: ${parsed.errors.map((e) => e.message).join('; ')}`, '');
    }
    if (parsed.data === undefined) throw new GhError('GraphQL response without data', '');
    return parsed.data;
  }

  async #withRetries(call: () => Promise<Buffer>): Promise<Buffer> {
    const delays = [5_000, 20_000, 60_000, 120_000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if (!(error instanceof GhError)) throw error;
        if (PRIMARY_LIMIT.test(error.stderr)) {
          await this.#waitForReset(error.stderr);
          continue;
        }
        const delay = delays[attempt];
        if (delay === undefined || !TRANSIENT.test(error.stderr)) throw error;
        log(
          `  transient GitHub error, retrying in ${String(delay / 1000)}s: ${error.stderr.slice(0, 160)}`,
        );
        await sleep(delay);
      }
    }
  }

  #spend(resource: Resource): void {
    const state = this.#state.get(resource);
    if (state) state.remaining -= 1;
    this.#sinceCheck.set(resource, (this.#sinceCheck.get(resource) ?? 0) + 1);
  }

  /** Checks the quota every 50 calls (the rate_limit endpoint itself is free). */
  async #ensureBudget(resource: Resource): Promise<void> {
    const known = this.#state.get(resource);
    if (known === undefined || (this.#sinceCheck.get(resource) ?? 0) >= 50) {
      await this.#refresh();
    }
    for (;;) {
      const state = this.#state.get(resource);
      if (state === undefined || state.remaining > this.#reserve) return;
      const wait = Math.max(0, state.reset * 1000 - Date.now()) + 5_000;
      log(
        `  ${resource} quota low (${String(state.remaining)} left, reserve ${String(this.#reserve)}); waiting ${String(Math.ceil(wait / 1000))}s for the reset`,
      );
      await sleep(wait);
      await this.#refresh();
    }
  }

  async #refresh(): Promise<void> {
    const out = await runGh(['api', 'rate_limit']);
    const parsed = JSON.parse(out.toString('utf8')) as {
      resources: Record<string, { remaining: number; reset: number } | undefined>;
    };
    for (const resource of ['core', 'graphql'] as const) {
      const value = parsed.resources[resource];
      if (value) this.#state.set(resource, { remaining: value.remaining, reset: value.reset });
      this.#sinceCheck.set(resource, 0);
    }
  }

  /** Waits for the reset of whichever quota is used up (or a minute, for other limits). */
  async #waitForReset(stderr: string): Promise<void> {
    await this.#refresh();
    const resets = [...this.#state.values()]
      .filter((state) => state.remaining <= 0)
      .map((state) => state.reset * 1000);
    const wait = Math.max(60_000, Math.max(0, ...resets) - Date.now() + 5_000);
    log(`  rate limited (${stderr.slice(0, 120)}); waiting ${String(Math.ceil(wait / 1000))}s`);
    await sleep(wait);
  }
}

// ---------------------------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------------------------

interface ApiTree {
  readonly sha: string;
  readonly truncated: boolean;
  readonly tree: readonly {
    readonly path: string;
    readonly mode: string;
    readonly type: string;
    readonly sha: string;
    readonly size?: number;
  }[];
}

function toEntries(tree: ApiTree, prefix: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const item of tree.tree) {
    if (item.type !== 'blob' && item.type !== 'tree' && item.type !== 'commit') continue;
    if (!SHA_PATTERN.test(item.sha)) continue;
    entries.push({
      path: `${prefix}${item.path}`,
      mode: item.mode,
      type: item.type,
      sha: item.sha,
      ...(typeof item.size === 'number' ? { size: item.size } : {}),
    });
  }
  return entries;
}

/**
 * The full recursive tree of `repo` at commit `sha`. GitHub truncates recursive listings at
 * 100 000 entries or 7 MB; then each directory level is listed separately and its subtrees are
 * fetched recursively, skipping directories the walker never lists (`skipDirectory`).
 */
export async function fetchTree(
  github: GitHub,
  repo: string,
  sha: string,
  skipDirectory: (path: string) => boolean,
): Promise<CachedTree> {
  const unlisted: string[] = [];
  let truncated = false;

  const collect = async (treeish: string, prefix: string): Promise<TreeEntry[]> => {
    const recursive = await github.rest<ApiTree>(`repos/${repo}/git/trees/${treeish}?recursive=1`);
    if (!recursive.truncated) return toEntries(recursive, prefix);
    log(`  tree ${prefix === '' ? '(root)' : prefix} truncated by GitHub; listing per directory`);
    const level = await github.rest<ApiTree>(`repos/${repo}/git/trees/${treeish}`);
    if (level.truncated) truncated = true;
    const entries: TreeEntry[] = [];
    for (const entry of toEntries(level, prefix)) {
      entries.push(entry);
      if (entry.type !== 'tree') continue;
      if (skipDirectory(entry.path)) {
        unlisted.push(entry.path);
        continue;
      }
      // A loop, not push(...spread): a subtree can have more entries than the call stack allows.
      for (const child of await collect(entry.sha, `${entry.path}/`)) entries.push(child);
    }
    return entries;
  };

  const entries = await collect(sha, '');
  return { repo, sha, truncated, unlistedDirectories: unlisted.sort(), entries };
}

// ---------------------------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------------------------

export interface BlobRequest {
  readonly sha: string;
  readonly size: number;
}

interface GraphqlBlob {
  readonly oid: string;
  readonly byteSize: number;
  readonly isBinary: boolean | null;
  readonly isTruncated: boolean;
  readonly text: string | null;
}

const BATCH_OBJECTS = 40;
const BATCH_BYTES = 2 * 1024 * 1024;

/**
 * Downloads blobs by object id. Every result is verified against its git object id, so the
 * bytes are exact (encoding, BOM and line endings included). GraphQL returns blob text, which is
 * exact for valid UTF-8; anything else (binary, UTF-16, invalid UTF-8, truncated) is re-fetched
 * through the REST blob endpoint as base64.
 */
export async function fetchBlobs(
  github: GitHub,
  repo: string,
  requests: readonly BlobRequest[],
  onBlob: (sha: string, bytes: Uint8Array) => Promise<void>,
): Promise<{ readonly failed: readonly string[] }> {
  const [owner, name] = repo.split('/') as [string, string];
  const failed: string[] = [];
  const unique = [...new Map(requests.map((request) => [request.sha, request])).values()];

  const batches: BlobRequest[][] = [];
  let current: BlobRequest[] = [];
  let bytes = 0;
  for (const request of unique) {
    if (
      current.length > 0 &&
      (current.length >= BATCH_OBJECTS || bytes + request.size > BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(request);
    bytes += request.size;
  }
  if (current.length > 0) batches.push(current);

  const restFallback = async (sha: string): Promise<void> => {
    try {
      const blob = await github.rest<{ content: string; encoding: string }>(
        `repos/${repo}/git/blobs/${sha}`,
      );
      if (blob.encoding !== 'base64') throw new Error(`unexpected encoding ${blob.encoding}`);
      const data = Buffer.from(blob.content, 'base64');
      if (gitBlobSha(data) !== sha) throw new Error('content does not match its object id');
      await onBlob(sha, data);
    } catch (error) {
      log(`  blob ${sha} failed: ${error instanceof Error ? error.message : String(error)}`);
      failed.push(sha);
    }
  };

  for (const batch of batches) {
    const declarations = batch.map((_, index) => `$o${String(index)}: GitObjectID!`).join(', ');
    const fields = batch
      .map(
        (_, index) =>
          `b${String(index)}: object(oid: $o${String(index)}) { ... on Blob { oid byteSize isBinary isTruncated text } }`,
      )
      .join('\n');
    const query = `query($owner: String!, $name: String!, ${declarations}) {
  repository(owner: $owner, name: $name) {
${fields}
  }
}`;
    const variables: Record<string, string> = { owner, name };
    batch.forEach((request, index) => (variables[`o${String(index)}`] = request.sha));

    let data: { repository: Record<string, GraphqlBlob | null> | null } | undefined;
    try {
      data = await github.graphql(query, variables);
    } catch (error) {
      log(
        `  GraphQL batch failed (${error instanceof Error ? error.message : String(error)}); using REST`,
      );
    }
    for (const [index, request] of batch.entries()) {
      const blob = data?.repository?.[`b${String(index)}`];
      if (typeof blob?.text === 'string' && !blob.isTruncated && blob.isBinary !== true) {
        const encoded = Buffer.from(blob.text, 'utf8');
        if (gitBlobSha(encoded) === request.sha) {
          await onBlob(request.sha, encoded);
          continue;
        }
      }
      await restFallback(request.sha);
    }
  }
  return { failed };
}

// ---------------------------------------------------------------------------------------------
// Pinning
// ---------------------------------------------------------------------------------------------

export interface RepoHead {
  readonly repo: string;
  /** Canonical owner/name (repositories get renamed and transferred). */
  readonly nameWithOwner: string;
  readonly sha: string;
  readonly defaultBranch: string;
}

/** Default-branch HEAD commit of each repository, 20 per GraphQL query. */
export async function fetchHeads(
  github: GitHub,
  repos: readonly string[],
): Promise<Map<string, RepoHead | undefined>> {
  const heads = new Map<string, RepoHead | undefined>();
  for (let start = 0; start < repos.length; start += 20) {
    const batch = repos.slice(start, start + 20);
    const declarations = batch
      .map((_, index) => `$owner${String(index)}: String!, $name${String(index)}: String!`)
      .join(', ');
    const fields = batch
      .map(
        (_, index) =>
          `r${String(index)}: repository(owner: $owner${String(index)}, name: $name${String(index)}) { nameWithOwner defaultBranchRef { name target { oid } } }`,
      )
      .join('\n');
    const variables: Record<string, string> = {};
    batch.forEach((repo, index) => {
      const [owner = '', name = ''] = repo.split('/');
      variables[`owner${String(index)}`] = owner;
      variables[`name${String(index)}`] = name;
    });
    const data = await github.graphql<
      Record<
        string,
        {
          nameWithOwner: string;
          defaultBranchRef: { name: string; target: { oid: string } } | null;
        } | null
      >
    >(`query(${declarations}) {\n${fields}\n}`, variables);
    batch.forEach((repo, index) => {
      const result = data[`r${String(index)}`];
      const oid = result?.defaultBranchRef?.target.oid;
      heads.set(
        repo,
        result && oid !== undefined && SHA_PATTERN.test(oid)
          ? {
              repo,
              nameWithOwner: result.nameWithOwner,
              sha: oid,
              defaultBranch: result.defaultBranchRef?.name ?? '',
            }
          : undefined,
      );
    });
  }
  return heads;
}
