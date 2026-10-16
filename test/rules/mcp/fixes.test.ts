import { describe, expect, it } from 'vitest';
import type { FileState } from '../../../src/fix/index.js';
import type { FixRun as VerifiedRun } from '../../../src/fix/verify.js';
import { formatFixDiff, isSecretFix, type ChangedFile } from '../../../src/report/fix-diff.js';
import { envSyntaxMismatchRule } from '../../../src/rules/mcp/env-syntax-mismatch.js';
import { geminiServerNameRule } from '../../../src/rules/mcp/gemini-server-name.js';
import { geminiTrustRule } from '../../../src/rules/mcp/gemini-trust.js';
import { insecureTransportRule } from '../../../src/rules/mcp/insecure-transport.js';
import { literalSecretRule, ROTATION_WARNING } from '../../../src/rules/mcp/literal-secret.js';
import { inferServerType, urlWithoutTypeRule } from '../../../src/rules/mcp/url-without-type.js';
import {
  applied,
  checkGolden,
  findingsOf,
  fixesOf,
  goldenCases,
  runFixes,
  SECRETS,
  selectionFor,
  shownText,
} from '../json/golden-fixes.js';
import { json } from '../json/helpers.js';

const GITHUB = SECRETS['github']!;
const SHARED = { symlinks: { '.cursor/mcp.json': '.mcp.json' } };

describe('mcp/url-without-type fixes', () => {
  const ID = 'mcp/url-without-type';
  const rules = [urlWithoutTypeRule];

  it.each(goldenCases(ID))('golden case %s', (name) => {
    checkGolden(ID, name);
  });

  it('infers the transport from the URL', () => {
    expect(inferServerType('wss://x.dev/socket')).toEqual({ type: 'ws', guessed: false });
    expect(inferServerType('WS://x.dev')).toEqual({ type: 'ws', guessed: false });
    expect(inferServerType('https://x.dev/sse')).toEqual({ type: 'sse', guessed: false });
    expect(inferServerType('https://x.dev/v1/sse/?token=a#b')).toEqual({
      type: 'sse',
      guessed: false,
    });
    expect(inferServerType('https://x.dev/mcp')).toEqual({ type: 'http', guessed: false });
    expect(inferServerType('${BASE_URL}/mcp/')).toEqual({ type: 'http', guessed: false });
    expect(inferServerType('https://x.dev/sse-proxy')).toEqual({ type: 'http', guessed: true });
    expect(inferServerType('https://x.dev')).toEqual({ type: 'http', guessed: true });
  });

  it('inserts "type" first in a server inside a plugin manifest array', () => {
    const text =
      '{"name": "p", "mcpServers": ["./mcp.json", {"api": {"url": "https://a.dev/mcp"}}]}';
    const path = '.claude-plugin/plugin.json';
    const [fix] = fixesOf({ [path]: text }, rules, ID);
    expect(applied({ [path]: text }, fix, path)).toBe(
      '{"name": "p", "mcpServers": ["./mcp.json", {"api": {"type": "http", "url": "https://a.dev/mcp"}}]}',
    );
  });

  it('is always a review fix, and fix rounds report the server it activates', () => {
    const files = { '.mcp.json': json({ mcpServers: { docs: { url: 'https://d.dev/mcp' } } }) };
    const safe = runFixes(files, selectionFor(ID, { classes: ['safe'] }));
    expect(safe.applied).toEqual([]);
    expect(safe.files).toEqual([]);
    const review = runFixes(files, selectionFor(ID));
    expect(review.applied.map((item) => item.fix.class)).toEqual(['review']);
    expect(review.applied[0]?.effects).toContainEqual(
      expect.objectContaining({ kind: 'gate', class: 'mcp', id: 'mcp:.mcp.json#docs' }),
    );
  });

  it('does not fix a file that other paths link to, and says why', () => {
    const text = json({ mcpServers: { docs: { url: 'https://d.dev/mcp' } } });
    const [finding] = findingsOf(
      { '.mcp.json': text, '.cursor/mcp.json': text },
      rules,
      ID,
      SHARED,
    );
    expect(finding?.fix).toBeUndefined();
    expect(finding?.guidance).toContain('other paths link to this file');
  });
});

