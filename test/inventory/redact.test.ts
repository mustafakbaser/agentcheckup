import { describe, expect, it } from 'vitest';
import { envClass, looksLikeCredentialName } from '../../src/inventory/env-class.js';
import {
  isSecretFlag,
  redactArgs,
  redactCommand,
  redactPermission,
  urlOrigin,
} from '../../src/inventory/redact.js';

const TOKEN = `ghp_${'Zq8xW2mK9pL4vN7bR3tY6uJ1hG5fD0sA8cE2'.slice(0, 36)}`;

describe('redactCommand', () => {
  it.each([
    // Kept as written.
    ['npx -y @acme/mcp@1.0.0', 'npx -y @acme/mcp@1.0.0'],
    [
      '"$CLAUDE_PROJECT_DIR"/scripts/guard.sh --strict',
      '"$CLAUDE_PROJECT_DIR"/scripts/guard.sh --strict',
    ],
    ['pnpm lint && pnpm test', 'pnpm lint && pnpm test'],
    ['NODE_ENV=test node x.js', 'NODE_ENV=test node x.js'],
    ['echo a:b', 'echo a:b'],
    ['  spaced\tout  ', '  spaced\tout  '],
    ['', ''],
    // Values after credential flags and in credential assignments.
    ['deploy --token abc', 'deploy --token …'],
    ['deploy --token=abc', 'deploy --token=…'],
    ['GITHUB_TOKEN=abc ./x.sh', 'GITHUB_TOKEN=… ./x.sh'],
    ['curl -u admin:pw https://a.example.com', 'curl -u … https://a.example.com'],
    ["curl -H 'X-Api-Key: abc' x", "curl -H '… …' x"],
    ['curl --header "Authorization: Bearer abc" x', 'curl --header "… … …" x'],
    ['echo Authorization: Bearer abc', 'echo Authorization: … …'],
    ['echo authorization:abc', 'echo authorization:…'],
    // URLs are cut to their origin.
    ['curl https://hooks.example.com/services/T0/B0/xyz', 'curl https://hooks.example.com/…'],
    ['curl https://user:pw@a.example.com', 'curl https://a.example.com/…'],
    ['curl "https://a.example.com/?q=1"', 'curl "https://a.example.com/…"'],
    ['curl https://a.example.com/', 'curl https://a.example.com'],
    ['git clone git+ssh://git@github.com/a/b.git', 'git clone git+ssh://github.com/…'],
    ['open url=https://a.example.com/x', 'open url=https://a.example.com/…'],
    ['fetch https://', 'fetch https:///…'],
    // Vendor tokens anywhere.
    [`echo ${TOKEN}`, 'echo …'],
    [`echo "${TOKEN}"`, 'echo "…"'],
  ])('%j -> %j', (input, expected) => {
    expect(redactCommand(input)).toBe(expected);
  });
});

describe('redactPermission', () => {
  it.each([
    // Rules without credentials are kept as written.
    ['Bash(pnpm test:*)', 'Bash(pnpm test:*)'],
    ['Read(./secrets/**)', 'Read(./secrets/**)'],
    ['WebFetch(domain:api.example.com)', 'WebFetch(domain:api.example.com)'],
    ['mcp__github__get_token', 'mcp__github__get_token'],
    [
      'Bash(curl https://api.example.com/v1/items/*)',
      'Bash(curl https://api.example.com/v1/items/*)',
    ],
    ['Bash(curl https://api.example.com/?page=2)', 'Bash(curl https://api.example.com/?page=2)'],
    // Credentials are removed where commands lose them.
    ['Bash(curl -H "Authorization: Bearer abc123" *)', 'Bash(curl -H "… … …" *)'],
    ['Bash(echo Authorization: Bearer abc123)', 'Bash(echo Authorization: … …)'],
    ['Bash(API_KEY=abc123 ./deploy.sh)', 'Bash(API_KEY=… ./deploy.sh)'],
    ['Bash(deploy --token abc123)', 'Bash(deploy --token …)'],
    [`Bash(echo ${TOKEN})`, 'Bash(echo …)'],
    // A URL keeps its path, without user, password or credential-like query values.
    [
      'Bash(git push https://user:abc123@github.com/acme/app.git)',
      'Bash(git push https://…@github.com/acme/app.git)',
    ],
    [
      'Bash(curl https://api.example.com/v1?api_key=abc123&page=2#top)',
      'Bash(curl https://api.example.com/v1?api_key=…&page=2#top)',
    ],
  ])('%j -> %j', (input, expected) => {
    expect(redactPermission(input)).toBe(expected);
  });

  it('keeps rules for different paths apart', () => {
    expect(redactPermission('Bash(curl https://a.example.com/x)')).not.toBe(
      redactPermission('Bash(curl https://a.example.com/y)'),
    );
  });
});

