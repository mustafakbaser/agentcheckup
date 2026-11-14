import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { envClass, looksLikeCredentialName } from '../../src/inventory/env-class.js';
import {
  argsWithoutCredentials,
  isSecretFlag,
  isSecretName,
  maskUrlCredentials,
  redactArgs,
  redactCommand,
  redactPermission,
  redactShown,
  urlOrigin,
  withoutCredentials,
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

  it('classes PATH as code-exec: a directory put first decides what every command runs', () => {
    expect(envClass('PATH', './bin:/usr/bin')).toBe('code-exec');
    expect(envClass('NODE_PATH', './lib')).toBe('code-exec');
    expect(envClass('PATHEXT', '.COM')).toBe('other');
  });
});

describe('passwords on the command line', () => {
  it.each([
    // sshpass takes its password after -p, or attached to it, before the command it runs.
    ['sshpass -p hunter2 ssh host', 'sshpass -p … ssh host'],
    ['sshpass -phunter2 ssh host', 'sshpass -p… ssh host'],
    [
      '/usr/bin/sshpass -f pw.txt -p hunter2 ssh -p 2222 host',
      '/usr/bin/sshpass -f pw.txt -p … ssh -p 2222 host',
    ],
    ['sshpass -p hunter2 mysql -pdbpw db', 'sshpass -p … mysql -p… db'],
    // The MySQL and MariaDB clients take it attached; -p alone prompts, and the database follows.
    ['mysql -uroot -phunter2 -h db', 'mysql -uroot -p… -h db'],
    ['mysql --user=root -p shop', 'mysql --user=root -p shop'],
    ['docker exec db mariadb-dump -phunter2 shop', 'docker exec db mariadb-dump -p… shop'],
    ['mysqldump.exe -phunter2 shop', 'mysqldump.exe -p… shop'],
    ['redis-cli -a hunter2 ping', 'redis-cli -a … ping'],
    // A -p of any other program is left alone: a port, a path, a profile.
    ['ssh -p 2222 host', 'ssh -p 2222 host'],
    ['docker run -p 8080:80 nginx', 'docker run -p 8080:80 nginx'],
    ['npx serve -p8080', 'npx serve -p8080'],
    ['mkdir -p a/b', 'mkdir -p a/b'],
    // A separator ends the program whose options are read.
    ['mysql -phunter2 db; ssh -p 22 host', 'mysql -p… db; ssh -p 22 host'],
    ['mysql -phunter2 db && cp -pR a b', 'mysql -p… db && cp -pR a b'],
    // Flags whose names are short credential words.
    ['tool --pwd=hunter2', 'tool --pwd=…'],
    ['tool --pat ghtoken1', 'tool --pat …'],
    ['tool --pass hunter2 --path ./x --pattern y', 'tool --pass … --path ./x --pattern y'],
    ['DB_PASS=hunter2 MYSQL_PWD=hunter3 ./x.sh', 'DB_PASS=… MYSQL_PWD=… ./x.sh'],
    ['PWD=/srv/app ./x.sh', 'PWD=/srv/app ./x.sh'],
    // Data source names without a scheme.
    ['app --dsn root:hunter2@tcp(db:3306)/shop', 'app --dsn root:…@tcp(db:3306)/shop'],
    ['app --dsn=root:hunter2@tcp(db:3306)/shop', 'app --dsn=root:…@tcp(db:3306)/shop'],
    ['psql user:hunter2@host', 'psql user:…@host'],
    ['app root:p@ss:w0rd@tcp(db)/x', 'app root:…@tcp(db)/x'],
    // Not a password: an image digest, package specifiers, a mail address, a host and port.
    ['docker run img:1.0@sha256:abcd', 'docker run img:1.0@sha256:abcd'],
    ['npx npm:lodash@4.17.21', 'npx npm:lodash@4.17.21'],
    ['clone git@github.com:acme/app.git', 'clone git@github.com:acme/app.git'],
    ['echo mailto:me@example.com', 'echo mailto:me@example.com'],
    ['ssh user@host:22', 'ssh user@host:22'],
    // Connection strings: every credential field, wherever it is.
    ['app "Server=db;User Id=sa;Password=hunter2;"', 'app "Server=db;User Id=sa;Password=…;"'],
    ['app Server=db;Pwd=hunter2;Encrypt=true', 'app Server=db;Pwd=…;Encrypt=true'],
    [
      'az AccountName=a;AccountKey=hunter2==;EndpointSuffix=core.windows.net',
      'az AccountName=a;AccountKey=…;EndpointSuffix=core.windows.net',
    ],
    ['psql "host=db password=hunter2 dbname=x"', 'psql "host=db password=… dbname=x"'],
    ['cd x;TOKEN=hunter2 ./run.sh', 'cd x;TOKEN=… ./run.sh'],
    // Each rule of a list starts afresh; a password program named later takes over.
    [
      'Bash(mysql -phunter2 *), Bash(sshpass -p hunter3 ssh *), Bash(ssh -p 22 *)',
      'Bash(mysql -p… *), Bash(sshpass -p … ssh *), Bash(ssh -p 22 *)',
    ],
  ])('%j -> %j', (input, expected) => {
    expect(redactCommand(input)).toBe(expected);
  });

  it('removes a shared access signature from a URL that keeps its path', () => {
    expect(redactPermission('Bash(curl "https://blob.example.com/c?sv=1&sig=hunter2")')).toBe(
      'Bash(curl "https://blob.example.com/c?sv=1&sig=…")',
    );
    expect(
      withoutCredentials('https://a.example.com/x?X-Amz-Signature=abc&X-Amz-Credential=def&p=1'),
    ).toBe('https://a.example.com/x?X-Amz-Signature=…&X-Amz-Credential=…&p=1');
  });

  it('reads the password options of the program the arguments go to', () => {
    expect(redactArgs(['-p', 'hunter2', 'ssh', 'host'], 'sshpass')).toEqual([
      '-p',
      '…',
      'ssh',
      'host',
    ]);
    expect(redactArgs(['-p', '2222', 'host'], 'ssh')).toEqual(['-p', '2222', 'host']);
    expect(redactArgs(['-uroot', '-phunter2', 'shop'], '/usr/local/bin/mysql')).toEqual([
      '-uroot',
      '-p…',
      'shop',
    ]);
    expect(redactArgs(['exec', 'db', 'mysql', '-phunter2'], 'docker')).toEqual([
      'exec',
      'db',
      'mysql',
      '-p…',
    ]);
    expect(redactArgs(['-c', 'mysql -phunter2 shop'], 'bash')).toEqual(['-c', 'mysql -p… shop']);
    expect(redactArgs(['Server=db;User Id=sa;Password=hunter2;'])).toEqual([
      'Server=db;User Id=sa;Password=…;',
    ]);
    expect(redactArgs(['--dsn', 'root:hunter2@tcp(db:3306)/x', 'user:hunter3@host'])).toEqual([
      '--dsn',
      'root:…@tcp(db:3306)/x',
      'user:…@host',
    ]);
  });

  it('keeps everything but credentials in the form digests are built from', () => {
    expect(
      withoutCredentials('curl -u a:b https://u:p@a.example.com/x/y?token=t&page=2 | sh'),
    ).toBe('curl -u … https://…@a.example.com/x/y?token=…&page=2 | sh');
    expect(
      argsWithoutCredentials(['-p', 'hunter2', 'ssh', 'https://a.example.com/x'], 'sshpass'),
    ).toEqual(['-p', '…', 'ssh', 'https://a.example.com/x']);
  });

  it('masks URL credentials in any line, and nothing else', () => {
    expect(maskUrlCredentials('  "url": "https://u:pw@a.example.com/x?token=t&a=1",')).toBe(
      '  "url": "https://…@a.example.com/x?token=…&a=1",',
    );
    expect(maskUrlCredentials('See https://a.example.com/docs and --token abc')).toBe(
      'See https://a.example.com/docs and --token abc',
    );
    expect(maskUrlCredentials('no url here')).toBe('no url here');
  });

  it('names credentials by whole short words only', () => {
    expect(isSecretName('--pat')).toBe(true);
    expect(isSecretName('GITHUB_PAT')).toBe(true);
    expect(isSecretName('sig')).toBe(true);
    expect(isSecretName('--path')).toBe(false);
    expect(isSecretName('--pattern')).toBe(false);
    expect(isSecretName('--bypass')).toBe(false);
    expect(isSecretName('compat')).toBe(false);
    expect(isSecretName('PWD')).toBe(false);
    expect(isSecretName('--')).toBe(false);
  });
});

