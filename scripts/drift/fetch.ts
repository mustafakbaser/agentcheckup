/**
 * Fetches cited sources and hashes their normalized content. `fetch` and `sleep` are injected,
 * so tests run without network access or a real clock.
 */
import { looksLikeHtml, normalizeContent, sha256 } from './normalize.js';
import { type FetchPlan, pageUrlOf, planFetch } from './resolve.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchOptions {
  readonly fetch: FetchLike;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Per attempt, including reading the body. */
  readonly timeoutMs: number;
  readonly attempts: number;
  /** Delay before the second attempt; it doubles for each further attempt. */
  readonly backoffMs: number;
  readonly maxBytes: number;
}

export const DEFAULT_FETCH_OPTIONS = {
  timeoutMs: 30_000,
  attempts: 3,
  backoffMs: 2_000,
  maxBytes: 10 * 1024 * 1024,
} as const;

/** The longest `Retry-After` honored; a longer one counts as a failed attempt. */
const MAX_RETRY_AFTER_MS = 60_000;

export type Outcome =
  | {
      readonly ok: true;
      readonly hash: string;
      /** The normalized text the hash covers. Kept in .drift-cache/, never in a report. */
      readonly text: string;
      /**
       * Where the request ended after redirects, when that is not the URL requested: the cited
       * page moved, or its host sends it elsewhere.
       */
      readonly location?: string;
    }
  | { readonly ok: false; readonly reason: string };

type Attempt =
  | {
      readonly ok: true;
      readonly body: string;
      readonly contentType: string;
      /** `response.url` after a followed redirect, or undefined. */
      readonly redirectedTo: string | undefined;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly retry: boolean;
      readonly waitMs?: number;
    };

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

class TooLarge extends Error {}

async function readBody(response: Response, maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body !== null) {
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Every cited source is UTF-8. A wrong guess still decodes the same bytes the same way.
  return new TextDecoder('utf-8').decode(bytes);
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}

function describeError(error: unknown, plan: FetchPlan, timeoutMs: number): string {
  if (error instanceof TooLarge) return 'response too large';
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `timed out after ${Math.round(timeoutMs / 1000)} s`;
  }
  if (error instanceof Error) {
    const cause: unknown = error.cause;
    if (cause instanceof Error) {
      const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
      if (plan.redirect === 'error' && cause.message.includes('redirect')) {
        return 'redirected; the repository may have been renamed or moved';
      }
      return `network error: ${code ?? cause.message}`;
    }
    return `network error: ${error.message}`;
  }
  return 'network error';
}

