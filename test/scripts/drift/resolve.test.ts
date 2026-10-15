import { describe, expect, it } from 'vitest';
import {
  apiGitHubUrl,
  gitHubHistoryUrl,
  parseGitHubBlobUrl,
  planFetch,
  rawGitHubUrl,
  textVersionUrl,
  wordPressApiUrl,
} from '../../../scripts/drift/resolve.js';

const AGENTS_MD = 'https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs';

describe('parseGitHubBlobUrl', () => {
  it('parses a blob URL on a branch', () => {
    expect(parseGitHubBlobUrl(AGENTS_MD)).toEqual({
      owner: 'openai',
      repo: 'codex',
      ref: 'main',
      path: 'codex-rs/core/src/agents_md.rs',
    });
  });

  it('ignores fragments and queries, and keeps percent-encoding', () => {
    expect(
      parseGitHubBlobUrl(
        'https://github.com/gitleaks/gitleaks/blob/master/config/my%20file.toml?plain=1#L10-L20',
      ),
    ).toEqual({
      owner: 'gitleaks',
      repo: 'gitleaks',
      ref: 'master',
      path: 'config/my%20file.toml',
    });
  });

  it.each([
    ['a tree URL', 'https://github.com/openai/codex/tree/main/codex-rs'],
    ['a repository URL', 'https://github.com/openai/codex'],
    ['a blob URL without a path', 'https://github.com/openai/codex/blob/main'],
    ['another host', 'https://gitlab.com/openai/codex/blob/main/a.rs'],
    ['http', 'http://github.com/openai/codex/blob/main/a.rs'],
    ['a port', 'https://github.com:8443/openai/codex/blob/main/a.rs'],
    ['an invalid owner', 'https://github.com/-openai/codex/blob/main/a.rs'],
    ['a path that leaves the blob', 'https://github.com/openai/codex/blob/main/../../a.rs'],
    ['an empty segment', 'https://github.com/openai/codex/blob/main/a//b.rs'],
    ['not a URL', 'github.com/openai/codex/blob/main/a.rs'],
  ])('rejects %s', (_, url) => {
    expect(parseGitHubBlobUrl(url)).toBeUndefined();
  });

  it('builds raw, API and history URLs', () => {
    const blob = parseGitHubBlobUrl(AGENTS_MD)!;
    expect(rawGitHubUrl(blob)).toBe(
      'https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/agents_md.rs',
    );
    expect(apiGitHubUrl(blob)).toBe(
      'https://api.github.com/repos/openai/codex/contents/codex-rs/core/src/agents_md.rs?ref=main',
    );
    expect(gitHubHistoryUrl(blob)).toBe(
      'https://github.com/openai/codex/commits/main/codex-rs/core/src/agents_md.rs',
    );
  });
});

describe('textVersionUrl', () => {
  it.each([
    ['https://code.claude.com/docs/en/memory', 'https://code.claude.com/docs/en/memory.md'],
    ['https://geminicli.com/docs/cli/gemini-md/', 'https://geminicli.com/docs/cli/gemini-md.md'],
    [
      'https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html',
      'https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.md',
    ],
    [
      'https://docs.gitlab.com/security/tokens/',
      'https://docs.gitlab.com/security/tokens/index.md',
    ],
    ['https://docs.gitlab.com/security/tokens', 'https://docs.gitlab.com/security/tokens/index.md'],
    [
      'https://www.rfc-editor.org/rfc/rfc8259#section-4',
      'https://www.rfc-editor.org/rfc/rfc8259.txt',
    ],
  ])('%s -> %s', (url, expected) => {
    expect(textVersionUrl(url)).toEqual({ url: expected, negotiate: false });
  });

  it('negotiates Markdown on the same URL for hosts that support it', () => {
    expect(textVersionUrl('https://cursor.com/docs/rules#frontmatter')).toEqual({
      url: 'https://cursor.com/docs/rules',
      negotiate: true,
    });
  });

  it.each([
    ['an unknown host', 'https://example.com/docs/page'],
    ['a site root', 'https://code.claude.com/'],
    ['http', 'http://code.claude.com/docs/en/memory'],
    ['a subdomain of a known host', 'https://evil.code.claude.com/docs/en/memory'],
  ])('has no text version for %s', (_, url) => {
    expect(textVersionUrl(url)).toBeUndefined();
  });
});