describe('mcp/literal-secret fixes', () => {
  const ID = 'mcp/literal-secret';
  const rules = [literalSecretRule];

  it.each(goldenCases(ID))('golden case %s', (name) => {
    checkGolden(ID, name);
  });

  it('replaces exactly the token, so reports can redact the span the fix replaces', () => {
    const files = {
      '.mcp.json': json({
        mcpServers: { gh: { command: 'gh-mcp', args: [`--token=${GITHUB}`] } },
      }),
    };
    const [fix] = fixesOf(files, rules, ID);
    expect(fix?.warning).toBe(ROTATION_WARNING);
    expect(isSecretFix({ ruleId: ID, fix: fix! })).toBe(true);
    const change = fix?.changes[0];
    expect(change?.kind).toBe('edit');
    if (change?.kind !== 'edit') return;
    expect(change.edits).toHaveLength(1);
    const [edit] = change.edits;
    expect(files['.mcp.json'].slice(edit!.offset, edit!.offset + edit!.length)).toBe(GITHUB);
    expect(edit?.text).toBe('${GITHUB_TOKEN}');
  });

  it('never shows the credential in a title, note, warning, guidance or the dry-run diff', () => {
    const files = {
      '.mcp.json': json({ mcpServers: { gh: { command: 'x', env: { GH_TOKEN: GITHUB } } } }),
      '.claude/settings.json': json({ env: { GITHUB_TOKEN: GITHUB } }),
    };
    for (const finding of findingsOf(files, rules, ID)) {
      expect(finding.message).not.toContain(GITHUB);
      expect(finding.guidance ?? '').not.toContain(GITHUB);
      for (const text of finding.fix === undefined ? [] : shownText(finding.fix)) {
        expect(text).not.toContain(GITHUB);
        expect(text).not.toContain(GITHUB.slice(4));
      }
    }
    const run = runFixes(files, selectionFor(ID, { literalSecret: true }));
    expect(run.applied).toHaveLength(1);
    const output = formatFixDiff(reportRun(run));
    expect(output).toContain('${GH_TOKEN}');
    expect(output).toContain('ghp_…(40 chars)');
    expect(output).toContain(ROTATION_WARNING);
    expect(output).not.toContain(GITHUB);
  });

  it('applies only when the user opts in', () => {
    const files = {
      '.mcp.json': json({ mcpServers: { gh: { command: 'x', env: { GH_TOKEN: GITHUB } } } }),
    };
    const run = runFixes(files, selectionFor(ID));
    expect(run.applied).toEqual([]);
    expect(run.files).toEqual([]);
  });

  it('leaves credentials outside the fields agents expand to the user', () => {
    const cases: Record<string, string>[] = [
      // Claude Code settings: no variable expansion.
      { '.claude/settings.json': json({ env: { GITHUB_TOKEN: GITHUB } }) },
      // Plugin manifest outside a server entry.
      { '.claude-plugin/plugin.json': json({ name: 'p', userConfig: { token: GITHUB } }) },
      // A server field Claude Code does not expand.
      { '.mcp.json': json({ mcpServers: { gh: { command: 'x', note: GITHUB } } }) },
      // Two credentials in one string.
      {
        '.mcp.json': json({ mcpServers: { gh: { command: 'x', args: [`${GITHUB} ${GITHUB}`] } } }),
      },
      // An escape before the token moves its offset in the file.
      {
        '.mcp.json': `{"mcpServers": {"gh": {"command": "x", "args": ["\\u0041 ${GITHUB}"]}}}`,
      },
    ];
    for (const files of cases) {
      const found = findingsOf(files, rules, ID);
      expect(found.length, JSON.stringify(Object.keys(files))).toBeGreaterThan(0);
      expect(found.map((finding) => finding.fix)).toEqual(found.map(() => undefined));
    }
  });

  it('uses ${NAME} in a Gemini CLI string when a name character follows the token', () => {
    const path = '.gemini/settings.json';
    const joined = json({ mcpServers: { gh: { command: 'x', args: [`${GITHUB}_suffix`] } } });
    const [braced] = fixesOf({ [path]: joined }, rules, ID);
    expect(applied({ [path]: joined }, braced, path)).toContain('"${GITHUB_TOKEN}_suffix"');
    const dotted = json({ mcpServers: { gh: { command: 'x', args: [`${GITHUB}.x`] } } });
    const [plain] = fixesOf({ [path]: dotted }, rules, ID);
    expect(applied({ [path]: dotted }, plain, path)).toContain('"$GITHUB_TOKEN.x"');
  });

  it('does not fix a file that other paths link to', () => {
    const text = json({ mcpServers: { gh: { command: 'x', env: { T: GITHUB } } } });
    const [finding] = findingsOf(
      { '.mcp.json': text, '.cursor/mcp.json': text },
      rules,
      ID,
      SHARED,
    );
    expect(finding?.fix).toBeUndefined();
    expect(finding?.guidance).toBeDefined();
  });
});