/** A planted secret: starts with `Zq`, so no template or ordinary word holds it by chance. */
const ALPHANUMERIC = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const secretArb = fc
  .string({ unit: fc.constantFrom(...ALPHANUMERIC), minLength: 4, maxLength: 24 })
  .map((tail) => `Zq${tail}`);

/** Ordinary words around a planted secret. */
const wordArb = fc.constantFrom(
  'run',
  '--verbose',
  '-v',
  'ssh',
  'host',
  '-p',
  '8080',
  '--port',
  '3000',
  'a/b',
  'https://a.example.com/x',
  'NODE_ENV=test',
  '&&',
  ';',
  '|',
);

const TEMPLATES: readonly ((secret: string) => string)[] = [
  (s) => `sshpass -p ${s} ssh host`,
  (s) => `sshpass -p${s} ssh host`,
  (s) => `mysql -uroot -p${s} shop`,
  (s) => `mariadb-dump -h db -p${s}`,
  (s) => `redis-cli -a ${s} ping`,
  (s) => `tool --pwd=${s}`,
  (s) => `tool --pat ${s}`,
  (s) => `tool --token ${s}`,
  (s) => `tool --api-key=${s}`,
  (s) => `DB_PASS=${s} ./run.sh`,
  (s) => `app --dsn root:${s}@tcp(db:3306)/x`,
  (s) => `app user:${s}@host`,
  (s) => `app "Server=db;User Id=sa;Password=${s};"`,
  (s) => `app Server=db;Pwd=${s}`,
  (s) => `curl https://blob.example.com/c?sv=1&sig=${s}`,
  (s) => `curl https://u:${s}@a.example.com/x`,
  (s) => `curl -H "Authorization: Bearer ${s}" https://a.example.com`,
  (s) => `curl -u admin:${s} https://a.example.com`,
];