describe('redactArgs', () => {
  it('redacts the argument after a credential flag', () => {
    expect(
      redactArgs(['--api-key', 'abc', '--port', '3000', '-H', 'Authorization: Bearer x', 'y']),
    ).toEqual(['--api-key', '…', '--port', '3000', '-H', '…', 'y']);
    expect(redactArgs(['-e', 'GITHUB_TOKEN=abc', '-e', 'LOG=debug', 'image'])).toEqual([
      '-e',
      'GITHUB_TOKEN=…',
      '-e',
      'LOG=debug',
      'image',
    ]);
    expect(redactArgs(['--headers', 'Authorization:', 'Bearer abc'])).toEqual([
      '--headers',
      '…',
      '…',
    ]);
    expect(redactArgs(['--verbose', 'Authorization:', 'Bearer abc', 'next'])).toEqual([
      '--verbose',
      'Authorization:',
      '…',
      'next',
    ]);
    expect(redactArgs([])).toEqual([]);
  });
});

describe('isSecretFlag', () => {
  it.each([
    ['--token', true],
    ['--api-key', true],
    ['"--password"', true],
    ['-H', true],
    ['-u', true],
    ['--token=x', false],
    ['--port', false],
    ['-h', false],
    ['-', false],
    ['--', false],
    ['token', false],
  ])('%s is %s', (word, expected) => {
    expect(isSecretFlag(word)).toBe(expected);
  });
});

describe('urlOrigin', () => {
  it.each([
    ['https://a.example.com', { origin: 'https://a.example.com', cut: false }],
    ['https://a.example.com:8443/x', { origin: 'https://a.example.com:8443', cut: true }],
    ['HTTPS://A.Example.COM', { origin: 'https://a.example.com', cut: false }],
    ['ws://localhost:3000', { origin: 'ws://localhost:3000', cut: false }],
    ['ssh://git@host.example/x', { origin: 'ssh://host.example', cut: true }],
    ['not a url', { origin: '://', cut: true }],
    ['file:///etc/passwd', { origin: 'file://', cut: true }],
  ])('%s', (input, expected) => {
    expect(urlOrigin(input)).toEqual(expected);
  });
});

describe('envClass', () => {
  it.each([
    ['ANTHROPIC_BASE_URL', undefined, 'endpoint'],
    ['ANTHROPIC_BEDROCK_BASE_URL', undefined, 'endpoint'],
    ['HTTPS_PROXY', undefined, 'endpoint'],
    ['https_proxy', undefined, 'endpoint'],
    ['NO_PROXY', undefined, 'endpoint'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', undefined, 'endpoint'],
    ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', undefined, 'endpoint'],
    ['ANTHROPIC_API_KEY', undefined, 'credential'],
    ['ANTHROPIC_AUTH_TOKEN', undefined, 'credential'],
    ['ANTHROPIC_CUSTOM_HEADERS', undefined, 'credential'],
    ['OTEL_EXPORTER_OTLP_HEADERS', undefined, 'credential'],
    ['OTEL_EXPORTER_OTLP_METRICS_HEADERS', undefined, 'credential'],
    ['NPM_TOKEN', undefined, 'credential'],
    ['DB_PASSWORD', undefined, 'credential'],
    ['OPENAI_API_KEY', undefined, 'credential'],
    ['github-pat', undefined, 'credential'],
    ['DATABASE_URL', 'postgres://app:pw@db/app', 'credential'],
    ['NOTE', TOKEN, 'credential'],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0', 'tls'],
    ['NODE_EXTRA_CA_CERTS', undefined, 'tls'],
    ['CLAUDE_CODE_CLIENT_KEY', undefined, 'tls'],
    ['OTEL_EXPORTER_OTLP_CLIENT_KEY', undefined, 'tls'],
    ['OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE', undefined, 'tls'],
    ['OTEL_EXPORTER_OTLP_INSECURE', undefined, 'tls'],
    ['NODE_OPTIONS', undefined, 'code-exec'],
    ['LD_PRELOAD', undefined, 'code-exec'],
    ['CLAUDE_CODE_SHELL_PREFIX', undefined, 'code-exec'],
    ['CLAUDE_ENV_FILE', undefined, 'code-exec'],
    // Not sensitive.
    ['DISABLE_TELEMETRY', '1', 'other'],
    ['DATABASE_URL', 'postgres://db/app', 'other'],
    ['OTEL_EXPORTER_OTLP_PROTOCOL', undefined, 'other'],
    ['KEY', undefined, 'other'],
    ['anthropic_base_url', undefined, 'other'],
    ['MONKEY_BUSINESS', undefined, 'other'],
    ['LOG_LEVEL', 'not a url', 'other'],
  ] as const)('%s (%s) is %s', (name, value, expected) => {
    expect(envClass(name, value)).toBe(expected);
  });

  it('reads credential names by word', () => {
    expect(looksLikeCredentialName('SLACK_BOT_TOKEN')).toBe(true);
    expect(looksLikeCredentialName('TOKENIZER_MODEL')).toBe(false);
    expect(looksLikeCredentialName('KEYBOARD_LAYOUT')).toBe(false);
  });
});
