import { describe, expect, it } from 'vitest';
import type { PackageSpec } from '../../src/inventory/types.js';
import { imageSpec, npmPin, packageSpec } from '../../src/inventory/package-spec.js';

const words = (line: string): string[] => line.split(' ').filter((word) => word !== '');

const npm = (
  launcher: PackageSpec['launcher'],
  name: string | undefined,
  pin: PackageSpec['pin'],
  version?: string,
): PackageSpec => ({
  launcher,
  ecosystem: 'npm',
  ...(name === undefined ? {} : { name }),
  ...(version === undefined ? {} : { version }),
  pin,
});

const pypi = (
  launcher: PackageSpec['launcher'],
  name: string | undefined,
  pin: PackageSpec['pin'],
  version?: string,
): PackageSpec => ({
  launcher,
  ecosystem: 'pypi',
  ...(name === undefined ? {} : { name }),
  ...(version === undefined ? {} : { version }),
  pin,
});

const oci = (name: string, pin: PackageSpec['pin'], version?: string): PackageSpec => ({
  launcher: 'docker',
  ecosystem: 'oci',
  name,
  ...(version === undefined ? {} : { version }),
  pin,
});

const local = (name: string): PackageSpec => ({ launcher: 'local', name, pin: 'local' });
const unknown: PackageSpec = { launcher: 'unknown', pin: 'unknown' };

