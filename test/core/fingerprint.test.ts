/**
 * Fingerprints must survive edits that do not change a finding (lines inserted above, indentation,
 * trailing commas, reordered keys) and must change when the finding is about something else.
 */
import { describe, expect, it } from 'vitest';
import { FINGERPRINT_VERSION } from '../../src/core/meta.js';
import { lineAnchor, normalizeExcerpt, WHOLE_FILE_ANCHOR } from '../../src/core/fingerprint.js';
import type { AnyRule, RuleMeta } from '../../src/core/types.js';
import type { JsonPathSegment } from '../../src/parse/types.js';
import { defineRule } from '../../src/rules/define.js';
import { builtinRules } from '../../src/rules/index.js';
import { lint } from '../helpers/lint.js';

const SOURCE = {
  title: 'test',
  url: 'https://example.com',
  checked: '2026-10-16',
  status: 'verified',
} as const;

function meta(overrides: Partial<RuleMeta>): RuleMeta {
  return {
    id: 'test/rule',
    title: 'Test rule',
    rationale: 'Test rule.',
    category: 'correctness',
    severity: 'warn',
    appliesTo: ['mcp-json'],
    platforms: ['claude-code'],
    sources: [SOURCE],
    since: '2026.10',
    ...overrides,
  };
}

/** Reports the key of each path, or its value with `on: 'value'`, in `.mcp.json`. */
function jsonRule(paths: readonly (readonly JsonPathSegment[])[], on: 'key' | 'value'): AnyRule {
  return defineRule({
    meta: meta({ id: 'test/json' }),
    defaultOptions: undefined,
    check(context) {
      for (const artifact of context.artifacts) {
        const doc = context.json(artifact);
        if (!doc.ok) continue;
        for (const path of paths) {
          const span = on === 'key' ? doc.keySpan(path) : doc.valueSpan(path);
          if (span !== undefined) context.report({ artifact, message: 'x', span });
        }
      }
    },
  });
}

function fingerprints(file: string, content: string, rules: readonly AnyRule[]): string[] {
  return lint({ [file]: content }, { rules }).findings.map((finding) => finding.fingerprint);
}

const MCP = `{
  "mcpServers": {
    "docs": { "url": "https://mcp.example.com/sse" }
  }
}
`;

describe('normalizeExcerpt', () => {
  it.each([
    ['  Use   pnpm  ', 'Use pnpm'],
    ['"docs": { "url": "x" },', '"docs": { "url": "x" }'],
    ['Run the tests.', 'Run the tests'],
    ['a = 1 ;', 'a = 1'],
    ['end. ,;', 'end'],
    ['...', ''],
    ['\t- item,\r', '- item'],
  ])('%j -> %j', (line, expected) => {
    expect(normalizeExcerpt(line)).toBe(expected);
  });

  it('keeps punctuation that changes what a line says', () => {
    for (const line of ['description:', 'Run it!', 'Why?', 'call(x)', '"quoted"', '[link]']) {
      expect(normalizeExcerpt(line)).toBe(line);
    }
    expect(lineAnchor('name: deploy')).not.toBe(lineAnchor('name: deploy2'));
    expect(lineAnchor('a')).not.toBe(WHOLE_FILE_ANCHOR);
  });
});

