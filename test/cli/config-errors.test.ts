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

describe('rule options and unknown rules', () => {
  it('exits 2 for a wrong-typed or unknown option before any rule runs, in every command', async () => {
    const { repo } = await repository();
    for (const options of [{ maxLines: 'many' }, { maxLines: -5 }, { maxLine: 300 }]) {
      await writeFile(
        join(repo, CONFIG),
        JSON.stringify({ rules: { 'instr/claude-md-too-long': ['warn', options] } }),
      );
      for (const args of COMMANDS) {
        await expectUsageError(
          repo,
          args,
          /^Invalid agentcheckup\.config\.json:\n {2}- rules\["instr\/claude-md-too-long"\]/,
        );
      }
    }
    await writeFile(
      join(repo, CONFIG),
      JSON.stringify({ rules: { 'instr/codex-size-budget': ['error', { maxBytes: 0 }] } }),
    );
    await expectUsageError(
      repo,
      [],
      /rules\["instr\/codex-size-budget"\]\.maxBytes: expected a positive integer, got 0\.\n$/,
    );
  });

  it('prints each line of the error on its own line, without a line-break marker', async () => {
    const { repo } = await repository();
    await writeFile(join(repo, CONFIG), '{ "targets": ["vim"], "rules": { "a/b": 3 } }\n');
    const io = capture(repo);
    expect(await run([], io)).toBe(EXIT.usage);
    expect(io.errors()).not.toContain('⏎');
    expect(io.errors().split('\n')).toEqual([
      'Invalid agentcheckup.config.json:',
      expect.stringMatching(/^ {2}- targets\[0\]: unknown platform "vim"/),
      expect.stringMatching(/^ {2}- rules\["a\/b"\]: expected one of/),
      '',
    ]);
  });

  it('lists unknown rule ids with another error, which would hide them', async () => {
    const { repo } = await repository();
    await writeFile(
      join(repo, CONFIG),
      '{ "targets": ["vim"], "rules": { "instr/claude-md-too-lng": "warn" } }\n',
    );
    await expectUsageError(
      repo,
      [],
      /\n {2}- rules\["instr\/claude-md-too-lng"\]: unknown rule \(alone, only a warning\)\. Did you mean "instr\/claude-md-too-long"\?\n$/,
    );
  });

  it('warns about an unknown rule once: in the report of a stylish scan, else on stderr', async () => {
    const { repo } = await repository();
    await writeFile(join(repo, CONFIG), '{ "rules": { "instr/claude-md-too-lng": "warn" } }\n');
    const stylish = capture(repo);
    await run([], stylish);
    expect(stylish.output()).toContain('Unknown rule "instr/claude-md-too-lng" in configuration.');
    expect(stylish.errors()).toBe('');
    const json = capture(repo);
    await run(['--format', 'json'], json);
    expect(json.errors()).toBe(
      'Warning: Unknown rule "instr/claude-md-too-lng" in configuration.\n',
    );
    const context = capture(repo);
    await run(['context'], context);
    expect(context.errors()).toContain('Warning: Unknown rule "instr/claude-md-too-lng"');
  });
});
