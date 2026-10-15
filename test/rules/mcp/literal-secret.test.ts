import { describe, expect, it } from 'vitest';
import { literalSecretRule, MAX_SECRET_FINDINGS } from '../../../src/rules/mcp/literal-secret.js';
import { findSecret, looksLikePlaceholder } from '../../../src/rules/mcp/secrets.js';
import { findings, lint } from '../../helpers/lint.js';
import { json, noise, rangeOf } from '../json/helpers.js';

const ID = 'mcp/literal-secret';
const rules = [literalSecretRule];

const URLSAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const LOWER36 = 'abcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Fake credentials, assembled at run time so the source never contains a contiguous token.
const TOKENS = {
  github: 'gh' + 'p_' + noise(36, 1),
  githubOauth: 'gh' + 'o_' + noise(36, 2),
  githubApp: 'gh' + 's_' + noise(36, 3),
  githubAppJwt:
    'gh' +
    's_' +
    '1234567_eyJ' +
    noise(60, 4, URLSAFE) +
    '.' +
    noise(300, 5, URLSAFE) +
    '.' +
    noise(150, 6, URLSAFE),
  githubFineGrained: 'github' + '_pat_' + noise(22, 7) + '_' + noise(59, 8),
  openai: 'sk-' + 'proj-' + noise(74, 9, URLSAFE) + 'T3Blbk' + 'FJ' + noise(74, 10, URLSAFE),
  openaiLegacy: 'sk-' + noise(20, 11) + 'T3Blbk' + 'FJ' + noise(20, 12),
  anthropic: 'sk-' + 'ant-api03-' + noise(93, 13, URLSAFE) + 'AA',
  anthropicAdmin: 'sk-' + 'ant-admin01-' + noise(93, 14, URLSAFE) + 'AA',
  slack: 'xo' + 'xb-' + '123456789012-1234567890123-' + noise(24, 15),
  aws: 'AK' + 'IA' + noise(16, 16, BASE32),
  gitlab: 'gl' + 'pat-' + noise(20, 17, URLSAFE),
  gitlabRoutable:
    'gl' + 'pat-' + noise(40, 18, URLSAFE) + '.01.' + noise(2, 19, LOWER36) + noise(7, 20, LOWER36),
  stripe: 'sk_' + 'live_' + noise(99, 21),
  google: 'AI' + 'za' + noise(35, 22, URLSAFE),
  npm: 'np' + 'm_' + noise(36, 23),
  huggingFace: 'hf' + '_' + noise(34, 24, LETTERS),
  pypi: 'pypi-' + 'AgEIcHlwaS5vcmc' + noise(80, 25, URLSAFE),
  digitalOcean: 'dop' + '_v1_' + noise(64, 26, HEX),
  shopify: 'shp' + 'at_' + noise(32, 27, HEX),
  doppler: 'dp.' + 'pt.' + noise(43, 28),
};

function run(files: Record<string, string>, targets?: Parameters<typeof lint>[1]['targets']) {
  return findings(lint(files, { rules, ...(targets ? { targets } : {}) }), ID);
}