describe('mcp/env-syntax-mismatch fixes', () => {
  const ID = 'mcp/env-syntax-mismatch';
  const rules = [envSyntaxMismatchRule];

  it.each(goldenCases(ID))('golden case %s', (name) => {
    checkGolden(ID, name);
  });

  it('rewrites every reference in one string', () => {
    const text = json({
      mcpServers: {
        a: {
          type: 'http',
          url: 'https://x.dev',
          headers: { A: 'Bearer $TOKEN ${env:ORG} %TEAM%' },
        },
      },
    });
    const [fix] = fixesOf({ '.mcp.json': text }, rules, ID);
    expect(fix?.title).toBe("Write 3 variable references in Claude Code's syntax");
    expect(applied({ '.mcp.json': text }, fix, '.mcp.json')).toContain(
      '"A": "Bearer ${TOKEN} ${ORG} ${TEAM}"',
    );
  });

  it('leaves Cursor built-ins to the user, with a manual step', () => {
    const claude = json({ mcpServers: { a: { command: 'x', args: ['${workspaceFolder}/data'] } } });
    const [finding] = findingsOf({ '.mcp.json': claude }, rules, ID);
    expect(finding?.fix).toBeUndefined();
    expect(finding?.guidance).toBe(
      'replace "${workspaceFolder}" with the value itself or an environment variable written as "${NAME}"',
    );
    // A built-in later in the same string keeps the whole string from being rewritten.
    const mixed = json({ mcpServers: { a: { command: 'x', args: ['${env:A}/${userHome}'] } } });
    expect(fixesOf({ '.mcp.json': mixed }, rules, ID)).toEqual([undefined]);
    const gemini = json({ mcpServers: { a: { command: 'x', cwd: '${workspaceFolder}' } } });
    expect(findingsOf({ '.gemini/settings.json': gemini }, rules, ID)[0]?.guidance).toContain(
      '"$NAME"',
    );
  });

  it('does not rewrite names that are not variable names', () => {
    const text = json({ mcpServers: { a: { command: 'x', args: ['${env:MY-VAR}'] } } });
    expect(fixesOf({ '.mcp.json': text }, rules, ID)).toEqual([undefined]);
  });

  it('is refused for a file that other paths link to', () => {
    const text = json({ mcpServers: { a: { command: 'x', args: ['${env:A}'] } } });
    const [finding] = findingsOf({ '.mcp.json': text, 'tools/.mcp.json': text }, rules, ID, {
      symlinks: { 'tools/.mcp.json': '.mcp.json' },
    });
    expect(finding?.fix).toBeUndefined();
    expect(finding?.guidance).toContain('other paths link to this file');
  });
});

