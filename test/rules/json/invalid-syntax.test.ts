import { describe, expect, it } from 'vitest';
import { invalidSyntaxRule, issueKind } from '../../../src/rules/json/invalid-syntax.js';
import { findings, lint } from '../../helpers/lint.js';
import { rangeOf } from './helpers.js';

const ID = 'json/invalid-syntax';
const rules = [invalidSyntaxRule];

const SETTINGS_ERROR =
  'Claude Code reports a Settings Error at startup and runs without this file; a -p run skips it silently.';

function run(files: Record<string, string>, targets?: Parameters<typeof lint>[1]['targets']) {
  return findings(lint(files, { rules, ...(targets ? { targets } : {}) }), ID);
}

describe('json/invalid-syntax', () => {
  it('reports a comment in Claude Code settings at the comment', () => {
    const text = '{\n  // allow tests\n  "permissions": { "allow": ["Bash(pnpm test)"] }\n}\n';
    expect(run({ '.claude/settings.json': text })).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: '.claude/settings.json',
        message: `JSON does not allow comments, so this file does not parse. ${SETTINGS_ERROR}`,
        range: rangeOf(text, '// allow tests'),
      },
    ]);
  });

  it('reports a trailing comma at the comma, with CRLF line endings', () => {
    const text = '{\r\n  "model": "opus",\r\n  "env": { "A": "1" },\r\n}\r\n';
    expect(run({ '.claude/settings.local.json': text })).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: '.claude/settings.local.json',
        message: `JSON does not allow trailing commas, so this file does not parse. ${SETTINGS_ERROR}`,
        range: { start: { line: 3, column: 22 }, end: { line: 3, column: 23 } },
      },
    ]);
  });

  it('describes other syntax errors and empty files', () => {
    const text =
      '{\n  "mcpServers": {\n    "a": { "command": "x" }\n    "b": { "command": "y" }\n  }\n}\n';
    expect(run({ '.mcp.json': text })).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: '.mcp.json',
        message:
          'This file is not valid JSON (expected a comma). Claude Code cannot load any MCP server from this file.',
        range: rangeOf(text, '"b"'),
      },
    ]);
    expect(run({ '.codex/hooks.json': '' })[0]?.message).toBe(
      'This file is not valid JSON (expected a value). Codex skips the file with a "failed to parse hooks config" warning, so none of its hooks run.',
    );
  });

  it('accepts comments in Gemini CLI settings but not trailing commas', () => {
    const comments = '{\n  // MCP servers\n  "mcpServers": {} /* none yet */\n}\n';
    expect(run({ '.gemini/settings.json': comments })).toEqual([]);
    const trailing = '{\n  // MCP servers\n  "mcpServers": {},\n}\n';
    expect(run({ '.gemini/settings.json': trailing })).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: '.gemini/settings.json',
        message:
          'JSON does not allow trailing commas, so this file does not parse. Gemini CLI stops at startup with a configuration error until the file is fixed.',
        range: { start: { line: 3, column: 19 }, end: { line: 3, column: 20 } },
      },
    ]);
    // Gemini CLI's strip-json-comments 3.1.1 ends a line comment only at LF, so after a lone CR
    // the rest of the file is comment, and a no-break space inside a comment survives.
    expect(run({ '.gemini/settings.json': '{\r  // note\r  "a": 1\r}' })[0]?.message).toBe(
      'This file is not valid JSON (expected a closing brace). Gemini CLI stops at startup with a configuration error until the file is fixed.',
    );
    expect(
      run({ '.gemini/settings.json': `{ /* a${String.fromCharCode(0xa0)}b */ "a": 1 }` })[0]
        ?.severity,
    ).toBe('error');
    // strip-json-comments removes an unterminated comment up to the end of the text.
    expect(run({ '.gemini/settings.json': '{ "a": 1 } /* open' })).toEqual([]);
    expect(run({ '.gemini/settings.json': '{ "a": 1 /* open' })[0]?.message).toBe(
      'This file is not valid JSON (expected a closing brace). Gemini CLI stops at startup with a configuration error until the file is fixed.',
    );
  });

  it('reports comments as information where the agent does not document its parser', () => {
    const text = '{\n  "mcpServers": {} // later\n}\n';
    expect(
      run({ '.mcp.json': text, '.cursor/mcp.json': text, '.cursor/hooks.json': text }).map(
        (finding) => [finding.path, finding.severity, finding.message],
      ),
    ).toEqual([
      [
        '.cursor/hooks.json',
        'info',
        'JSON does not allow comments. Cursor does not document whether it accepts them here; a strict JSON parser rejects the whole file.',
      ],
      [
        '.cursor/mcp.json',
        'info',
        'JSON does not allow comments. Cursor does not document whether it accepts them here; a strict JSON parser rejects the whole file.',
      ],
      [
        '.mcp.json',
        'info',
        'JSON does not allow comments. Claude Code does not document whether it accepts them here; a strict JSON parser rejects the whole file.',
      ],
    ]);
  });

  it('reports a broken plugin manifest', () => {
    expect(run({ '.claude-plugin/plugin.json': '{ "name": "x", }' })[0]?.message).toBe(
      'JSON does not allow trailing commas, so this file does not parse. Claude Code reports a corrupt manifest file, and the plugin cannot be installed.',
    );
  });

  it("does not report valid files or agentcheckup's own parser limits", () => {
    const deep = `${'['.repeat(600)}${']'.repeat(600)}`;
    expect(
      run({
        '.claude/settings.json': '{ "model": "opus" }\n',
        '.mcp.json': '{"mcpServers":{}}',
        '.cursor/hooks.json': deep,
        '.gemini/settings.json': '{}',
      }),
    ).toEqual([]);
    expect(issueKind({ code: 'too-large', message: '', span: { offset: 0, length: 0 } })).toBe(
      'limit',
    );
    expect(
      issueKind({ code: 'unexpected-end-of-comment', message: '', span: { offset: 0, length: 0 } }),
    ).toBe('other');
  });

  it('respects targets', () => {
    const files = { '.cursor/mcp.json': '{', '.codex/hooks.json': '{' };
    expect(run(files, ['claude-code'])).toEqual([]);
    expect(run(files, ['codex']).map((finding) => finding.path)).toEqual(['.codex/hooks.json']);
  });
});
