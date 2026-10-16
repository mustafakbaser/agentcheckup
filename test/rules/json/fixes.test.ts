import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { builtinRules } from '../../../src/rules/index.js';
import { duplicateKeyRule } from '../../../src/rules/json/duplicate-key.js';
import { lint } from '../../helpers/lint.js';
import { invalidSyntaxRule } from '../../../src/rules/json/invalid-syntax.js';
import { urlWithoutTypeRule } from '../../../src/rules/mcp/url-without-type.js';
import { MAX_FINDINGS_PER_FILE } from '../../../src/rules/json/access.js';
import { applied, checkGolden, fixesOf, goldenCases, readTree } from './golden-fixes.js';
import { json } from './helpers.js';

describe('json/duplicate-key fixes', () => {
  const ID = 'json/duplicate-key';
  const rules = [duplicateKeyRule];

  it.each(goldenCases(ID))('golden case %s', (name) => {
    checkGolden(ID, name);
  });

  it('deletes the earlier key as the first, a middle or the last-but-one property', () => {
    const cases: [string, string][] = [
      ['{"a": 1, "a": 2, "b": 3}', '{"a": 2, "b": 3}'],
      ['{"x": 0, "a": 1, "y": 2, "a": 3}', '{"x": 0, "y": 2, "a": 3}'],
      ['{"x": 0, "a": 1, "a": 3}', '{"x": 0, "a": 3}'],
      ['{\n  "a": 1,\n  "a": 2\n}\n', '{\n  "a": 2\n}\n'],
    ];
    for (const [before, after] of cases) {
      const [fix] = fixesOf({ '.claude/settings.json': before }, rules, ID);
      expect(fix?.class).toBe('safe');
      expect(applied({ '.claude/settings.json': before }, fix, '.claude/settings.json')).toBe(
        after,
      );
    }
  });

  it('deletes every earlier occurrence of a key repeated three times', () => {
    const text = '{"a": 1, "a": 2, "a": 3}';
    const fixes = fixesOf({ '.mcp.json': text }, rules, ID);
    expect(fixes).toHaveLength(2);
    expect(applied({ '.mcp.json': text }, fixes[0], '.mcp.json')).toBe('{"a": 2, "a": 3}');
    expect(applied({ '.mcp.json': text }, fixes[1], '.mcp.json')).toBe('{"a": 1, "a": 3}');
  });

  it('does not fix when the deletion would remove a comment', () => {
    const text = '{\n  "a": 1, // keep this note\n  "a": 2\n}\n';
    expect(fixesOf({ '.gemini/settings.json': text }, rules, ID)).toEqual([undefined]);
  });

  it('does not fix a key inside a value that a later duplicate overrides', () => {
    // The inner object is not reachable by path: deleting its key could not change anything.
    const text = '{"s": {"a": 1, "a": 2}, "s": {"b": 3}}';
    const fixes = fixesOf({ '.mcp.json': text }, rules, ID);
    expect(fixes).toHaveLength(2);
    expect(fixes[1]).toBeUndefined();
    expect(fixes[0]?.id).toBe('json/duplicate-key#delete');
  });

  it('does not fix a file that other paths link to', () => {
    const text = '{"a": 1, "a": 2}';
    const fixes = fixesOf({ '.mcp.json': text, '.cursor/mcp.json': text }, rules, ID, {
      symlinks: { '.cursor/mcp.json': '.mcp.json' },
    });
    expect(fixes).toEqual([undefined]);
  });
});

describe('json/invalid-syntax fixes', () => {
  const ID = 'json/invalid-syntax';
  const rules = [invalidSyntaxRule];

  it.each(goldenCases(ID))('golden case %s', (name) => {
    checkGolden(ID, name);
  });

  it('removes a comment on the last line and a block comment between values', () => {
    const text = '{"a": [1, /* two */ 2]}\n// end';
    const [fix] = fixesOf({ '.mcp.json': text }, rules, ID);
    expect(fix?.title).toBe('Delete 2 comments so the file is valid JSON');
    expect(applied({ '.mcp.json': text }, fix, '.mcp.json')).toBe('{"a": [1, 2]}');
  });

  it('keeps comments in Gemini CLI settings', () => {
    const text = '{\n  // note\n  "a": [1, 2,],\n}\n';
    const [fix] = fixesOf({ '.gemini/settings.json': text }, rules, ID);
    expect(applied({ '.gemini/settings.json': text }, fix, '.gemini/settings.json')).toBe(
      '{\n  // note\n  "a": [1, 2]\n}\n',
    );
  });

  it('leaves other syntax errors to the user', () => {
    for (const text of [
      '{"a": 1 "b": 2}',
      '{"a": 1, // comment\n "b": 2 "c": 3}',
      '{"a": 1 // the brace is inside the comment }',
      '{"a": "unterminated}',
    ]) {
      expect(fixesOf({ '.claude/settings.json': text }, rules, ID), text).toEqual([undefined]);
    }
  });

  it('does not fix a file that other paths link to', () => {
    const text = '{"a": 1,}';
    const result = fixesOf({ '.mcp.json': text, '.cursor/mcp.json': text }, rules, ID, {
      symlinks: { '.cursor/mcp.json': '.mcp.json' },
    });
    expect(result).toEqual([undefined]);
  });
});

describe('fix metadata of the JSON, MCP, hooks, settings and risk rules', () => {
  const FAMILIES = ['json/', 'mcp/', 'hooks/', 'settings/', 'risk/'];
  const ruleIds = builtinRules
    .map((rule) => rule.meta.id)
    .filter((id) => FAMILIES.some((family) => id.startsWith(family)));

  it('emits only declared classes, with ids of the form <rule>#<variant>', () => {
    let checked = 0;
    for (const ruleId of ruleIds) {
      let cases: string[];
      try {
        cases = goldenCases(ruleId);
      } catch {
        // No golden cases: a rule without fixes.
        continue;
      }
      for (const name of cases) {
        const files = readTree(
          fileURLToPath(new URL(`../../fixtures/fix/${ruleId}/${name}/before`, import.meta.url)),
        );
        const result = lint(files, { rules: builtinRules });
        for (const finding of result.findings) {
          if (finding.fix === undefined || !ruleIds.includes(finding.ruleId)) continue;
          const meta = builtinRules.find((rule) => rule.meta.id === finding.ruleId)?.meta;
          expect(meta?.fix?.classes, finding.ruleId).toContain(finding.fix.class);
          expect(finding.fix.id.startsWith(`${finding.ruleId}#`), finding.fix.id).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
  });
});

describe('FileFindings', () => {
  it('keeps fixes off the summary finding past the cap', () => {
    const servers = Object.fromEntries(
      Array.from({ length: MAX_FINDINGS_PER_FILE + 3 }, (_, i) => [
        `s${String(i)}`,
        { url: `https://s${String(i)}.acme-tools.dev/mcp` },
      ]),
    );
    const fixes = fixesOf(
      { '.mcp.json': json({ mcpServers: servers }) },
      [urlWithoutTypeRule],
      'mcp/url-without-type',
    );
    expect(fixes).toHaveLength(MAX_FINDINGS_PER_FILE + 1);
    expect(fixes.slice(0, -1).every((fix) => fix !== undefined)).toBe(true);
    expect(fixes.at(-1)).toBeUndefined();
  });
});
