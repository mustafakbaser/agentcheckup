import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { credentialMasks, holdsCredential, maskLine } from '../../src/report/credential-mask.js';
import { changedFileHunks, type FixRun, formatFixDiff } from '../../src/report/fix-diff.js';
import { edited, GITHUB_TOKEN, planned } from './fix-fixtures.js';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Every line of `text` as a fix diff shows it. */
function masked(path: string, text: string): string[] {
  const masks = credentialMasks(path, text);
  return text.split('\n').map((line, index) => maskLine(line, masks.get(index)));
}

const MCP = json({
  mcpServers: {
    db: {
      command: 'sshpass',
      args: ['-p', 'hunter2', 'ssh', '-p', '2222', 'host'],
      env: { DB_URL: 'postgres://app:hunter3@db/x', MODE: 'fast', TOKEN: '${TOKEN}', TLS: '0' },
    },
    remote: {
      url: 'https://u:hunter4@mcp.example.com/sse?token=hunter5&page=1',
      headers: { 'X-Api': 'hunter6', Authorization: 'Bearer ${API_TOKEN}' },
    },
    github: { command: 'npx', env: { GITHUB_TOKEN } },
  },
});

describe('credentialMasks', () => {
  it('masks env and header values, credential arguments and URL credentials of JSON', () => {
    const lines = masked('.mcp.json', MCP).join('\n');
    for (const secret of ['hunter2', 'hunter3', 'hunter4', 'hunter5', 'hunter6', 'fast']) {
      expect(lines).not.toContain(secret);
    }
    expect(lines).toContain('"-p",\n        "…",\n        "ssh",\n        "-p",\n        "2222",');
    expect(lines).toContain('"DB_URL": "postgres://db/…"');
    expect(lines).toContain('"MODE": "…"');
    // References, switches and scheme words show what the server gets without a secret.
    expect(lines).toContain('"TOKEN": "${TOKEN}"');
    expect(lines).toContain('"TLS": "0"');
    expect(lines).toContain('"Authorization": "Bearer ${API_TOKEN}"');
    expect(lines).toContain('"url": "https://…@mcp.example.com/sse?token=…&page=1"');
    // A vendor token is left for the detector, which shows its prefix and length.
    expect(lines).toContain(GITHUB_TOKEN);
  });

  it('masks every value of a repeated key, not only the one a parser keeps', () => {
    const text = '{\n  "env": {\n    "X": "hunter2",\n    "X": "hunter3"\n  }\n}\n';
    expect(masked('settings.json', text).join('\n')).not.toMatch(/hunter/);
  });

  it('masks what still parses of broken JSON, and JSONC', () => {
    const text = '{\n  // note\n  "env": { "X": "hunter2", },\n  "broken": \n';
    expect(masked('.vscode/mcp.json', text).join('\n')).not.toContain('hunter2');
  });

  it('masks the env tables and shell environment of TOML', () => {
    const text = [
      '[mcp_servers.db]',
      'command = "mysql"',
      'args = ["-uroot", "-phunter2", "-h", "db"]',
      '[mcp_servers.db.env]',
      'DB_PASSWORD = "hunter3"',
      '[mcp_servers.db.http_headers]',
      'X-Key = "hunter4"',
      '[shell_environment_policy.set]',
      'NODE_OPTIONS = "--require ./x.js"',
      '',
    ].join('\n');
    const lines = masked('.codex/config.toml', text);
    expect(lines.join('\n')).not.toMatch(/hunter|x\.js/);
    expect(lines[2]).toBe('args = ["-uroot", "-p…", "-h", "db"]');
  });

  it('leaves other files alone but for URL credentials', () => {
    const text = 'Run `deploy --token abc` against https://u:pw@a.example.com/x?sig=s\n';
    expect(masked('AGENTS.md', text)[0]).toBe(
      'Run `deploy --token abc` against https://…@a.example.com/x?sig=…',
    );
  });

  it('leaves ordinary configuration as written', () => {
    const text = json({
      mcpServers: { a: { command: 'npx', args: ['-y', '@acme/x@1.0.0', '--port', '3000'] } },
      permissions: { allow: ['Bash(pnpm test:*)'] },
    });
    expect(masked('.mcp.json', text)).toEqual(text.split('\n'));
    for (const [index, line] of text.split('\n').entries()) {
      expect(holdsCredential(line, credentialMasks('.mcp.json', text).get(index))).toBe(false);
    }
  });

  it('never shows a planted env value, whatever it is', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[\w!#%&*+./:=?@^~-]{6,30}$/).map((tail) => `Zq_${tail}`),
        fc.constantFrom('env', 'headers'),
        (secret, table) => {
          const text = json({ mcpServers: { a: { command: 'x', [table]: { K: secret } } } });
          expect(masked('.mcp.json', text).join('\n')).not.toContain(secret);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('the fix diff', () => {
  const before = json({
    mcpServers: {
      legacy: {
        url: 'https://u:hunter4@legacy.example.com/sse?token=hunter5',
        headers: { 'X-Key': 'hunter6' },
        env: { DB: 'hunter7' },
      },
    },
  });
  const after = before.replace('"legacy": {\n', '"legacy": {\n      "type": "sse",\n');
  const run: FixRun = {
    mode: 'dry-run',
    fixes: [
      planned('mcp/url-without-type', {
        class: 'review',
        title: 'Add "type": "sse" to MCP server "legacy"',
        changes: [
          {
            kind: 'edit',
            path: '.mcp.json',
            edits: [{ offset: before.indexOf('"url"'), length: 0, text: '"type": "sse",\n      ' }],
          },
        ],
      }),
    ],
    files: [edited('.mcp.json', before, after)],
    manual: [],
    verification: { resolved: 1, remaining: 0, introduced: [] },
  };

  it('masks the lines it changes and the lines it shows as context', () => {
    const text = formatFixDiff(run);
    expect(text).toContain('+      "type": "sse",');
    expect(text).toContain(' "url": "https://…@legacy.example.com/sse?token=…",'.trimStart());
    expect(text).not.toMatch(/hunter/);
    expect(formatFixDiff(run, { ascii: true })).toContain('"X-Key": "..."');
  });

  it('masks the JSON hunks too, and keeps them a diff of the real text', () => {
    const [file] = run.files;
    if (file === undefined) throw new Error('no file');
    const hunks = changedFileHunks(file, (text) => text);
    expect(JSON.stringify(hunks)).not.toMatch(/hunter/);
    expect(
      hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]),
    ).toEqual([[1, 6, 1, 7]]);
  });
});