describe('mcp/literal-secret', () => {
  it('reports a token in an MCP server env block without revealing it', () => {
    const text = json({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: TOKENS.github },
        },
      },
    });
    const result = run({ '.mcp.json': text });
    expect(result).toEqual([
      {
        ruleId: ID,
        severity: 'error',
        path: '.mcp.json',
        message:
          'mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN holds a literal GitHub personal access token ("ghp_…", 40 characters) that anyone who can read this file can copy. Revoke and rotate it, then reference it as "${GITHUB_PERSONAL_ACCESS_TOKEN}".',
        range: rangeOf(text, `"${TOKENS.github}"`),
      },
    ]);
    expect(result[0]?.message).not.toContain(TOKENS.github.slice(4, 12));
  });

  it('suggests the variable syntax of the agent that reads the file', () => {
    const header = (token: string) =>
      json({
        mcpServers: {
          api: { url: 'https://api.tools.dev/mcp', headers: { Authorization: `Bearer ${token}` } },
        },
      });
    const cursor = run({ '.cursor/mcp.json': header(TOKENS.anthropic) })[0]?.message;
    expect(cursor).toMatch(
      /^mcpServers\.api\.headers\.Authorization holds a literal Anthropic API key \("sk-a…", 108 characters\) that anyone who can read this file can copy\./,
    );
    expect(cursor).toMatch(/reference it as "\$\{env:ANTHROPIC_API_KEY\}"\.$/);
    const gemini = run({
      '.gemini/settings.json': json({ mcpServers: { aws: { env: { AWS_KEY: TOKENS.aws } } } }),
    });
    expect(gemini[0]?.message).toMatch(/reference it as "\$AWS_KEY"\.$/);
    const settings = run({
      '.claude/settings.json': json({ env: { OPENAI_API_KEY: TOKENS.openai } }),
    });
    expect(settings[0]?.message).toMatch(
      /OpenAI API key .*set it in your shell environment instead of this file\.$/,
    );
    const hooks = run({
      '.codex/hooks.json': json({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `curl -H "Authorization: token ${TOKENS.githubFineGrained}" https://api.github.com`,
                },
              ],
            },
          ],
        },
      }),
    });
    expect(hooks[0]?.message).toMatch(
      /^hooks\.SessionStart\[0\]\.hooks\[0\]\.command holds a literal GitHub fine-grained personal access token .*read it from the environment\.$/,
    );
    const plugin = run({
      'p/.claude-plugin/plugin.json': json({
        name: 'p',
        userConfig: { token: { default: TOKENS.npm } },
        mcpServers: { s: { env: { NPM_TOKEN: TOKENS.npm } } },
      }),
    });
    expect(plugin.map((finding) => finding.message.slice(-60))).toEqual([
      expect.stringContaining('declare it in "userConfig" with "sensitive": true.') as unknown,
      expect.stringContaining('reference it as "${NPM_TOKEN}".') as unknown,
    ]);
  });

  it('finds tokens inside URLs and arguments', () => {
    const text = json({
      mcpServers: {
        maps: { type: 'http', url: `https://maps.tools.dev/mcp?key=${TOKENS.google}` },
        git: {
          command: 'docker',
          args: ['run', '-e', `GITLAB_TOKEN=${TOKENS.gitlab}`, 'mcp/gitlab'],
        },
      },
    });
    expect(run({ '.mcp.json': text }).map((finding) => finding.message.split(' holds')[0])).toEqual(
      ['mcpServers.maps.url', 'mcpServers.git.args[2]'],
    );
  });

  it('does not report variable references, placeholders or near misses', () => {
    const text = json({
      mcpServers: {
        a: {
          env: {
            A: '${GITHUB_TOKEN}',
            B: '${env:GITHUB_TOKEN}',
            C: '$GITHUB_TOKEN',
            D: '%GITHUB_TOKEN%',
            E: 'gh' + 'p_' + 'x'.repeat(36),
            F: 'AK' + 'IA' + 'IOSFODNN7EXAMPLE',
            G: 'sk-...',
            H: 'sk_' + 'test_' + noise(30),
            I: 'AI' + 'za' + 'SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe',
            J: 'gh' + 'p_' + noise(35),
            K: 'gh' + 'p_' + noise(37),
            L: 'xgh' + 'p_' + noise(36),
            M: 'sk-' + noise(48),
            N: 'ghp_YOUR_TOKEN_HERE',
            O: 'xo' + 'xb-your-bot-token',
            P: 'gl' + 'pat-' + 'abcabcabcabcabcabcab',
          },
        },
      },
    });
    expect(run({ '.mcp.json': text })).toEqual([]);
  });

  it('quotes JSON keys that are not plain identifiers in the location', () => {
    const text = json({ mcpServers: { 'my server': { env: { 'X-Token': TOKENS.npm } } } });
    expect(run({ '.mcp.json': text })[0]?.message).toMatch(
      /^mcpServers\["my server"\]\.env\.X-Token holds a literal npm access token /,
    );
  });

  it('caps findings per file', () => {
    const env = Object.fromEntries(
      Array.from({ length: MAX_SECRET_FINDINGS + 4 }, (_, i) => [
        `T${i}`,
        'gh' + 'p_' + noise(36, 100 + i),
      ]),
    );
    expect(run({ '.mcp.json': json({ mcpServers: { s: { env } } }) })).toHaveLength(
      MAX_SECRET_FINDINGS,
    );
  });

  it('reports regardless of target, since the leak does not depend on the agent', () => {
    const text = json({ mcpServers: { s: { env: { T: TOKENS.npm } } } });
    expect(run({ '.mcp.json': text }, ['codex'])).toHaveLength(1);
  });

  it('ignores files that are not valid JSON', () => {
    expect(run({ '.mcp.json': `{ "token": "${TOKENS.github}" ` })).toEqual([]);
  });
});

