/**
 * `--untrusted` scans what agents load even when the repository's own .gitignore names it, so a
 * pull request cannot hide a committed `.mcp.json` from the scan by also ignoring it. Without
 * `--untrusted` the scan keeps honoring .gitignore.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { run, type Io } from '../../src/cli/run.js';

let work: string;
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'agentcheckup-cli-'));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function scanJson(args: readonly string[]): Promise<{
  readonly artifacts: readonly { readonly path: string }[];
  readonly inventory: { readonly mcpServers: readonly { readonly id: string }[] };
}> {
  const out: string[] = [];
  const io: Io = {
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    cwd: work,
    env: {},
    isTTY: false,
  };
  await run(['.', '--format', 'json', ...args], io);
  return JSON.parse(out.join('')) as never;
}

it('scans gitignored agent configuration with --untrusted only', async () => {
  await mkdir(join(work, '.claude'));
  await writeFile(join(work, '.gitignore'), '.mcp.json\n.claude/\n');
  await writeFile(
    join(work, '.mcp.json'),
    '{"mcpServers":{"browser":{"command":"npx","args":["-y","@acme/browser-mcp"]}}}',
  );
  await writeFile(join(work, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash"]}}');

  const trusted = await scanJson([]);
  expect(trusted.artifacts).toEqual([]);
  expect(trusted.inventory.mcpServers).toEqual([]);

  const untrusted = await scanJson(['--untrusted']);
  expect(untrusted.artifacts.map((artifact) => artifact.path)).toEqual([
    '.claude/settings.json',
    '.mcp.json',
  ]);
  expect(untrusted.inventory.mcpServers.map((server) => server.id)).toEqual([
    'mcp:.mcp.json#browser',
  ]);
});

it('scans below ignored directories and in build directories with --untrusted', async () => {
  const server = '{"mcpServers":{"browser":{"command":"npx","args":["-y","@acme/browser-mcp"]}}}';
  await mkdir(join(work, 'packages', 'app'), { recursive: true });
  await mkdir(join(work, 'vendor', 'lib'), { recursive: true });
  await mkdir(join(work, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(work, '.gitignore'), 'packages/\n');
  await writeFile(join(work, 'packages', 'app', '.mcp.json'), server);
  await writeFile(join(work, 'vendor', 'lib', '.mcp.json'), server);
  // Dependency directories stay out, as README and --help say.
  await writeFile(join(work, 'node_modules', 'pkg', '.mcp.json'), server);

  const trusted = (await scanJson([])) as unknown as {
    readonly unscannedConfig: unknown;
    readonly inventory: { readonly incomplete: readonly string[] };
  };
  expect(trusted.unscannedConfig).toEqual({
    gitignored: ['packages/app/.mcp.json'],
    excluded: ['vendor/lib/.mcp.json'],
    complete: true,
  });
  expect(trusted.inventory.incomplete).toEqual([
    'excluded:packages/app/.mcp.json',
    'excluded:vendor/lib/.mcp.json',
  ]);

  const untrusted = await scanJson(['--untrusted']);
  expect(untrusted.inventory.mcpServers.map((item) => item.id)).toEqual([
    'mcp:packages/app/.mcp.json#browser',
    'mcp:vendor/lib/.mcp.json#browser',
  ]);
});
