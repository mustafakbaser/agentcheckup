import { describe, expect, it } from 'vitest';
import {
  type FetchLike,
  type FetchOptions,
  fetchPlan,
  hashSources,
  mapLimit,
  normalizeResponse,
} from '../../../scripts/drift/fetch.js';
import { normalizeText, sha256 } from '../../../scripts/drift/normalize.js';
import { planFetch } from '../../../scripts/drift/resolve.js';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fake `fetch` that answers from a queue of responses or errors, and records every call. */
function fakeFetch(answers: (Response | Error | (() => Response))[]): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const answer = answers.shift();
    if (answer === undefined) return Promise.reject(new Error('no more answers'));
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(typeof answer === 'function' ? answer() : answer);
  };
  return { fetch, calls };
}

function options(fetch: FetchLike, sleeps: number[] = []): FetchOptions {
  return {
    fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    timeoutMs: 30_000,
    attempts: 3,
    backoffMs: 1_000,
    maxBytes: 1_000,
  };
}

function response(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

const MARKDOWN = { 'content-type': 'text/markdown; charset=utf-8' };
const DOCS = planFetch('https://code.claude.com/docs/en/memory');
const REQUESTED = ' (requested https://code.claude.com/docs/en/memory.md)';

describe('fetchPlan', () => {
  it('hashes the normalized Markdown of a text version', async () => {
    const { fetch, calls } = fakeFetch([response('# Memory\r\n\r\ntext  \n', 200, MARKDOWN)]);
    expect(await fetchPlan(DOCS, options(fetch))).toEqual({
      ok: true,
      hash: sha256('# Memory\n\ntext'),
      text: '# Memory\n\ntext',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://code.claude.com/docs/en/memory.md');
    expect(calls[0]?.init.redirect).toBe('follow');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries server errors and network failures with backoff', async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = fakeFetch([
      response('busy', 503),
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }),
      }),
      response('# ok', 200, MARKDOWN),
    ]);
    expect(await fetchPlan(DOCS, options(fetch, sleeps))).toEqual({
      ok: true,
      hash: sha256('# ok'),
      text: '# ok',
    });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it('gives up after the last attempt and reports the last reason', async () => {
    const sleeps: number[] = [];
    const { fetch } = fakeFetch([response('', 502), response('', 503), response('', 504)]);
    expect(await fetchPlan(DOCS, options(fetch, sleeps))).toEqual({
      ok: false,
      reason: `HTTP 504${REQUESTED}`,
    });
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it('honors a short Retry-After and gives up on a long one', async () => {
    const sleeps: number[] = [];
    const short = fakeFetch([
      response('', 429, { 'retry-after': '5' }),
      response('# ok', 200, MARKDOWN),
    ]);
    expect((await fetchPlan(DOCS, options(short.fetch, sleeps))).ok).toBe(true);
    expect(sleeps).toEqual([5_000]);

    const long = fakeFetch([response('', 429, { 'retry-after': '3600' })]);
    expect(await fetchPlan(DOCS, options(long.fetch))).toEqual({
      ok: false,
      reason: `HTTP 429${REQUESTED}`,
    });
    expect(long.calls).toHaveLength(1);
  });

  it('does not retry a missing page', async () => {
    const { fetch, calls } = fakeFetch([response('gone', 404)]);
    expect(await fetchPlan(DOCS, options(fetch))).toEqual({
      ok: false,
      reason: `HTTP 404${REQUESTED}`,
    });
    expect(calls).toHaveLength(1);
  });

  it('reports a failure of the cited page itself without the requested URL', async () => {
    const { fetch } = fakeFetch([response('gone', 404)]);
    expect(await fetchPlan(planFetch('https://example.com/page#x'), options(fetch))).toEqual({
      ok: false,
      reason: 'HTTP 404',
    });
  });

  it('reports timeouts', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    const { fetch } = fakeFetch([timeout, timeout, timeout]);
    expect(await fetchPlan(DOCS, options(fetch))).toEqual({
      ok: false,
      reason: `timed out after 30 s${REQUESTED}`,
    });
  });

  it('reports a refused redirect for authenticated requests without retrying', async () => {
    const plan = planFetch('https://github.com/o/r/blob/main/a.ts', { token: 't' });
    const { fetch, calls } = fakeFetch([
      new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
    ]);
    expect(await fetchPlan(plan, options(fetch))).toEqual({
      ok: false,
      reason:
        'redirected; the repository may have been renamed or moved (requested https://api.github.com/repos/o/r/contents/a.ts?ref=main)',
    });
    expect(calls).toHaveLength(1);
  });

  it('stops reading a response larger than the limit', async () => {
    const { fetch, calls } = fakeFetch([response('x'.repeat(5_000), 200, MARKDOWN)]);
    expect(await fetchPlan(DOCS, options(fetch))).toEqual({
      ok: false,
      reason: `response too large${REQUESTED}`,
    });
    expect(calls).toHaveLength(1);
  });

  it('reports where a redirected request ended, so a moved page is not a changed one', async () => {
    const page = planFetch('https://example.com/old#section');
    const moved = Object.defineProperties(
      response('<p>a</p>', 200, { 'content-type': 'text/html' }),
      {
        redirected: { value: true },
        url: { value: 'https://example.com/new#top' },
      },
    );
    const { fetch } = fakeFetch([moved]);
    expect(await fetchPlan(page, options(fetch))).toEqual({
      ok: true,
      hash: sha256('a'),
      text: 'a',
      location: 'https://example.com/new',
    });
  });

  it('reports a moved Markdown version or raw file as the page to cite', async () => {
    const markdown = Object.defineProperties(
      response('# a', 200, { 'content-type': 'text/markdown' }),
      {
        redirected: { value: true },
        url: { value: 'https://docs.devin.ai/desktop/devin-local/customizations.md' },
      },
    );
    const raw = Object.defineProperties(response('a', 200, { 'content-type': 'text/plain' }), {
      redirected: { value: true },
      url: { value: 'https://raw.githubusercontent.com/o/new/main/src/a.ts' },
    });
    const { fetch } = fakeFetch([markdown, raw]);
    const moved = await fetchPlan(
      planFetch('https://docs.devin.ai/desktop/cascade/memories'),
      options(fetch),
    );
    expect(moved).toMatchObject({
      location: 'https://docs.devin.ai/desktop/devin-local/customizations',
    });
    // Citing the reported page plans the request the redirect ended at.
    expect(planFetch('https://docs.devin.ai/desktop/devin-local/customizations').url).toBe(
      'https://docs.devin.ai/desktop/devin-local/customizations.md',
    );
    expect(
      await fetchPlan(planFetch('https://github.com/o/old/blob/main/src/a.ts'), options(fetch)),
    ).toMatchObject({ location: 'https://github.com/o/new/blob/main/src/a.ts' });
  });

  it('does not report a redirect that ends at the requested URL', async () => {
    const page = planFetch('https://example.com/page');
    const back = Object.defineProperties(
      response('<p>a</p>', 200, { 'content-type': 'text/html' }),
      {
        redirected: { value: true },
        url: { value: 'https://example.com/page#x' },
      },
    );
    const plain = response('<p>a</p>', 200, { 'content-type': 'text/html' });
    const { fetch } = fakeFetch([back, plain]);
    expect(await fetchPlan(page, options(fetch))).not.toHaveProperty('location');
    expect(await fetchPlan(page, options(fetch))).not.toHaveProperty('location');
  });

  it('describes network errors without a cause', async () => {
    const { fetch } = fakeFetch([new Error('boom'), new Error('boom'), new Error('boom')]);
    expect(await fetchPlan(DOCS, options(fetch))).toEqual({
      ok: false,
      reason: `network error: boom${REQUESTED}`,
    });
  });
});

