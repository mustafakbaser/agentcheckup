/**
 * Decides what to request for a cited URL.
 *
 * - github.com blob URLs resolve to the file at the current head of the cited branch: through
 *   the REST API when a token is available, through raw.githubusercontent.com otherwise. Both
 *   return the same bytes, so the hash does not depend on which one was used.
 * - Sites that publish a Markdown or plain-text version of each page are read in that version.
 *   It has no navigation, scripts or build ids, so it changes when the text changes. Each host
 *   below was checked by hand on 2026-10-15.
 * - github.blog posts are read through the WordPress REST API, which returns the post without
 *   the lists of recent and related posts around it. Those lists change every few days.
 * - Everything else is read as served and normalized by content type (see normalize.ts).
 */

/** How a host publishes the text version of a page. */
type TextStyle =
  /** `/a/b` -> `/a/b.md`, `/a/b/` -> `/a/b.md`, `/a/b.html` -> `/a/b.md`. */
  | 'md'
  /** `/a/b` -> `/a/b.txt`. */
  | 'txt'
  /** `/a/b/` -> `/a/b/index.md`. */
  | 'index'
  /** Same URL, `Accept: text/markdown`. */
  | 'accept';

const TEXT_HOSTS: ReadonlyMap<string, TextStyle> = new Map<string, TextStyle>([
  ['agentskills.io', 'md'],
  ['code.claude.com', 'md'],
  ['code.visualstudio.com', 'md'],
  ['cursor.com', 'accept'],
  ['docs.aws.amazon.com', 'md'],
  ['docs.devin.ai', 'md'],
  ['docs.doppler.com', 'md'],
  ['docs.github.com', 'md'],
  ['docs.gitlab.com', 'index'],
  ['docs.slack.dev', 'md'],
  ['docs.stripe.com', 'md'],
  ['forum.cursor.com', 'accept'],
  ['geminicli.com', 'md'],
  ['huggingface.co', 'md'],
  ['learn.chatgpt.com', 'md'],
  ['platform.claude.com', 'md'],
  ['shopify.dev', 'md'],
  ['www.augmentcode.com', 'md'],
  // RFCs are immutable; the HTML page around them has subscriber counters.
  ['www.rfc-editor.org', 'txt'],
]);

export const USER_AGENT =
  'agentcheckup-source-drift (+https://github.com/mustafakbaser/agentcheckup)';

/** A file on github.com, as cited by a `/blob/<ref>/<path>` URL. */
export interface GitHubBlob {
  readonly owner: string;
  readonly repo: string;
  /** Branch name. Branch names containing `/` cannot be told apart from the path. */
  readonly ref: string;
  /** Path inside the repository, percent-encoded as in the cited URL. */
  readonly path: string;
}

const OWNER = /^[\da-z](?:[\da-z]|-(?=[\da-z])){0,38}$/i;
const REPO = /^[\w.-]{1,100}$/;

function parseHttps(url: string): URL | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === 'https:' && parsed.port === '' ? parsed : undefined;
}

/** Parses `https://github.com/<owner>/<repo>/blob/<ref>/<path>`; anything else is undefined. */
export function parseGitHubBlobUrl(url: string): GitHubBlob | undefined {
  const parsed = parseHttps(url);
  if (parsed?.hostname !== 'github.com') return undefined;
  const [empty, owner, repo, blob, ref, ...path] = parsed.pathname.split('/');
  if (empty !== '' || owner === undefined || repo === undefined || ref === undefined) {
    return undefined;
  }
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return undefined;
  if (blob !== 'blob' || ref === '' || path.length === 0) return undefined;
  if (path.some((part) => part === '' || part === '.' || part === '..')) return undefined;
  return { owner, repo, ref, path: path.join('/') };
}

export function rawGitHubUrl(blob: GitHubBlob): string {
  return `https://raw.githubusercontent.com/${blob.owner}/${blob.repo}/${blob.ref}/${blob.path}`;
}

export function apiGitHubUrl(blob: GitHubBlob): string {
  return `https://api.github.com/repos/${blob.owner}/${blob.repo}/contents/${blob.path}?ref=${encodeURIComponent(blob.ref)}`;
}

/** The commit history of the cited file, for issue bodies. */
export function gitHubHistoryUrl(blob: GitHubBlob): string {
  return `https://github.com/${blob.owner}/${blob.repo}/commits/${blob.ref}/${blob.path}`;
}

/** The Markdown or plain-text version of a page, when its host publishes one. */
export function textVersionUrl(url: string): { url: string; negotiate: boolean } | undefined {
  const parsed = parseHttps(url);
  const style = parsed === undefined ? undefined : TEXT_HOSTS.get(parsed.hostname);
  if (parsed === undefined || style === undefined) return undefined;
  parsed.hash = '';
  if (style === 'accept') return { url: parsed.href, negotiate: true };
  const path = parsed.pathname;
  if (path === '/') return undefined;
  if (style === 'index') {
    parsed.pathname = path.endsWith('/') ? `${path}index.md` : `${path}/index.md`;
    return { url: parsed.href, negotiate: false };
  }
  const extension = style === 'txt' ? '.txt' : '.md';
  let base = path;
  if (base.endsWith('/')) base = base.slice(0, -1);
  else if (base.endsWith('.html')) base = base.slice(0, -'.html'.length);
  parsed.pathname = `${base}${extension}`;
  return { url: parsed.href, negotiate: false };
}

