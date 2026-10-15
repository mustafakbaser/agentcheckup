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