describe('normalizeResponse', () => {
  const github = planFetch('https://github.com/o/r/blob/main/a.ts');
  const wordpress = planFetch('https://github.blog/changelog/2026-04-24-notice/');
  const page = planFetch('https://example.com/page');

  it('hashes GitHub files as text whatever their content type', () => {
    expect(normalizeResponse(github, 'a\r\nb\n', 'application/octet-stream')).toEqual({
      ok: true,
      hash: sha256('a\nb'),
      text: 'a\nb',
    });
  });

  it('rejects HTML where Markdown was expected, so the hash never switches versions', () => {
    expect(normalizeResponse(DOCS, '<!DOCTYPE html><html></html>', 'text/html')).toEqual({
      ok: false,
      reason: 'expected Markdown or plain text, got text/html',
    });
    expect(normalizeResponse(DOCS, '<!doctype html>', 'text/plain')).toMatchObject({ ok: false });
    expect(normalizeResponse(DOCS, '# a', '')).toEqual({
      ok: false,
      reason: 'expected Markdown or plain text, got no content type',
    });
    expect(normalizeResponse(DOCS, '# a', 'text/plain; charset=utf-8')).toMatchObject({
      ok: true,
    });
  });

  it('normalizes pages by content type', () => {
    expect(normalizeResponse(page, '<p>a</p>', 'text/html; charset=utf-8')).toEqual({
      ok: true,
      hash: sha256('a'),
      text: 'a',
    });
    expect(normalizeResponse(page, 'a  \n', 'text/plain')).toEqual({
      ok: true,
      hash: sha256(normalizeText('a')),
      text: normalizeText('a'),
    });
    expect(normalizeResponse(page, '<!DOCTYPE html><p>a</p>', 'application/octet-stream')).toEqual({
      ok: true,
      hash: sha256('a'),
      text: 'a',
    });
  });

  it('hashes the title and content of exactly one WordPress post', () => {
    const post = JSON.stringify([
      { title: { rendered: 'Notice &#8217;s' }, content: { rendered: '<p>Body <b>text</b></p>' } },
    ]);
    expect(normalizeResponse(wordpress, post, 'application/json')).toEqual({
      ok: true,
      hash: sha256('Notice ’s\nBody text'),
      text: 'Notice ’s\nBody text',
    });
  });

  it.each([
    ['invalid JSON', '{', 'WordPress API returned invalid JSON'],
    ['no post', '[]', 'WordPress API did not return exactly one post'],
    ['two posts', '[{}, {}]', 'WordPress API did not return exactly one post'],
    ['a post that is not an object', '[1]', 'unexpected WordPress post'],
    ['a post without content', '[{"title": {"rendered": "t"}}]', 'unexpected WordPress post'],
  ])('rejects a WordPress response with %s', (_, body, reason) => {
    expect(normalizeResponse(wordpress, body, 'application/json')).toEqual({ ok: false, reason });
  });
});

