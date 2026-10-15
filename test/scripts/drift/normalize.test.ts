import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  htmlToText,
  looksLikeHtml,
  normalizeContent,
  normalizeText,
  sha256,
} from '../../../scripts/drift/normalize.js';

function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/drift/${name}`, import.meta.url), 'utf8');
}

const PAGE_TEXT =
  'Memory Claude Code reads CLAUDE.md at startup and loads files imported with @path . ' +
  'Imports can be nested up to five levels deep — deeper imports are ignored. ' +
  'Files over 40 000 characters are "truncated" & reported.';

describe('htmlToText', () => {
  it('keeps the visible text of the main element', () => {
    expect(htmlToText(fixture('page.html'))).toBe(PAGE_TEXT);
  });

  it('ignores a rebuild: build ids, nonces, asset names, navigation, header, footer, comments', () => {
    expect(htmlToText(fixture('page-rebuilt.html'))).toBe(PAGE_TEXT);
    expect(sha256(htmlToText(fixture('page-rebuilt.html')))).toBe(
      sha256(htmlToText(fixture('page.html'))),
    );
  });

  it('reports a change in the text', () => {
    const edited = htmlToText(fixture('page-edited.html'));
    expect(edited).toContain('up to four levels deep');
    expect(sha256(edited)).not.toBe(sha256(htmlToText(fixture('page.html'))));
  });

  it('uses the whole document when there is no main element or more than one', () => {
    expect(htmlToText('<p>a</p><aside>b</aside>')).toBe('a b');
    expect(htmlToText('<main>a</main><main>b</main><p>c</p>')).toBe('a b c');
  });

  it('handles nested elements of a dropped kind', () => {
    expect(htmlToText('<nav>a<nav>b</nav>c</nav>d')).toBe('d');
    expect(htmlToText('<header>a<header/>b</header>c')).toBe('c');
  });

  it('keeps a literal < that does not start a tag', () => {
    expect(htmlToText('<p>a < b and 1<2</p>')).toBe('a < b and 1<2');
  });

  it('does not end a tag at a > inside a quoted attribute value', () => {
    expect(htmlToText('<a title="x > y" href=\'>\'>link</a> text')).toBe('link text');
  });

  it('survives unterminated markup without hanging', () => {
    expect(htmlToText('<p>a<script>never closed')).toBe('a');
    expect(htmlToText('<p>a<!-- never closed')).toBe('a');
    expect(htmlToText('<p title="never closed>a')).toBe('');
    expect(htmlToText('<!doctype')).toBe('');
    const many = '<script>'.repeat(20_000);
    const started = performance.now();
    expect(htmlToText(many)).toBe('');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('keeps raw text elements other than script and style', () => {
    expect(htmlToText('<textarea><b>not a tag</b></textarea>')).toBe('<b>not a tag</b>');
  });
});

describe('decodeEntities', () => {
  it('decodes numeric and common named entities', () => {
    expect(decodeEntities('&lt;a&gt; &#65;&#x42; &copy; &rsquo;')).toBe('<a> AB © ’');
  });

  it('leaves unknown and invalid entities alone', () => {
    expect(decodeEntities('&unknown; &#0; &#xD800; &#x110000; &amp')).toBe(
      '&unknown; &#0; &#xD800; &#x110000; &amp',
    );
  });
});

describe('normalizeText', () => {
  it('normalizes line endings, trailing spaces, outer blank lines and the byte order mark', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(normalizeText(`${bom}\r\n\n# Title  \r\nline\rnext\t\n\n\n`)).toBe(
      '# Title\nline\nnext',
    );
  });

  it('keeps inner blank lines and leading indentation', () => {
    expect(normalizeText('a\n\n  b')).toBe('a\n\n  b');
  });
});

describe('looksLikeHtml', () => {
  it('detects an HTML document served with another content type', () => {
    expect(looksLikeHtml('\n  <!DOCTYPE html><html>')).toBe(true);
    expect(looksLikeHtml('<html lang="en">')).toBe(true);
    expect(looksLikeHtml('# Title\n\n<html> in Markdown')).toBe(false);
  });
});

describe('normalizeContent and sha256', () => {
  it('routes by kind', () => {
    expect(normalizeContent('<p>a</p>', 'html')).toBe('a');
    expect(normalizeContent('<p>a</p>', 'text')).toBe('<p>a</p>');
  });

  it('hashes UTF-8 text with SHA-256', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