const CASES: readonly (readonly [string, PackageSpec])[] = [
  // npx: positional package, flags before it, --package forms, versions, tags and ranges.
  [
    'npx @modelcontextprotocol/server-github',
    npm('npx', '@modelcontextprotocol/server-github', 'none'),
  ],
  [
    'npx -y @modelcontextprotocol/server-github@2025.4.8',
    npm('npx', '@modelcontextprotocol/server-github', 'exact', '2025.4.8'),
  ],
  [
    'npx --yes mcp-remote@latest https://mcp.example.com/…',
    npm('npx', 'mcp-remote', 'tag', 'latest'),
  ],
  ['npx -y @acme/mcp@^1.4.0', npm('npx', '@acme/mcp', 'range', '^1.4.0')],
  ['npx -y @acme/mcp@~1.4', npm('npx', '@acme/mcp', 'range', '~1.4')],
  ['npx -y @acme/mcp@1', npm('npx', '@acme/mcp', 'range', '1')],
  ['npx -y @acme/mcp@1.x', npm('npx', '@acme/mcp', 'range', '1.x')],
  ['npx -y @acme/mcp@>=1.0.0', npm('npx', '@acme/mcp', 'range', '>=1.0.0')],
  ['npx -y @acme/mcp@*', npm('npx', '@acme/mcp', 'range', '*')],
  ['npx -y @acme/mcp@v2.0.1', npm('npx', '@acme/mcp', 'exact', 'v2.0.1')],
  [
    'npx -y @acme/mcp@1.0.0-beta.2+build.5',
    npm('npx', '@acme/mcp', 'exact', '1.0.0-beta.2+build.5'),
  ],
  ['npx -y @acme/mcp@next', npm('npx', '@acme/mcp', 'tag', 'next')],
  ['npx -y @acme/mcp@', npm('npx', '@acme/mcp', 'none', '')],
  [
    'npx --package=@acme/tools@1.2.3 acme-mcp --port 3000',
    npm('npx', '@acme/tools', 'exact', '1.2.3'),
  ],
  ['npx -p @acme/tools@^1 acme-mcp', npm('npx', '@acme/tools', 'range', '^1')],
  ['npx --package @acme/tools acme-mcp', npm('npx', '@acme/tools', 'none')],
  [
    'npx --registry https://registry.example.com -y server-x@3.0.0',
    npm('npx', 'server-x', 'exact', '3.0.0'),
  ],
  ['npx -y -- server-x@3.0.0 --flag', npm('npx', 'server-x', 'exact', '3.0.0')],
  ['npx -y npm:server-x@3.0.0', npm('npx', 'server-x', 'exact', '3.0.0')],
  ['npx -y github:acme/server', npm('npx', 'github:acme/server', 'unknown')],
  ['npx -y acme/server', npm('npx', 'acme/server', 'unknown')],
  ['npx -y ./packages/server', npm('npx', './packages/server', 'local')],
  ['npx -y /opt/server', npm('npx', '/opt/server', 'unknown')],
  ['npx -y ../server', npm('npx', '../server', 'unknown')],
  ['npx -y file:./packages/server', npm('npx', 'file:./packages/server', 'local')],
  ['npx -c "acme-mcp"', npm('npx', undefined, 'unknown')],
  ['npx', npm('npx', undefined, 'unknown')],
  ['npx.cmd -y server-x@1.0.0', npm('npx', 'server-x', 'exact', '1.0.0')],
  ['/usr/local/bin/npx -y server-x', npm('npx', 'server-x', 'none')],
  ['cmd /c npx -y server-x@2.0.0', npm('npx', 'server-x', 'exact', '2.0.0')],
  ['env NODE_ENV=production npx -y server-x@2.0.0', npm('npx', 'server-x', 'exact', '2.0.0')],
  ['DEBUG=1 npx -y server-x', npm('npx', 'server-x', 'none')],
  ['npm exec --yes -- server-x@4.1.0', npm('npx', 'server-x', 'exact', '4.1.0')],
  ['npm x server-x', npm('npx', 'server-x', 'none')],
  ['npm --prefix tools run start', unknown],
  // pnpm dlx and pnpx, bunx and bun x, yarn dlx.
  ['pnpm dlx @acme/mcp@1.0.0', npm('pnpm-dlx', '@acme/mcp', 'exact', '1.0.0')],
  ['pnpm --silent dlx @acme/mcp', npm('pnpm-dlx', '@acme/mcp', 'none')],
  ['pnpm dlx --package=@acme/tools@2.0.0 acme', npm('pnpm-dlx', '@acme/tools', 'exact', '2.0.0')],
  ['pnpx @acme/mcp@latest', npm('pnpm-dlx', '@acme/mcp', 'tag', 'latest')],
  ['pnpm exec acme-mcp', unknown],
  ['bunx @acme/mcp@1.2.3', npm('bunx', '@acme/mcp', 'exact', '1.2.3')],
  ['bunx --bun @acme/mcp', npm('bunx', '@acme/mcp', 'none')],
  ['bun x @acme/mcp@^2', npm('bunx', '@acme/mcp', 'range', '^2')],
  ['yarn dlx @acme/mcp@3.0.0', npm('yarn-dlx', '@acme/mcp', 'exact', '3.0.0')],
  ['yarn dlx -p @acme/tools acme', npm('yarn-dlx', '@acme/tools', 'none')],
  ['yarn start', unknown],
  // uvx and uv tool run.
  ['uvx mcp-server-fetch', pypi('uvx', 'mcp-server-fetch', 'none')],
  ['uvx mcp-server-fetch@2025.1.17', pypi('uvx', 'mcp-server-fetch', 'exact', '2025.1.17')],
  ['uvx mcp-server-fetch@latest', pypi('uvx', 'mcp-server-fetch', 'tag', 'latest')],
  ['uvx mcp-server-fetch==1.2.3', pypi('uvx', 'mcp-server-fetch', 'exact', '1.2.3')],
  ['uvx mcp-server-fetch===1.2.3', pypi('uvx', 'mcp-server-fetch', 'exact', '1.2.3')],
  ['uvx mcp-server-fetch==1.2.*', pypi('uvx', 'mcp-server-fetch', 'range', '1.2.*')],
  ['uvx mcp-server-fetch>=1.0', pypi('uvx', 'mcp-server-fetch', 'range', '>=1.0')],
  ['uvx mcp-server-fetch~=1.4', pypi('uvx', 'mcp-server-fetch', 'range', '~=1.4')],
  ['uvx mcp-server-fetch[cli]==0.9.0', pypi('uvx', 'mcp-server-fetch', 'exact', '0.9.0')],
  [
    'uvx --from mcp-server-git==0.6.2 mcp-server-git --repository .',
    pypi('uvx', 'mcp-server-git', 'exact', '0.6.2'),
  ],
  ['uvx --from=mcp-server-git mcp-server-git', pypi('uvx', 'mcp-server-git', 'none')],
  ['uvx --python 3.12 -q mcp-server-time@0.6.2', pypi('uvx', 'mcp-server-time', 'exact', '0.6.2')],
  [
    'uvx --from git+https://github.com/… serena start-mcp-server',
    pypi('uvx', 'git+https://github.com/…', 'unknown'),
  ],
  ['uvx --from ./tools/server server', pypi('uvx', './tools/server', 'local')],
  ['uv tool run mcp-server-time==0.6.2', pypi('uvx', 'mcp-server-time', 'exact', '0.6.2')],
  ['uv --directory tools run server.py', local('server.py')],
  ['uv run python tools/server/main.py', local('tools/server/main.py')],
  ['uv run mcp-server', unknown],
  // pipx run.
  ['pipx run mcp-server-fetch', pypi('pipx', 'mcp-server-fetch', 'none')],
  ['pipx run mcp-server-fetch==1.0.0', pypi('pipx', 'mcp-server-fetch', 'exact', '1.0.0')],
  [
    'pipx run --spec mcp-server-fetch>=1 mcp-server-fetch',
    pypi('pipx', 'mcp-server-fetch', 'range', '>=1'),
  ],
  ['pipx run mcp-server-fetch@1.0.0', pypi('pipx', 'mcp-server-fetch', 'unknown')],
  ['pipx install mcp-server-fetch', unknown],
  // docker and podman.
  [
    'docker run -i --rm -e GITHUB_TOKEN ghcr.io/github/github-mcp-server',
    oci('ghcr.io/github/github-mcp-server', 'none'),
  ],
  ['docker run -i --rm mcp/fetch:latest', oci('mcp/fetch', 'tag', 'latest')],
  ['docker run -i --rm mcp/fetch:1.2.0', oci('mcp/fetch', 'tag', '1.2.0')],
  [
    'docker run --rm -i -v /tmp:/tmp --network=host mcp/fetch@sha256:abc123',
    oci('mcp/fetch', 'digest', 'sha256:abc123'),
  ],
  ['docker run -i mcp/fetch:1.2.0@sha256:abc123', oci('mcp/fetch', 'digest', 'sha256:abc123')],
  ['docker run -i localhost:5000/team/server', oci('localhost:5000/team/server', 'none')],
  ['docker run -i localhost:5000/team/server:2', oci('localhost:5000/team/server', 'tag', '2')],
  ['docker container run -i mcp/time', oci('mcp/time', 'none')],
  ['podman run -i mcp/time:3', oci('mcp/time', 'tag', '3')],
  ['docker exec -i box server', unknown],
  ['docker run -i --rm', { launcher: 'docker', ecosystem: 'oci', pin: 'unknown' }],
  // Local scripts.
  ['node ./dist/index.js', local('./dist/index.js')],
  ['node dist/index.js --stdio', local('dist/index.js')],
  ['node --enable-source-maps dist/index.js', local('dist/index.js')],
  [
    'node ${CLAUDE_PLUGIN_ROOT}/scripts/server.cjs',
    local('${CLAUDE_PLUGIN_ROOT}/scripts/server.cjs'),
  ],
  ['python3 server.py', local('server.py')],
  ['bun run src/server.ts', local('src/server.ts')],
  ['deno run --allow-net server.ts', local('server.ts')],
  ['./bin/server --stdio', local('./bin/server')],
  ['${workspaceFolder}/bin/server', local('${workspaceFolder}/bin/server')],
  ['node -e console.log(1)', unknown],
  ['python -m mcp_server_docker', unknown],
  ['node --require ./hook.js server.js', unknown],
  ['bun run start', unknown],
  ['node ../outside/server.js', unknown],
  ['./tools/../../server', unknown],
  ['node /opt/server/index.js', unknown],
  ['node ~/server/index.js', unknown],
  ['node $HOME/server/index.js', unknown],
  ['${CLAUDE_PLUGIN_ROOT}/../escape.sh', unknown],
  // Anything else.
  ['mcp-server-puppeteer', unknown],
  ['/usr/bin/server', unknown],
  ['', unknown],
];