describe('hashSources', () => {
  it('fetches each request once, even for URLs that differ only in their fragment', async () => {
    const { fetch, calls } = fakeFetch([
      () => response('<p>spec</p>', 200, { 'content-type': 'text/html' }),
    ]);
    const outcomes = await hashSources(
      ['https://example.com/spec#a', 'https://example.com/spec#b', 'http://insecure.example/'],
      { ...options(fetch), concurrency: 2 },
    );
    expect(calls).toHaveLength(1);
    expect(outcomes.get('https://example.com/spec#a')).toEqual({
      ok: true,
      hash: sha256('spec'),
      text: 'spec',
    });
    expect(outcomes.get('https://example.com/spec#b')).toEqual({
      ok: true,
      hash: sha256('spec'),
      text: 'spec',
    });
    expect(outcomes.get('http://insecure.example/')).toEqual({
      ok: false,
      reason: 'not a valid https URL',
    });
  });

  it('passes the token to GitHub API requests only', async () => {
    const { fetch, calls } = fakeFetch([response('file'), response('# docs', 200, MARKDOWN)]);
    await hashSources(
      ['https://github.com/o/r/blob/main/a.ts', 'https://code.claude.com/docs/en/memory'],
      { ...options(fetch), concurrency: 1, token: 'secret' },
    );
    const headers = calls.map((call) => new Headers(call.init.headers).get('authorization'));
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.com/repos/o/r/contents/a.ts?ref=main',
      'https://code.claude.com/docs/en/memory.md',
    ]);
    expect(headers).toEqual(['Bearer secret', null]);
  });
});

describe('mapLimit', () => {
  it('keeps input order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running--;
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, () => Promise.resolve(1))).toEqual([]);
  });
});