async function attempt(plan: FetchPlan, options: FetchOptions): Promise<Attempt> {
  try {
    const response = await options.fetch(plan.url, {
      headers: plan.headers,
      redirect: plan.redirect,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const waitMs = retryAfterMs(response);
      return {
        ok: false,
        reason: `HTTP ${response.status}`,
        retry: RETRY_STATUS.has(response.status),
        ...(waitMs === undefined ? {} : { waitMs }),
      };
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const body = await readBody(response, options.maxBytes);
    const redirectedTo = response.redirected && response.url !== '' ? response.url : undefined;
    return { ok: true, body, contentType, redirectedTo };
  } catch (error) {
    const reason = describeError(error, plan, options.timeoutMs);
    return {
      ok: false,
      reason,
      retry: !(error instanceof TooLarge) && !reason.startsWith('redirected'),
    };
  }
}

function mediaType(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim() ?? '';
}

function rendered(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('rendered' in value)) return undefined;
  return typeof value.rendered === 'string' ? value.rendered : undefined;
}

/**
 * The title and content of the one post in a WordPress REST API response. Slugs are unique
 * per post type, so more or fewer than one post means the cited post moved or is gone.
 */
function wordPressText(body: string): string | { reason: string } {
  let posts: unknown;
  try {
    posts = JSON.parse(body);
  } catch {
    return { reason: 'WordPress API returned invalid JSON' };
  }
  if (!Array.isArray(posts) || posts.length !== 1) {
    return { reason: 'WordPress API did not return exactly one post' };
  }
  const post: unknown = posts[0];
  if (typeof post !== 'object' || post === null) return { reason: 'unexpected WordPress post' };
  const { title, content } = post as Record<string, unknown>;
  const titleHtml = rendered(title);
  const contentHtml = rendered(content);
  if (titleHtml === undefined || contentHtml === undefined) {
    return { reason: 'unexpected WordPress post' };
  }
  return `${normalizeContent(titleHtml, 'html')}\n${normalizeContent(contentHtml, 'html')}`;
}

function hashed(text: string): Outcome {
  return { ok: true, hash: sha256(text), text };
}

/** Normalizes a successful response, or explains why it cannot be used. */
export function normalizeResponse(plan: FetchPlan, body: string, contentType: string): Outcome {
  const type = mediaType(contentType);
  switch (plan.kind) {
    case 'github':
      return hashed(normalizeContent(body, 'text'));
    case 'text': {
      const text = type === 'text/markdown' || type === 'text/x-markdown' || type === 'text/plain';
      if (!text || looksLikeHtml(body)) {
        const got = type === '' ? 'no content type' : type;
        return { ok: false, reason: `expected Markdown or plain text, got ${got}` };
      }
      return hashed(normalizeContent(body, 'text'));
    }
    case 'wordpress': {
      const text = wordPressText(body);
      return typeof text === 'string' ? hashed(text) : { ok: false, ...text };
    }
    case 'page': {
      const html = type === 'text/html' || type === 'application/xhtml+xml' || looksLikeHtml(body);
      return hashed(normalizeContent(body, html ? 'html' : 'text'));
    }
  }
}

/** The outcome of a response that ended at `redirectedTo`: moved, unless it is the same URL. */
function withLocation(
  outcome: Outcome,
  plan: FetchPlan,
  redirectedTo: string | undefined,
): Outcome {
  if (!outcome.ok || redirectedTo === undefined) return outcome;
  const location = URL.canParse(redirectedTo) ? new URL(redirectedTo) : undefined;
  if (location !== undefined) location.hash = '';
  if (location?.href === plan.url) return outcome;
  // A Markdown version or raw file that moved is reported as the page to cite instead.
  return { ...outcome, location: pageUrlOf(location?.href ?? redirectedTo) };
}

async function fetchWithRetries(plan: FetchPlan, options: FetchOptions): Promise<Outcome> {
  let last: Attempt | undefined;
  for (let number = 1; number <= options.attempts; number++) {
    if (number > 1 && last !== undefined && !last.ok) {
      const backoff = options.backoffMs * 2 ** (number - 2);
      await options.sleep(Math.max(backoff, last.waitMs ?? 0));
    }
    last = await attempt(plan, options);
    if (last.ok) {
      return withLocation(
        normalizeResponse(plan, last.body, last.contentType),
        plan,
        last.redirectedTo,
      );
    }
    if (!last.retry || (last.waitMs ?? 0) > MAX_RETRY_AFTER_MS) break;
  }
  if (last === undefined || last.ok) return { ok: false, reason: 'not fetched' };
  return { ok: false, reason: last.reason };
}

/**
 * Fetches a plan with retries. Never throws. When the request does not go to the cited page
 * itself (a Markdown version, an API), a failure names the URL that was requested. A response
 * that redirects elsewhere carries the URL it ended at as `location`.
 */
export async function fetchPlan(plan: FetchPlan, options: FetchOptions): Promise<Outcome> {
  const outcome = await fetchWithRetries(plan, options);
  if (outcome.ok || plan.kind === 'page') return outcome;
  return { ok: false, reason: `${outcome.reason} (requested ${plan.url})` };
}

export interface HashOptions extends FetchOptions {
  /** GitHub token for api.github.com. */
  readonly token?: string | undefined;
  /** Requests in flight at once. */
  readonly concurrency: number;
}

/**
 * Plans, fetches and hashes cited URLs. URLs that resolve to the same request, such as one page
 * cited with two different fragments, are fetched once. Never throws.
 */
export async function hashSources(
  urls: readonly string[],
  options: HashOptions,
): Promise<Map<string, Outcome>> {
  const pending = new Map<string, Promise<Outcome>>();
  const outcomes = await mapLimit(urls, options.concurrency, (url) => {
    let plan: FetchPlan;
    try {
      plan = planFetch(url, { token: options.token });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid URL';
      return Promise.resolve<Outcome>({ ok: false, reason });
    }
    const key = `${plan.kind} ${plan.url}`;
    let outcome = pending.get(key);
    if (outcome === undefined) {
      outcome = fetchPlan(plan, options);
      pending.set(key, outcome);
    }
    return outcome;
  });
  return new Map(
    urls.map((url, index) => [url, outcomes[index] ?? { ok: false, reason: 'not fetched' }]),
  );
}

/** Runs `task` over `items` with at most `limit` running at once; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
