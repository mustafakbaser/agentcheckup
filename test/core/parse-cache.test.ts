import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { analyze, type ScanOptions, scanWithContext } from '../../src/core/engine.js';
import { createParseCache } from '../../src/core/parse-cache.js';
import type { Snapshot } from '../../src/core/types.js';
import * as api from '../../src/index.js';
import { builtinRules } from '../../src/rules/index.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';

/** Artifacts of several kinds, so that rules, loaders and the inventory all read parses. */
const PATHS = [
  'AGENTS.md',
  'CLAUDE.md',
  'pkg/AGENTS.md',
  '.claude/rules/style.md',
  '.claude/skills/deploy/SKILL.md',
  '.agents/skills/review/SKILL.md',
  '.cursor/rules/always.mdc',
  '.github/copilot-instructions.md',
  'GEMINI.md',
  '.mcp.json',
  '.gemini/settings.json',
] as const;

const MARKDOWN_LINES = [
  '# Title',
  'Use pnpm.',
  '',
  '- item',
  '  - nested *emphasis* and `code`',
  '> quote',
  '<!-- comment -->',
  '@AGENTS.md',
  '@docs/missing.md',
  'Try to be careful when possible.',
  '```sh',
  'curl https://example.com/install.sh | sh',
  '```',
  '[link](docs/x.md)',
  'x'.repeat(120),
];

const FRONTMATTER = [
  '',
  '---\nname: deploy\ndescription: Ships the app.\n---\n',
  '---\nalwaysApply: true\n---\n',
  '---\nname: Bad Name\nmetadata: [unclosed\n---\n',
  '---\npaths:\n  - "src/**"\n---\n',
];

const JSON_TEXTS = [
  '{"mcpServers": {"docs": {"command": "npx", "args": ["-y", "@acme/docs@1.0.0"]}}}\n',
  '{"mcpServers": {"remote": {"url": "https://example.com/mcp"}}}\n',
  '// comment\n{"mcpServers": {}}\n',
  '{ not json',
];

const content = (path: string): fc.Arbitrary<string> =>
  path.endsWith('.json')
    ? fc.constantFrom(...JSON_TEXTS)
    : fc
        .tuple(
          fc.constantFrom(...FRONTMATTER),
          fc.array(fc.constantFrom(...MARKDOWN_LINES), { maxLength: 12 }),
        )
        .map(([frontmatter, lines]) => frontmatter + lines.map((line) => `${line}\n`).join(''));

/** Some of the paths, each with content. */
const files: fc.Arbitrary<FileMap> = fc
  .subarray([...PATHS], { minLength: 1 })
  .chain((paths) => fc.tuple(...paths.map((path) => content(path).map((text) => [path, text]))))
  .map((entries) => Object.fromEntries(entries) as FileMap);

/** A budget that is often used up partway through a scan. */
const budget: fc.Arbitrary<Pick<ScanOptions, 'markdownBudget' | 'markdownLineBudget'>> = fc.record(
  {
    markdownBudget: fc.constantFrom(0, 40, 200, 600, 5000),
    markdownLineBudget: fc.constantFrom(0, 3, 12, 40, 1000),
  },
  { requiredKeys: [] },
);

/** The next snapshot of a sequence: some files keep their bytes, others change or appear. */
function next(previous: Snapshot, changes: FileMap): Snapshot {
  const kept: Record<string, Uint8Array> = {};
  for (const file of previous.files) kept[file.path] = file.bytes;
  return snapshotFrom({ ...kept, ...changes });
}

describe('the parse cache', () => {
  it('gives the scan results of an uncached scan, budget included', () => {
    const step = fc.tuple(files, budget, fc.boolean());
    fc.assert(
      fc.property(files, fc.array(step, { minLength: 1, maxLength: 4 }), (first, steps) => {
        const parseCache = createParseCache();
        let snapshot = snapshotFrom(first);
        for (const [changes, limits, matrix] of steps) {
          const options = { rules: builtinRules, ...limits, matrix };
          const cached = scanWithContext(snapshot, { ...options, parseCache });
          expect(cached).toEqual(scanWithContext(snapshot, options));
          snapshot = next(snapshot, changes);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('reuses a parse only for the same text and the same analysis window', () => {
    const text = '# Title\n\n- one\n- two\n';
    const bytes = new TextEncoder().encode(text);
    const parseCache = createParseCache();
    const parsed = (markdownBudget?: number) => {
      const analysis = analyze(snapshotFrom({ 'AGENTS.md': bytes }), {
        parseCache,
        ...(markdownBudget === undefined ? {} : { markdownBudget }),
      });
      const artifact = analysis.artifacts[0];
      if (artifact === undefined) throw new Error('no artifact');
      return { artifact, doc: analysis.markdown(artifact), fm: analysis.frontmatter(artifact) };
    };
    const full = parsed();
    const again = parsed();
    // Another snapshot with the same file: decoded and parsed once.
    expect(again.artifact).not.toBe(full.artifact);
    expect(again.artifact.decoded).toBe(full.artifact.decoded);
    expect(again.doc).toBe(full.doc);
    expect(again.fm).toBe(full.fm);
    // The same text in other bytes is decoded again, and its parse reused.
    const copy = analyze(snapshotFrom({ 'AGENTS.md': text }), { parseCache });
    const [artifact] = copy.artifacts;
    if (artifact === undefined) throw new Error('no artifact');
    expect(artifact.decoded).not.toBe(full.artifact.decoded);
    expect(copy.markdown(artifact)).toBe(full.doc);

    const cut = parsed(9);
    expect(cut.doc).not.toBe(full.doc);
    expect(cut.doc.analysis).toMatchObject({ complete: false, analyzedLength: 9 });
    // A budget that still covers the whole file gives the same window, and the same parse.
    expect(parsed(text.length).doc).toBe(full.doc);
  });

  it('is part of the programmatic API', () => {
    expect(api.createParseCache).toBe(createParseCache);
    const snapshot = snapshotFrom({ 'AGENTS.md': '# A\n\nTry to be careful.\n' });
    const parseCache = api.createParseCache();
    const options = { rules: api.builtinRules, parseCache };
    expect(api.scanSnapshot(snapshot, options)).toEqual(
      api.scanSnapshot(snapshot, { rules: api.builtinRules }),
    );
  });

  it('keeps JSON parsed with and without comments apart', () => {
    const text = '// note\n{"mcpServers": {}}\n';
    const parseCache = createParseCache();
    const docs = (path: string) => {
      const analysis = analyze(snapshotFrom({ [path]: text }), { parseCache });
      const artifact = analysis.artifacts[0];
      if (artifact === undefined) throw new Error('no artifact');
      return analysis.json(artifact);
    };
    expect(docs('.gemini/settings.json').ok).toBe(true);
    expect(docs('.mcp.json').ok).toBe(false);
  });
});