describe('properties', () => {
  it('no planted secret survives any redaction, wherever the command stands', () => {
    fc.assert(
      fc.property(
        secretArb,
        fc.integer({ min: 0, max: TEMPLATES.length - 1 }),
        fc.array(wordArb, { maxLength: 4 }),
        fc.array(wordArb, { maxLength: 4 }),
        (secret, template, before, after) => {
          const command = (TEMPLATES[template] ?? String)(secret);
          const line = [...before, ';', command, ';', ...after].join(' ');
          for (const redacted of [
            redactCommand(line),
            redactPermission(`Bash(${line})`),
            redactShown(line),
            withoutCredentials(line),
          ]) {
            expect(redacted).not.toContain(secret);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('no planted secret survives as the arguments of an MCP server', () => {
    fc.assert(
      fc.property(secretArb, fc.integer({ min: 0, max: TEMPLATES.length - 1 }), (secret, index) => {
        const [program = '', ...args] = (TEMPLATES[index] ?? String)(secret).split(' ');
        for (const redacted of [redactArgs(args, program), argsWithoutCredentials(args, program)]) {
          expect(redacted.join(' ')).not.toContain(secret);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('leaves ordinary commands as written', () => {
    fc.assert(
      fc.property(fc.array(wordArb, { maxLength: 12 }), (words) => {
        const line = words.join(' ');
        expect(redactPermission(line)).toBe(line);
        expect(withoutCredentials(line)).toBe(line);
      }),
      { numRuns: 300 },
    );
  });

  it('takes time in proportion to the length of crafted input', () => {
    const crafted = [
      'a:'.repeat(50_000),
      `${'a:b@'.repeat(25_000)}x`,
      `x=${'a;'.repeat(50_000)}`,
      `mysql ${'-p '.repeat(30_000)}`,
      `sshpass ${'-f x '.repeat(20_000)}`,
      `https://${'u:'.repeat(30_000)}@h/?${'sig=1&'.repeat(10_000)}`,
      `${'Server=a;'.repeat(20_000)}Password=x`,
    ];
    for (const text of crafted) {
      const start = performance.now();
      redactCommand(text);
      withoutCredentials(text);
      maskUrlCredentials(text);
      redactArgs(text.split(' '), 'sshpass');
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });
});