/**
 * The page a requested URL stands for, the URL to cite: the inverse of {@link textVersionUrl}
 * and of {@link rawGitHubUrl}, so a redirect of a Markdown version or a raw file is reported
 * as the page it moved to. Any other URL is returned as it is.
 */
export function pageUrlOf(url: string): string {
  const parsed = parseHttps(url);
  if (parsed === undefined) return url;
  if (parsed.hostname === 'raw.githubusercontent.com') {
    const [, owner, repo, ...rest] = parsed.pathname.split('/');
    if (owner === undefined || owner === '' || repo === undefined || rest.length < 2) return url;
    return `https://github.com/${owner}/${repo}/blob/${rest.join('/')}`;
  }
  const style = TEXT_HOSTS.get(parsed.hostname);
  const path = parsed.pathname;
  if (style === 'index' && path.endsWith('/index.md')) {
    parsed.pathname = path.slice(0, -'index.md'.length);
  } else if (style === 'md' && path.endsWith('.md')) {
    parsed.pathname = path.slice(0, -'.md'.length);
  } else if (style === 'txt' && path.endsWith('.txt')) {
    parsed.pathname = path.slice(0, -'.txt'.length);
  }
  return parsed.href;
}

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

/**
 * The WordPress REST API request for a github.blog post. Changelog entries are their own post
 * type; their slug is the URL's last segment without the date.
 */
export function wordPressApiUrl(url: string): string | undefined {
  const parsed = parseHttps(url);
  if (parsed?.hostname !== 'github.blog') return undefined;
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  const last = segments.at(-1);
  if (last === undefined) return undefined;
  const type = segments[0] === 'changelog' && segments.length > 1 ? 'changelogs' : 'posts';
  const slug = last.replace(DATE_PREFIX, '');
  return `https://github.blog/wp-json/wp/v2/${type}?slug=${encodeURIComponent(slug)}&_fields=title,content`;
}

/** What to request for a cited URL, and how to read the response. */
export interface FetchPlan {
  /**
   * - `github`: a file from a repository, hashed as text.
   * - `text`: a page's Markdown or plain-text version. Any other response is an error, so the
   *   hash never silently switches between versions.
   * - `wordpress`: a WordPress REST API response with exactly one post.
   * - `page`: anything else, normalized by the response's content type.
   */
  readonly kind: 'github' | 'text' | 'wordpress' | 'page';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * `error` for requests that carry a token, so it can never follow a redirect to another
   * host. GitHub only redirects API requests for renamed repositories, and the cited URL
   * should be updated then anyway.
   */
  readonly redirect: 'follow' | 'error';
}

export interface PlanOptions {
  /** GitHub token for api.github.com. Never sent anywhere else. */
  readonly token?: string | undefined;
}

const BASE_HEADERS = {
  'user-agent': USER_AGENT,
  // Pages that localize must not depend on the machine running the check.
  'accept-language': 'en-US,en;q=0.5',
};

/** Throws for a URL that is not a valid `https:` URL. */
export function planFetch(url: string, options: PlanOptions = {}): FetchPlan {
  const page = parseHttps(url);
  if (page === undefined) throw new Error('not a valid https URL');
  const blob = parseGitHubBlobUrl(url);
  if (blob !== undefined) {
    const token = options.token?.trim() ?? '';
    if (token !== '') {
      return {
        kind: 'github',
        url: apiGitHubUrl(blob),
        headers: {
          ...BASE_HEADERS,
          accept: 'application/vnd.github.raw+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
        redirect: 'error',
      };
    }
    return {
      kind: 'github',
      url: rawGitHubUrl(blob),
      headers: { ...BASE_HEADERS, accept: '*/*' },
      redirect: 'follow',
    };
  }
  const text = textVersionUrl(url);
  if (text !== undefined) {
    return {
      kind: 'text',
      url: text.url,
      headers: {
        ...BASE_HEADERS,
        accept: text.negotiate ? 'text/markdown' : 'text/markdown, text/plain;q=0.9',
      },
      redirect: 'follow',
    };
  }
  const wordPress = wordPressApiUrl(url);
  if (wordPress !== undefined) {
    return {
      kind: 'wordpress',
      url: wordPress,
      headers: { ...BASE_HEADERS, accept: 'application/json' },
      redirect: 'follow',
    };
  }
  page.hash = '';
  return {
    kind: 'page',
    url: page.href,
    headers: { ...BASE_HEADERS, accept: 'text/html, text/plain;q=0.9, */*;q=0.1' },
    redirect: 'follow',
  };
}