describe('packageSpec', () => {
  it.each(CASES)('%s', (line, expected) => {
    expect(packageSpec(words(line))).toEqual(expected);
  });

  it('reads a command with spaces in its words', () => {
    expect(packageSpec(['npx', '-y', '@acme/mcp@1.0.0', '--root', 'My Documents'])).toEqual(
      npm('npx', '@acme/mcp', 'exact', '1.0.0'),
    );
  });
});

describe('npmPin', () => {
  it.each([
    ['1.2.3', 'exact'],
    ['=1.2.3', 'exact'],
    ['', 'none'],
    ['  ', 'none'],
    ['1.2', 'range'],
    ['^1.2.3', 'range'],
    ['1.2.3 - 2.0.0', 'range'],
    ['>=1 <2 || 3', 'range'],
    ['x', 'range'],
    ['v1', 'range'],
    ['latest', 'tag'],
    ['canary', 'tag'],
  ] as const)('%j is %s', (version, pin) => {
    expect(npmPin(version)).toBe(pin);
  });
});

describe('imageSpec', () => {
  it('needs an algorithm and a value for a digest', () => {
    expect(imageSpec('mcp/fetch@sha256:').pin).toBe('unknown');
    expect(imageSpec('mcp/fetch@latest').pin).toBe('unknown');
    expect(imageSpec('mcp/fetch:').pin).toBe('none');
    expect(imageSpec('').pin).toBe('unknown');
  });
});