describe('wordPressApiUrl', () => {
  it('finds posts by slug, without the date prefix', () => {
    expect(
      wordPressApiUrl('https://github.blog/2021-09-23-announcing-npms-new-access-token-format/'),
    ).toBe(
      'https://github.blog/wp-json/wp/v2/posts?slug=announcing-npms-new-access-token-format&_fields=title,content',
    );
    expect(
      wordPressApiUrl(
        'https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/',
      ),
    ).toBe(
      'https://github.blog/wp-json/wp/v2/posts?slug=behind-githubs-new-authentication-token-formats&_fields=title,content',
    );
  });

  it('finds changelog entries in their own post type', () => {
    expect(wordPressApiUrl('https://github.blog/changelog/2026-04-24-notice-about-tokens/')).toBe(
      'https://github.blog/wp-json/wp/v2/changelogs?slug=notice-about-tokens&_fields=title,content',
    );
  });

  it('ignores other hosts and the site root', () => {
    expect(wordPressApiUrl('https://example.com/2021-09-23-post/')).toBeUndefined();
    expect(wordPressApiUrl('https://github.blog/')).toBeUndefined();
  });
});

describe('planFetch', () => {
  it('reads GitHub files from raw.githubusercontent.com without a token', () => {
    const plan = planFetch(AGENTS_MD);
    expect(plan.kind).toBe('github');
    expect(plan.url).toBe(
      'https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/agents_md.rs',
    );
    expect(plan.headers).not.toHaveProperty('authorization');
    expect(plan.redirect).toBe('follow');
  });

  it('reads GitHub files through the API with a token, and refuses redirects', () => {
    const plan = planFetch(AGENTS_MD, { token: 'ghs_test' });
    expect(plan.url.startsWith('https://api.github.com/repos/openai/codex/contents/')).toBe(true);
    expect(plan.headers['authorization']).toBe('Bearer ghs_test');
    expect(plan.headers['accept']).toBe('application/vnd.github.raw+json');
    expect(plan.redirect).toBe('error');
  });

  it('never sends the token anywhere but api.github.com', () => {
    for (const url of [
      'https://code.claude.com/docs/en/memory',
      'https://github.blog/changelog/2026-04-24-notice-about-tokens/',
      'https://example.com/page',
      'https://github.com/openai/codex/tree/main/codex-rs',
    ]) {
      expect(planFetch(url, { token: 'ghs_test' }).headers).not.toHaveProperty('authorization');
    }
  });

  it('treats a blank token as no token', () => {
    expect(planFetch(AGENTS_MD, { token: '  ' }).url.startsWith('https://raw.')).toBe(true);
  });

  it('picks text versions, WordPress and plain pages', () => {
    expect(planFetch('https://code.claude.com/docs/en/memory').kind).toBe('text');
    expect(planFetch('https://cursor.com/docs/rules').headers['accept']).toBe('text/markdown');
    expect(planFetch('https://github.blog/changelog/2026-04-24-x/').kind).toBe('wordpress');
    const page = planFetch('https://tc39.es/ecma262/multipage/structured-data.html#sec-ParseJSON');
    expect(page).toMatchObject({
      kind: 'page',
      url: 'https://tc39.es/ecma262/multipage/structured-data.html',
    });
    expect(page.headers['accept-language']).toBe('en-US,en;q=0.5');
  });

  it('throws for URLs that are not https', () => {
    expect(() => planFetch('http://example.com/')).toThrow('not a valid https URL');
    expect(() => planFetch('not a url')).toThrow('not a valid https URL');
  });
});