describe('mcp/gemini-server-name fixes', () => {
  const ID = 'mcp/gemini-server-name';
  const rules = [geminiServerNameRule];
  const path = '.gemini/settings.json';

  it.each(goldenCases(ID))('golden case %s', (name) => {
    checkGolden(ID, name);
  });

  it('does not rename a server that settings name elsewhere or whose new name is taken', () => {
    const listed = json({
      mcp: { allowed: ['my_server'] },
      mcpServers: { my_server: { command: 'x' } },
    });
    const [finding] = findingsOf({ [path]: listed }, rules, ID);
    expect(finding?.fix).toBeUndefined();
    expect(finding?.guidance).toBe('rename it in "mcp.allowed" or "mcp.excluded" too');
    const taken = json({
      mcpServers: { my_server: { command: 'x' }, 'my-server': { command: 'y' } },
    });
    expect(fixesOf({ [path]: taken }, rules, ID)).toEqual([undefined]);
  });
});

describe('mcp/gemini-trust fixes', () => {
  const ID = 'mcp/gemini-trust';
  const rules = [geminiTrustRule];
  const path = '.gemini/settings.json';

  it.each(goldenCases(ID))('golden case %s', (name) => {
    checkGolden(ID, name);
  });

  it('removes "trust" when it is the only property, and never removes a comment', () => {
    const only = '{"mcpServers": {"a": {"trust": true}}}';
    const [fix] = fixesOf({ [path]: only }, rules, ID);
    expect(applied({ [path]: only }, fix, path)).toBe('{"mcpServers": {"a": {}}}');
    const after = '{"mcpServers": {"a": {"command": "x", "trust": true // reviewed\n}}}';
    const [kept] = fixesOf({ [path]: after }, rules, ID);
    expect(applied({ [path]: after }, kept, path)).toBe(
      '{"mcpServers": {"a": {"command": "x" // reviewed\n}}}',
    );
    const inside = '{"mcpServers": {"a": {"trust": true, // reviewed\n "command": "x"}}}';
    expect(fixesOf({ [path]: inside }, rules, ID)).toEqual([undefined]);
  });
});

describe('mcp/insecure-transport fixes', () => {
  const ID = 'mcp/insecure-transport';
  const rules = [insecureTransportRule];

  it.each(goldenCases(ID))('golden case %s', (name) => {
    checkGolden(ID, name);
  });

  it('keeps leading whitespace and the rest of the URL', () => {
    const text = json({ mcpServers: { a: { httpUrl: ' http://10.0.0.5:8080/mcp?x=1' } } });
    const [fix] = fixesOf({ '.gemini/settings.json': text }, rules, ID);
    expect(applied({ '.gemini/settings.json': text }, fix, '.gemini/settings.json')).toContain(
      '"httpUrl": " https://10.0.0.5:8080/mcp?x=1"',
    );
  });

  it('leaves the SSE deprecation to the user, with a manual step', () => {
    const text = json({ mcpServers: { old: { type: 'sse', url: 'https://old.dev/sse' } } });
    const [finding] = findingsOf({ '.mcp.json': text }, rules, ID);
    expect(finding?.fix).toBeUndefined();
    expect(finding?.guidance).toContain('Streamable HTTP');
  });
});

/** The verification run as the dry-run formatter takes it. */
function reportRun(run: VerifiedRun): Parameters<typeof formatFixDiff>[0] {
  const state: FileState = {
    sha256: '0'.repeat(64),
    encoding: 'utf-8',
    bom: false,
    lineEnding: 'lf',
  };
  const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
  const files: ChangedFile[] = run.files.map((file) =>
    file.op === 'create' || file.before === undefined
      ? { op: 'create', path: file.path, after: { text: decode(file.after), state } }
      : {
          op: 'edit',
          path: file.path,
          before: { text: decode(file.before), state },
          after: { text: decode(file.after), state },
        },
  );
  return {
    mode: 'dry-run',
    fixes: run.applied,
    files,
    manual: run.manual,
    verification: run.verification,
  };
}