describe('findSecret', () => {
  it.each(Object.entries(TOKENS))('detects %s', (_name, token) => {
    const found = findSecret(`prefix ${token} suffix`);
    expect(found?.start).toBe(7);
    expect(found?.length).toBe(token.length);
  });

  it('names the vendor', () => {
    expect(findSecret(TOKENS.slack)?.vendor).toBe('Slack token');
    expect(findSecret(TOKENS.githubAppJwt)?.vendor).toBe('GitHub App installation token');
    expect(findSecret(TOKENS.openaiLegacy)?.vendor).toBe('OpenAI API key');
    expect(findSecret(TOKENS.anthropicAdmin)?.vendor).toBe('Anthropic Admin API key');
  });

  it('returns the earliest token in a string', () => {
    expect(findSecret(`${TOKENS.npm} and ${TOKENS.github}`)?.start).toBe(0);
    expect(findSecret(`x ${TOKENS.github} ${TOKENS.npm}`)?.vendor).toBe(
      'GitHub personal access token',
    );
  });

  it('recognizes placeholders', () => {
    expect(looksLikePlaceholder('aaaaaabcdefghijklmnop')).toBe(true);
    expect(looksLikePlaceholder('EXAMPLEKEY1234567890')).toBe(true);
    expect(looksLikePlaceholder('abababababababababab')).toBe(true);
    expect(looksLikePlaceholder(noise(36, 99))).toBe(false);
  });

  it('stays linear on hostile strings', () => {
    const hostile = ('gh' + 'p_').repeat(50_000) + 'sk-'.repeat(50_000);
    const started = performance.now();
    expect(findSecret(hostile)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('mcp/literal-secret with AWS access key IDs', () => {
  it('reports a key ID as a warning that does not cap the score', () => {
    const text = json({ mcpServers: { aws: { env: { AWS_ACCESS_KEY_ID: TOKENS.aws } } } });
    const result = lint({ '.mcp.json': text }, { rules });
    expect(findings(result, ID)).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: '.mcp.json',
        message:
          'mcpServers.aws.env.AWS_ACCESS_KEY_ID holds a literal AWS access key ID ("AKIA…", 20 characters). The ID alone does not grant access, but it identifies the account, and its secret key is often committed next to it. Check that the secret key is not in the repository, then reference it as "${AWS_ACCESS_KEY_ID}".',
        range: rangeOf(text, `"${TOKENS.aws}"`),
      },
    ]);
    expect(result.score.capped).toBe(false);
    const secret = lint(
      { '.mcp.json': json({ mcpServers: { s: { env: { T: TOKENS.npm } } } }) },
      { rules },
    );
    expect(secret.score.capped).toBe(true);
  });

  it('prefers a credential over a key ID in the same string', () => {
    const found = findSecret(`${TOKENS.aws}:${TOKENS.github}`);
    expect(found).toMatchObject({ vendor: 'GitHub personal access token', identifier: false });
    expect(findSecret(`x ${TOKENS.aws}`)).toMatchObject({ start: 2, identifier: true });
  });
});