describe('fingerprints of JSON findings', () => {
  const server = jsonRule([['mcpServers', 'docs']], 'key');

  it('survive a trailing comma, a new sibling, reformatting, reordering and lines above', () => {
    const before = fingerprints('.mcp.json', MCP, [server]);
    expect(before).toHaveLength(1);
    const variants = [
      // A server appended after it: its line gains a trailing comma.
      `{
  "mcpServers": {
    "docs": { "url": "https://mcp.example.com/sse" },
    "browser": { "command": "npx", "args": ["-y", "@acme/browser-mcp"] }
  }
}
`,
      // Re-indented and split over lines, keys reordered, blank lines and a field above.
      `{
  "$schema": "https://example.com/schema.json",


      "mcpServers": {
            "browser": {"command": "npx"},
            "docs": {
                  "url": "https://mcp.example.com/sse"
            }
      }
}`,
      // CRLF line endings and no whitespace at all.
      MCP.replaceAll('\n', '\r\n'),
      '{"mcpServers":{"docs":{"url":"https://mcp.example.com/sse"}}}',
      // A field added to the server: a finding on the server is about the same server.
      MCP.replace('"url"', '"env": { "A": "1" }, "url"'),
    ];
    for (const variant of variants) {
      expect(fingerprints('.mcp.json', variant, [server])).toEqual(before);
    }
  });

  it('change when the finding points at another key or another value', () => {
    const before = fingerprints('.mcp.json', MCP, [server]);
    expect(
      fingerprints('.mcp.json', MCP.replace('"docs"', '"search"'), [
        jsonRule([['mcpServers', 'search']], 'key'),
      ]),
    ).not.toEqual(before);
    const url = jsonRule([['mcpServers', 'docs', 'url']], 'value');
    const changed = MCP.replace('mcp.example.com', 'other.example.com');
    expect(fingerprints('.mcp.json', changed, [url])).not.toEqual(
      fingerprints('.mcp.json', MCP, [url]),
    );
    // The same value in another file is another finding.
    expect(fingerprints('.cursor/mcp.json', MCP, [server])).not.toEqual(before);
  });

  it('identify array elements by value, not by position', () => {
    const args = (list: string) => `{"mcpServers":{"a":{"command":"npx","args":${list}}}}`;
    const second = jsonRule([['mcpServers', 'a', 'args', 1]], 'value');
    const first = jsonRule([['mcpServers', 'a', 'args', 0]], 'value');
    // "@acme/pkg" moves from index 1 to index 0: same finding.
    expect(fingerprints('.mcp.json', args('["-y","@acme/pkg"]'), [second])).toEqual(
      fingerprints('.mcp.json', args('["@acme/pkg"]'), [first]),
    );
    // Another package at the same index: another finding.
    expect(fingerprints('.mcp.json', args('["-y","@acme/pkg"]'), [second])).not.toEqual(
      fingerprints('.mcp.json', args('["-y","@acme/other"]'), [second]),
    );
  });

  it('tell objects in an array apart by their content, whatever their order', () => {
    const hooks = (list: string) => `{"mcpServers":{},"hooks":${list}}`;
    const a = '{"command":"a.sh","timeout":5}';
    const b = '{"timeout":5,"command":"b.sh"}';
    const both = jsonRule(
      [
        ['hooks', 0],
        ['hooks', 1],
      ],
      'value',
    );
    const one = jsonRule([['hooks', 0]], 'value');
    const before = fingerprints('.mcp.json', hooks(`[${a}]`), [one]);
    // A hook inserted before it: the old hook keeps its fingerprint, the new one has its own.
    const after = fingerprints('.mcp.json', hooks(`[${b},${a}]`), [both]);
    expect(after).toHaveLength(2);
    expect(after).toContain(before[0]);
    // Keys reordered inside the element: the same element.
    expect(fingerprints('.mcp.json', hooks('[{"timeout":5,"command":"a.sh"}]'), [one])).toEqual(
      before,
    );
  });

  it('number repeated findings on the same value', () => {
    const twice: AnyRule = defineRule({
      meta: meta({ id: 'test/twice' }),
      defaultOptions: undefined,
      check(context) {
        for (const artifact of context.artifacts) {
          const doc = context.json(artifact);
          const span = doc.ok ? doc.keySpan(['mcpServers', 'docs']) : undefined;
          context.report({ artifact, message: 'one', ...(span ? { span } : {}) });
          context.report({ artifact, message: 'two', ...(span ? { span } : {}) });
        }
      },
    });
    const [first, second] = fingerprints('.mcp.json', MCP, [twice]);
    expect(first?.endsWith(':1')).toBe(true);
    expect(second).toBe(`${first?.slice(0, -2) ?? ''}:2`);
  });

  it('fall back to the line text in a file that does not parse', () => {
    const broken = '{\n  "mcpServers": {\n    "docs": { "url": "x" },\n  }\n}\n';
    const rules = builtinRules.filter((rule) => rule.meta.id === 'json/invalid-syntax');
    const before = fingerprints('.mcp.json', broken, rules);
    expect(before).toHaveLength(1);
    expect(
      fingerprints('.mcp.json', `\n\n${broken.replace('    "docs"', '  "docs"')}`, rules),
    ).toEqual(before);
  });

  it('stay fast with thousands of findings in one long string', () => {
    const many: AnyRule = defineRule({
      meta: meta({ id: 'test/many' }),
      defaultOptions: undefined,
      check(context) {
        for (const artifact of context.artifacts) {
          for (let i = 0; i < 5000; i++) {
            context.report({ artifact, message: 'x', span: { offset: 40 + i * 30, length: 1 } });
          }
        }
      },
    });
    const content = `{"mcpServers":{"a":{"command":"${'word '.repeat(40_000)}"}}}`;
    const started = performance.now();
    expect(fingerprints('.mcp.json', content, [many])).toHaveLength(5000);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('fingerprints of Markdown findings', () => {
  /** Reports the line holding "bad", or the whole file when there is none. */
  const bad: AnyRule = defineRule({
    meta: meta({ id: 'test/bad', appliesTo: ['agents-md'], platforms: ['codex'] }),
    defaultOptions: undefined,
    check(context) {
      for (const artifact of context.artifacts) {
        const index = artifact.decoded.text.indexOf('bad');
        context.report({
          artifact,
          message: 'x',
          ...(index === -1 ? {} : { span: { offset: index, length: 3 } }),
        });
      }
    },
  });
  const of = (content: string) => fingerprints('AGENTS.md', content, [bad]);

  it('survive lines inserted above, re-indentation and trailing punctuation', () => {
    const before = of('# Rules\n\n- a bad idea\n');
    expect(of('# Rules\n\nIntro.\n\n-   a   bad idea.\n')).toEqual(before);
    expect(of('# Rules\r\n\r\n  - a bad idea,\r\n')).toEqual(before);
  });

  it('change when the line says something else', () => {
    expect(of('- a bad idea\n')).not.toEqual(of('- a bad plan\n'));
  });

  it('do not depend on the first line for a finding on the whole file', () => {
    expect(of('# Rules\n')).toEqual(of('# Other title\n\nMore text.\n'));
    expect(of('# Rules\n')).not.toEqual(of('bad\n'));
  });

  it('keep an unused directive stable when lines are inserted above it', () => {
    const directive =
      '<!-- agentcheckup-disable-next-line test/bad -- reviewed -->\nNothing here.\n';
    const unused = (content: string) =>
      lint({ 'AGENTS.md': content }, { rules: [bad] })
        .findings.filter((finding) => finding.ruleId === 'directive/unused')
        .map((finding) => finding.fingerprint);
    const before = unused(`# Rules\n\n${directive}`);
    expect(before).toHaveLength(1);
    expect(unused(`# Rules\n\nMore.\n\nAnd more.\n\n${directive}`)).toEqual(before);
  });
});

describe('fingerprint version', () => {
  it('is in every report', () => {
    expect(lint({ 'AGENTS.md': '# x\n' }, { rules: [] }).fingerprintVersion).toBe(
      FINGERPRINT_VERSION,
    );
    expect(FINGERPRINT_VERSION).toBe(2);
  });
});
