import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Io } from '../../src/cli/run.js';

/** test/fixtures/context: nested instructions, rules, skills, MCP servers and hooks. */
export const CONTEXT_FIXTURE = fileURLToPath(new URL('../fixtures/context', import.meta.url));

export interface Captured extends Io {
  readonly out: string[];
  readonly err: string[];
  /** Everything written to stdout. */
  readonly output: () => string;
  /** Everything written to stderr. */
  readonly errors: () => string;
}

export function capture(
  cwd = process.cwd(),
  env: Record<string, string> = {},
  isTTY = false,
): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    output: () => out.join(''),
    errors: () => err.join(''),
    cwd,
    env,
    isTTY,
  };
}

const created: string[] = [];

export async function tempDir(prefix = 'agentcheckup-cli-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export async function removeTempDirs(): Promise<void> {
  const dirs = created.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

/** Writes files (POSIX paths relative to `root`), creating parent directories. */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, ...path.split('/'));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

/** A copy of the context fixture in a new temporary directory. */
export async function copyContextFixture(): Promise<string> {
  const copy = join(await tempDir(), 'repo');
  await cp(CONTEXT_FIXTURE, copy, { recursive: true });
  return copy;
}

/** The fixture's .mcp.json without the `filesystem` server, which is not pinned. */
export async function removeUnpinnedServer(repo: string): Promise<void> {
  const file = join(repo, '.mcp.json');
  const config = JSON.parse(await readFile(file, 'utf8')) as {
    mcpServers: Record<string, unknown>;
  };
  delete config.mcpServers['filesystem'];
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
