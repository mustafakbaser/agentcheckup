import { beforeAll, describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/parse/frontmatter.js';
import { findImports } from '../../src/parse/imports.js';
import { parseJson, parseJsonWithComments } from '../../src/parse/json.js';
import { parseMarkdown } from '../../src/parse/markdown.js';

/**
 * 1 MiB inputs that are pathological for some parser. Before the guards in src/parse, several of
 * these took minutes to hours in micromark (see src/parse/markdown-guard.ts); they now take well
 * under a second on a laptop.
 *
 * The bound is relative so that slow or instrumented runs (coverage) do not flake: a hostile
 * input may cost at most `MAX_RATIO` times a benign document of the same size parsed in the same
 * process, and always passes under `BUDGET_MS`. Super-linear behavior breaks either bound by far.
 */
const BUDGET_MS = 2500;
const MAX_RATIO = 4;
const MiB = 1024 * 1024;

const fill = (unit: string, length = MiB): string => unit.repeat(Math.floor(length / unit.length));

function increasingBackticks(): string {
  let text = '';
  for (let run = 1; text.length < MiB; run++) text += `${'`'.repeat(run)}x `;
  return text;
}

const CASES: Record<string, () => string> = {
  'nested brackets': () => fill('['),
  'nested braces and brackets': () => fill('{"a":['),
  backticks: () => fill('`'),
  'increasing backtick runs': increasingBackticks,
  'run of @': () => fill('@'),
  '@ tokens': () => fill('@a.md@'),
  'emphasis delimiters': () => fill('*a_'),
  'emphasis in small paragraphs': () => fill(`${'*a_'.repeat(170)}\n\n`),
  'link labels': () => fill('[a]'),
  'unclosed links': () => fill('[a]('),
  'link definitions': () => fill('[a]: <\n'),
  'setext headings': () => fill('a\n---\n'),
  'nested lists': () => fill('- a\n  - b\n'),
  'nested markers per line': () => fill('- - x\n'),
  'quote list quote': () => fill('> - > x\n'),
  'quotes then paragraphs': () => fill('> a\n\nb\n\n'),
  'deep blockquote on one line': () => fill('> '),
  'deep list markers on one line': () => `${fill('- ', MiB - 2)}x`,
  'deep indentation': () =>
    Array.from({ length: 1000 }, (_, i) => `${' '.repeat(i * 2)}- x`).join('\n'),
  'tiny paragraphs': () => fill('a\n\n'),
  // Security review: unindented (lazy) continuation lines after a list item or quote.
  'lazy lines after a deep list (review case, 20 KiB)': () =>
    Array.from({ length: 63 }, (_, i) => `${' '.repeat(i * 2)}- a\n`).join('') +
    'b\n'.repeat(8192 - 63),
  'lazy lines after a list item': () => `- a\n${'b\n'.repeat(8191)}`,
  'lazy lines after a quote': () => `> a\n${'b\n'.repeat(8191)}`,
  'lazy and indented lines mixed': () => `- a\n${' b\nb\n'.repeat(4095)}`,
  'quote lines continuing only the outer quote': () => `> > a\n${'> b\n'.repeat(8191)}`,
  'indented lines continuing only the outer item': () => `- - a\n${'  b\n'.repeat(8191)}`,
  'quote lines continuing a quote but not its item': () => `> - a\n${'> b\n'.repeat(8191)}`,
  'lazy runs repeated': () =>
    fill(
      `${Array.from({ length: 63 }, (_, i) => `${' '.repeat(i * 2)}- a\n`).join('')}${'b\n'.repeat(400)}\n`,
    ),
  'list items': () => fill('- a\n'),
  'HTML comment openers': () => fill('<!--'),
  'frontmatter of quotes': () =>
    `---\na: ${'"'.repeat(60_000)}\n---\n${fill('text\n', MiB - 61_000)}`,
  'frontmatter of nested flows': () => `---\na: ${'['.repeat(30_000)}\n---\n`,
  'JSON commas': () => `[${fill(',', MiB - 2)}]`,
  'JSON comments': () => fill('/**/'),
  'JSON strings with backslashes': () => fill('"\\\\\\"'),
};

/** Runs every parser over `text` and returns the elapsed milliseconds. */
function parseAll(text: string): number {
  const started = performance.now();
  const frontmatter = parseFrontmatter(text);
  const doc = parseMarkdown(text, frontmatter);
  findImports(text, doc, 'claude');
  findImports(text, doc, 'gemini');
  parseJson(text);
  parseJsonWithComments(text);
  return performance.now() - started;
}

/** A large but ordinary instruction file: headings, prose, links, code, lists, a table. */
const BENIGN = fill(
  [
    '## Build and test',
    '',
    'Run `pnpm test` before every commit. See [the guide](./docs/guide.md) and @./docs/rules.md.',
    '',
    '- Use **named exports**; avoid default exports.',
    '  - Prefer `const` over `let`.',
    '',
    '| Command | Purpose |',
    '| --- | --- |',
    '| `pnpm lint` | Lint with *ESLint* |',
    '',
    '```ts',
    'export const answer = 42;',
    '```',
    '',
  ].join('\n'),
);

describe('performance on hostile 1 MiB inputs', () => {
  let limit = BUDGET_MS;

  beforeAll(() => {
    parseAll(BENIGN);
    const baseline = Math.min(parseAll(BENIGN), parseAll(BENIGN));
    limit = Math.max(BUDGET_MS, MAX_RATIO * baseline);
  });

  it.each(Object.keys(CASES))(
    '%s',
    (name) => {
      const elapsed = parseAll(CASES[name]?.() ?? '');
      expect(
        elapsed,
        `${name} took ${Math.round(elapsed)} ms (limit ${Math.round(limit)} ms)`,
      ).toBeLessThan(limit);
    },
    120_000,
  );
});
