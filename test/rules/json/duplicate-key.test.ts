import { describe, expect, it } from 'vitest';
import { duplicateKeyRule } from '../../../src/rules/json/duplicate-key.js';
import { findings, lint } from '../../helpers/lint.js';
import { rangeOf } from './helpers.js';

const ID = 'json/duplicate-key';
const rules = [duplicateKeyRule];
const GENERIC =
  'JSON.parse keeps only the last value and strict parsers reject the file, so this one never takes effect.';

function run(files: Record<string, string>, targets?: Parameters<typeof lint>[1]['targets']) {
  return findings(lint(files, { rules, ...(targets ? { targets } : {}) }), ID);
}

describe('json/duplicate-key', () => {
  it('reports the earlier of two keys, which is ignored', () => {
    const text =
      '{\n  "hooks": { "Stop": [] },\n  "model": "opus",\n  "hooks": { "PreToolUse": [] }\n}\n';
    expect(run({ '.claude/settings.json': text })).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: '.claude/settings.json',
        message: `Key "hooks" is repeated later in the same object. ${GENERIC}`,
        range: rangeOf(text, '"hooks"'),
      },
    ]);
  });

  it('reports repeats in nested objects, once per overridden key', () => {
    const text =
      '{"mcpServers": {"github": {"command": "a"}, "github": {"command": "b"}, "github": {"command": "c"}}}';
    const result = run({ '.mcp.json': text });
    expect(result.map((finding) => finding.range)).toEqual([
      rangeOf(text, '"github"', 0),
      rangeOf(text, '"github"', 1),
    ]);
  });

  it('names Gemini CLI, including in settings with comments', () => {
    const text =
      '{\n  // servers\n  "mcpServers": {},\n  "mcpServers": { "a": { "command": "x" } }\n}\n';
    expect(run({ '.gemini/settings.json': text })).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: '.gemini/settings.json',
        message:
          'Key "mcpServers" is repeated later in the same object. Gemini CLI reads settings with JSON.parse, which keeps only the last value, so this one is ignored.',
        range: rangeOf(text, '"mcpServers"'),
      },
    ]);
  });

  it('does not report distinct keys, keys differing in case, or invalid files', () => {
    const files = {
      '.mcp.json': '{"mcpServers": {"GitHub": {}, "github": {}}}',
      '.cursor/mcp.json': '{"a": {"x": 1}, "b": {"x": 1}}',
      '.cursor/hooks.json': '{"a": 1, "a": 2,}',
    };
    expect(run(files)).toEqual([]);
  });

  it('skips files no targeted agent reads', () => {
    const files = { '.codex/hooks.json': '{"hooks": {}, "hooks": {}}' };
    expect(run(files, ['gemini'])).toEqual([]);
    expect(run(files, ['codex'])).toHaveLength(1);
  });
});
