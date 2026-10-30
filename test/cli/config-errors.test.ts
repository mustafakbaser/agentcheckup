import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, run } from '../../src/cli/run.js';
import { DEFAULT_CONFIG_MAX_BYTES } from '../../src/io/config-file.js';
import { canDenyPermissions, symlinksSupported } from '../io/helpers.js';
import { capture, removeTempDirs, tempDir, writeFiles } from './helpers.js';

afterEach(removeTempDirs);

const CONFIG = 'agentcheckup.config.json';

/** A repository with an AGENTS.md, and a valid configuration file outside it. */
async function repository(): Promise<{ repo: string; elsewhere: string }> {
  const dir = await tempDir();
  const repo = join(dir, 'repo');
  await writeFiles(repo, { 'AGENTS.md': '# Project\n\nUse pnpm.\n' });
  await mkdir(join(repo, '.git'));
  const elsewhere = join(dir, 'outside.json');
  await writeFile(elsewhere, '{ "targets": ["codex"] }\n');
  return { repo, elsewhere };
}

/** Every command that reads the configuration file, run in `repo`. */
const COMMANDS = [
  [],
  ['context'],
  ['tokens'],
  ['agents'],
  ['fix'],
  ['tasks'],
  ['tasks', '--check'],
];

async function expectUsageError(repo: string, args: readonly string[], message: RegExp) {
  const io = capture(repo);
  expect(await run(args, io), args.join(' ')).toBe(EXIT.usage);
  expect(io.errors()).toMatch(message);
  expect(io.errors()).not.toContain('Internal error');
  expect(io.output()).toBe('');
}

describe('a configuration file that cannot be read', () => {
  it.runIf(symlinksSupported)('is a symbolic link: every command exits 2', async () => {
    const { repo, elsewhere } = await repository();
    await symlink(elsewhere, join(repo, CONFIG));
    for (const args of COMMANDS) {
      await expectUsageError(repo, args, /Refusing to read agentcheckup\.config\.json: .*symbolic/);
    }
    await expectUsageError(repo, ['-c', CONFIG], /symbolic link/);
  });

  it('is a directory, or names one with --config', async () => {
    const { repo } = await repository();
    await mkdir(join(repo, CONFIG));
    for (const args of COMMANDS) {
      await expectUsageError(repo, args, /not a regular file/);
    }
    await expectUsageError(repo, ['-c', 'node_modules/..'], /not a regular file/);
    await expectUsageError(repo, ['-c', '/'], /not a file/);
  });

  it('is larger than the limit', async () => {
    const { repo } = await repository();
    await writeFile(join(repo, CONFIG), `{"x":"${'a'.repeat(DEFAULT_CONFIG_MAX_BYTES)}"}`);
    await expectUsageError(repo, [], /exceeds the 262144-byte limit/);
    await expectUsageError(repo, ['tasks', '--check'], /exceeds the 262144-byte limit/);
  });

  it.runIf(canDenyPermissions)('cannot be opened', async () => {
    const { repo } = await repository();
    const file = join(repo, CONFIG);
    await writeFile(file, '{}\n');
    await chmod(file, 0o000);
    try {
      for (const args of COMMANDS) await expectUsageError(repo, args, /Cannot read .*: EACCES/);
    } finally {
      await chmod(file, 0o644);
    }
  });

  it.runIf(canDenyPermissions)(
    'is in a root that cannot be listed: the root is the problem',
    async () => {
      const { repo } = await repository();
      await chmod(repo, 0o000);
      try {
        for (const args of [...COMMANDS, ['--no-config']]) {
          await expectUsageError(repo, [...args, repo], /Cannot scan .*: the directory cannot be/);
        }
      } finally {
        await chmod(repo, 0o755);
      }
    },
  );

  it('does not stop a scan when it is valid, or when --no-config skips it', async () => {
    const { repo } = await repository();
    await writeFile(join(repo, CONFIG), '{ "targets": ["codex"] }\n');
    for (const args of COMMANDS) {
      const io = capture(repo);
      expect([EXIT.ok, EXIT.findings], args.join(' ')).toContain(await run(args, io));
      expect(io.errors()).toBe('');
    }
    await mkdir(join(repo, 'nested', CONFIG), { recursive: true });
    expect(await run(['--no-config', 'nested'], capture(repo))).toBe(EXIT.ok);
  });
});
