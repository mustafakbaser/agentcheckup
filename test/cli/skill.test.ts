import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCommand, type SkillCommandOptions, UsageError } from '../../src/cli/args.js';
import { SKILL_HELP } from '../../src/cli/help.js';
import { EXIT, type Io, type Prompt, run } from '../../src/cli/run.js';
import {
  PACKAGED_SKILL,
  pinnedVersions,
  skill,
  SKILL_FILES,
  type SkillSource,
  withVersion,
} from '../../src/cli/skill.js';
import { VERSION } from '../../src/core/version.js';
import { symlinksSupported } from '../io/helpers.js';
import { REPO_ROOT, skillBytes } from '../skill/helpers.js';
import { type Captured, capture, removeTempDirs, tempDir, writeFiles } from './helpers.js';

afterEach(removeTempDirs);

const AGENTS_MD = '# Project\n\nRun `pnpm test` before you commit.\n';
const CLAUDE_TARGET = '.claude/skills/agentcheckup';
const AGENTS_TARGET = '.agents/skills/agentcheckup';

interface Scripted extends Prompt {
  readonly questions: string[];
}

/** Answers in order; undefined (or running out) is the end of input. */
function scripted(answers: readonly (string | undefined)[], isTTY = true): Scripted {
  const queue = [...answers];
  const questions: string[] = [];
  return {
    isTTY,
    questions,
    ask: (question) => {
      questions.push(question);
      return Promise.resolve(queue.shift());
    },
  };
}

/** A terminal session: stdout and stdin are TTYs. */
function terminal(cwd: string, prompt: Prompt): Captured {
  return { ...capture(cwd, {}, true), prompt };
}

async function repo(files: Record<string, string> = {}): Promise<string> {
  const root = await tempDir();
  await writeFiles(root, { 'AGENTS.md': AGENTS_MD, ...files });
  return root;
}

/** Every file below `root`, as sorted POSIX paths. */
async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .replaceAll('\\', '/'),
    )
    .sort();
}

/** `agentcheckup skill install ...args` with the packaged skill pinned as `source` says. */
async function install(io: Io, args: readonly string[], source: SkillSource = {}): Promise<number> {
  const command = parseCommand(['skill', 'install', ...args]);
  if (command.kind !== 'skill') throw new Error(`parsed as ${command.kind}`);
  return skill(command.options, io, source);
}

/** The installed files below `root`/`target`, by their path in the skill directory. */
async function installed(root: string, target: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const path of SKILL_FILES) {
    files.set(path, new Uint8Array(await readFile(join(root, ...target.split('/'), path))));
  }
  return files;
}

/** A package with a minimal skill whose body is `body`. */
async function fakeSkillPackage(body: string): Promise<string> {
  const packageRoot = await tempDir();
  await writeFiles(packageRoot, {
    'package.json': '{ "name": "agentcheckup" }\n',
    [`${PACKAGED_SKILL}/SKILL.md`]:
      '---\nname: agentcheckup\ndescription: Runs agentcheckup to check the agent configuration of this repository. Use when the user asks to check agent config.\n---\n# agentcheckup\n\n' +
      body,
    ...Object.fromEntries(
      SKILL_FILES.filter((path) => path !== 'SKILL.md').map((path) => [
        `${PACKAGED_SKILL}/${path}`,
        '# Reference\n',
      ]),
    ),
  });
  return packageRoot;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

describe('agentcheckup skill install', () => {
  it('writes the packaged skill byte for byte into .claude/skills', async () => {
    const root = await repo();
    const io = capture(root);
    expect(await run(['skill', 'install', '--yes'], io)).toBe(EXIT.ok);
    expect(io.errors()).toBe('');
    // The repository's copy pins the package version, which is the running version.
    expect(await installed(root, CLAUDE_TARGET)).toEqual(await skillBytes());
    expect(await tree(root)).toEqual([
      ...SKILL_FILES.map((path) => `${CLAUDE_TARGET}/${path}`),
      'AGENTS.md',
    ]);
    const out = io.output();
    expect(out).toContain(`Install the agentcheckup skill in ${CLAUDE_TARGET}:\n`);
    expect(out).toContain(`  ${CLAUDE_TARGET}/references/tasks.md\n`);
    expect(out).toContain(
      'Claude Code, Cursor, GitHub Copilot, Windsurf and Cline load skills from .claude/skills.',
    );
    expect(out).toContain('Checked in memory with every rule: the skill adds no finding.');
    expect(out).toContain(`  Bash(npx agentcheckup@${VERSION} tasks --check *)\n`);
    expect(out).toContain('a pull request check with --gate permissions or\n--gate security');
    expect(out).toContain(`Installed the agentcheckup skill in ${CLAUDE_TARGET} (4 files).`);

    // A scan of the repository with the skill finds nothing, on every target.
    const scan = capture(root);
    expect(await run(['.', '--fail-on', 'info', '--compact'], scan)).toBe(EXIT.ok);
  });

  it('pins the running version and changes nothing else', async () => {
    const root = await repo();
    const io = capture(root);
    expect(await install(io, ['--yes'], { version: '9.8.7-rc.1' })).toBe(EXIT.ok);
    const packaged = await skillBytes();
    for (const [path, bytes] of await installed(root, CLAUDE_TARGET)) {
      const text = decoder.decode(bytes);
      const original = packaged.get(path);
      expect(original, path).toBeDefined();
      if (pinnedVersions(decoder.decode(original)).length > 0) {
        expect(new Set(pinnedVersions(text)), path).toEqual(new Set(['9.8.7-rc.1']));
      }
      // Byte for byte, once the version is set back.
      expect(encoder.encode(withVersion(text, VERSION)), path).toEqual(original);
    }
    expect(io.output()).toContain('  Bash(npx agentcheckup@9.8.7-rc.1 fix)\n');
  });

  it('shows paths relative to the working directory', async () => {
    const root = await repo();
    const io = capture(join(root, '..'));
    const name = root.split(/[/\\]/).at(-1) ?? '';
    expect(await run(['skill', 'install', name, '--yes'], io)).toBe(EXIT.ok);
    expect(io.output()).toContain(`  ${name}/${CLAUDE_TARGET}/SKILL.md\n`);
  });

  it('uses .agents/skills when the targets leave out Claude Code, or with --dir agents', async () => {
    const codex = await repo({ 'agentcheckup.config.json': '{ "targets": ["codex", "cursor"] }' });
    const io = capture(codex);
    expect(await install(io, ['--yes'])).toBe(EXIT.ok);
    expect(io.output()).toContain(
      'Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf and Cline load skills from .agents/skills.',
    );
    expect(await installed(codex, AGENTS_TARGET)).toEqual(await skillBytes());

    const chosen = await repo();
    expect(await install(capture(chosen), ['--dir', 'agents', '--yes'])).toBe(EXIT.ok);
    expect((await tree(chosen)).filter((path) => path.startsWith('.agents/'))).toHaveLength(4);
    expect((await tree(chosen)).some((path) => path.startsWith('.claude/'))).toBe(false);
  });

  it('refuses an existing skill directory and changes nothing', async () => {
    const root = await repo({ [`${CLAUDE_TARGET}/notes.md`]: 'my notes\n' });
    const io = capture(root);
    expect(await install(io, ['--yes'])).toBe(EXIT.findings);
    expect(io.errors()).toBe(
      `Not installed: ${CLAUDE_TARGET} already exists, and skill install never overwrites. Remove it to install this version.\n`,
    );
    expect(await tree(root)).toEqual([`${CLAUDE_TARGET}/notes.md`, 'AGENTS.md']);
  });

  it('refuses when the skill is in the other skills directory', async () => {
    const root = await repo();
    expect(await install(capture(root), ['--dir', 'agents', '--yes'])).toBe(EXIT.ok);
    const io = capture(root);
    expect(await install(io, ['--yes'])).toBe(EXIT.findings);
    expect(io.errors()).toContain(`Not installed: the skill is already in ${AGENTS_TARGET}.`);
    expect(io.errors()).toContain(
      'Cursor, GitHub Copilot, Windsurf and Cline read both .claude/skills and .agents/skills',
    );
    expect(io.errors()).toContain('(skill/duplicate-name)');
    expect((await tree(root)).some((path) => path.startsWith('.claude/'))).toBe(false);

    const back = capture(root);
    expect(await install(back, ['--dir', 'agents', '--yes'])).toBe(EXIT.findings);
    expect(back.errors()).toContain('already exists');
  });

  it('refuses when the skill would add a finding, such as a second skill of that name', async () => {
    const other =
      '---\nname: agentcheckup\ndescription: Something else entirely. Use when asked.\n---\n# Other\n';
    const root = await repo({ '.claude/skills/other/SKILL.md': other });
    const io = capture(root);
    expect(await install(io, ['--yes'])).toBe(EXIT.findings);
    expect(io.errors()).toContain(
      `Not installed: with the skill in ${CLAUDE_TARGET}, agentcheckup reports a finding it does not report now:\n`,
    );
    expect(io.errors()).toContain(
      '  warn  .claude/skills/other/SKILL.md:2  skill/duplicate-name  Skill name "agentcheckup" is also used by ".claude/skills/agentcheckup/SKILL.md".',
    );
    expect(io.output()).toBe('');
    expect(await tree(root)).toEqual(['.claude/skills/other/SKILL.md', 'AGENTS.md']);
  });

  it.skipIf(!symlinksSupported)('refuses a symlinked .claude inside the repository', async () => {
    const root = await repo();
    await mkdir(join(root, 'elsewhere'));
    await symlink('elsewhere', join(root, '.claude'), 'dir');
    const io = capture(root);
    expect(await install(io, ['--yes'])).toBe(EXIT.findings);
    expect(io.errors()).toContain('.claude is a symbolic link');
    expect(await readdir(join(root, 'elsewhere'))).toEqual([]);
  });

  it.skipIf(!symlinksSupported)('refuses a .claude that links out of the repository', async () => {
    const outside = await tempDir();
    const root = await repo();
    await symlink(outside, join(root, '.claude'), 'dir');
    const io = capture(root);
    expect(await install(io, ['--yes'])).toBe(EXIT.findings);
    expect(io.errors()).toContain(
      `Not installed: agentcheckup cannot tell whether ${CLAUDE_TARGET}`,
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it('never overwrites a file that appears just before the write', async () => {
    const root = await repo();
    const late = join(root, ...CLAUDE_TARGET.split('/'), 'references', 'tasks.md');
    const io: Captured = {
      ...capture(root),
      beforeWrite: async () => {
        await mkdir(join(late, '..'), { recursive: true });
        await writeFile(late, 'mine\n');
      },
    };
    expect(await install(io, ['--yes'])).toBe(EXIT.findings);
    expect(io.errors()).toBe(
      `Not installed: ${CLAUDE_TARGET}/references/tasks.md: it already exists.\n`,
    );
    expect(await readFile(late, 'utf8')).toBe('mine\n');
    expect(await tree(root)).toEqual([`${CLAUDE_TARGET}/references/tasks.md`, 'AGENTS.md']);
  });

  it('refuses --untrusted', async () => {
    const root = await repo();
    const io = capture(root);
    expect(await run(['skill', 'install', '--untrusted', '--yes'], io)).toBe(EXIT.usage);
    expect(io.errors()).toContain('cannot be combined with --untrusted');
    expect(io.errors()).toContain('Run "agentcheckup skill --help" for usage.');
    expect(await tree(root)).toEqual(['AGENTS.md']);
  });

  it('exits 2 without a terminal unless --yes', async () => {
    const root = await repo();
    for (const io of [
      capture(root),
      { ...capture(root, {}, true), prompt: scripted(['y'], false) },
      { ...capture(root, {}, false), prompt: scripted(['y']) },
    ]) {
      expect(await run(['skill', 'install'], io)).toBe(EXIT.usage);
      expect(io.errors()).toContain('needs a terminal');
    }
    expect(await tree(root)).toEqual(['AGENTS.md']);
  });

  it('asks on a terminal and installs only on yes', async () => {
    for (const [answer, code, said] of [
      ['y', EXIT.ok, 'Installed the agentcheckup skill'],
      [' YES ', EXIT.ok, 'Installed the agentcheckup skill'],
      ['', EXIT.findings, 'Not installed.\n'],
      ['n', EXIT.findings, 'Not installed.\n'],
      [undefined, EXIT.findings, '\nStopped: nothing was installed.\n'],
    ] as const) {
      const root = await repo();
      const prompt = scripted([answer]);
      const io = terminal(root, prompt);
      expect(await run(['skill', 'install'], io), String(answer)).toBe(code);
      expect(prompt.questions).toEqual(['Install the skill? [y/N] ']);
      expect(io.output()).toContain(said);
      expect((await tree(root)).length).toBe(code === EXIT.ok ? 5 : 1);
    }
  });

  it('does not ask with --yes on a terminal', async () => {
    const root = await repo();
    const prompt = scripted([]);
    expect(await run(['skill', 'install', '-y'], terminal(root, prompt))).toBe(EXIT.ok);
    expect(prompt.questions).toEqual([]);
  });

  it('exits 3 when the packaged skill is missing a file or pins two versions', async () => {
    const packageRoot = await tempDir();
    const skillMd = decoder.decode((await skillBytes()).get('SKILL.md'));
    await writeFiles(packageRoot, {
      'package.json': '{ "name": "agentcheckup" }\n',
      [`${PACKAGED_SKILL}/SKILL.md`]: skillMd,
    });
    const root = await repo();
    const missing = capture(root);
    expect(await install(missing, ['--yes'], { packageRoot })).toBe(EXIT.internal);
    expect(missing.errors()).toBe(
      `Cannot read ${PACKAGED_SKILL}/references/context.md from the agentcheckup package: it does not exist.\n`,
    );

    const references = Object.fromEntries(
      SKILL_FILES.filter((path) => path !== 'SKILL.md').map((path) => [
        `${PACKAGED_SKILL}/${path}`,
        'Run `npx agentcheckup@1.0.0 fix`.\n',
      ]),
    );
    await writeFiles(packageRoot, references);
    const mixed = capture(root);
    expect(await install(mixed, ['--yes'], { packageRoot })).toBe(EXIT.internal);
    expect(mixed.errors()).toContain(`pins 2 versions of agentcheckup. Reinstall agentcheckup.`);
    expect(await tree(root)).toEqual(['AGENTS.md']);
  });

  it('exits 3 for a version it cannot pin, or a packaged skill that pins none', async () => {
    const root = await repo();
    const latest = capture(root);
    expect(await install(latest, ['--yes'], { version: 'latest' })).toBe(EXIT.internal);
    expect(latest.errors()).toBe('Cannot pin the skill to version latest.\n');

    const packageRoot = await fakeSkillPackage('Run agentcheckup.\n');
    const unpinned = capture(root);
    expect(await install(unpinned, ['--yes'], { packageRoot })).toBe(EXIT.internal);
    expect(unpinned.errors()).toContain('pins no version of agentcheckup.');
    expect(await tree(root)).toEqual(['AGENTS.md']);
  });

  it('installs a skill without allowed-tools without listing any', async () => {
    const packageRoot = await fakeSkillPackage('Run `npx agentcheckup@1.0.0 fix` to preview.\n');
    const root = await repo();
    const io = capture(root);
    expect(await install(io, ['--yes'], { packageRoot, version: '2.0.0' })).toBe(EXIT.ok);
    expect(io.output()).not.toContain('allowed-tools');
    const written = await readFile(join(root, ...CLAUDE_TARGET.split('/'), 'SKILL.md'), 'utf8');
    expect(written).toContain('Run `npx agentcheckup@2.0.0 fix` to preview.\n');
  });

  it('reports a repository that disappears before the write', async () => {
    const root = await repo();
    const io: Captured = {
      ...capture(root),
      beforeWrite: () => rm(root, { recursive: true, force: true }),
    };
    expect(await install(io, ['--yes'])).toBe(EXIT.findings);
    expect(io.errors()).toContain('Not installed: Cannot write fixes to ');
  });

  it('reads the skill from this package by default', async () => {
    const root = await repo();
    expect(await install(capture(root), ['--yes'], { packageRoot: REPO_ROOT })).toBe(EXIT.ok);
  });
});

describe('skill install arguments', () => {
  const options = (args: readonly string[]): SkillCommandOptions => {
    const command = parseCommand(args);
    if (command.kind !== 'skill') throw new Error(`parsed as ${command.kind}`);
    return command.options;
  };

  it('parses the path, --dir and --yes', () => {
    expect(options(['skill', 'install'])).toMatchObject({ path: '.', dir: undefined, yes: false });
    expect(options(['skill', 'install', 'repo', '--dir', 'claude', '-y'])).toMatchObject({
      path: 'repo',
      dir: 'claude',
      yes: true,
      untrusted: false,
      useConfig: true,
    });
    expect(options(['--yes', 'skill', 'install', '--dir=agents'])).toMatchObject({
      dir: 'agents',
      yes: true,
    });
  });

  it('rejects a missing or unknown action, two paths and an unknown directory', () => {
    for (const [args, message] of [
      [['skill'], '"skill" needs an action: agentcheckup skill install [path].'],
      [['skill', 'remove'], 'Unknown skill action "remove".'],
      [['skill', 'install', 'a', 'b'], '"skill install" takes at most one path, got 2.'],
      [['skill', 'install', '--dir', 'cursor'], '--dir must be one of: claude, agents.'],
    ] as const) {
      expect(() => parseCommand(args), args.join(' ')).toThrow(UsageError);
      expect(() => parseCommand(args)).toThrow(message);
    }
    expect(() => parseCommand(['skill', 'install', '--format', 'json'])).toThrow(TypeError);
  });

  it('keeps --dir and --yes out of the other commands', () => {
    expect(() => parseCommand(['--yes'])).toThrow(TypeError);
    expect(() => parseCommand(['fix', '--dir', 'claude'])).toThrow(TypeError);
  });

  it('prints its help', async () => {
    for (const args of [
      ['skill', '--help'],
      ['skill', 'install', '-h'],
    ]) {
      const io = capture();
      expect(await run(args, io)).toBe(EXIT.ok);
      expect(io.output()).toBe(SKILL_HELP);
    }
    expect(SKILL_HELP).toContain('Usage: agentcheckup skill install [path] [options]');
    const io = capture();
    expect(await run(['skill'], io)).toBe(EXIT.usage);
    expect(io.errors()).toContain('Run "agentcheckup skill --help" for usage.');
  });
});

describe('pinned versions', () => {
  it('finds and replaces every agentcheckup version, and nothing else', () => {
    const text =
      'npx agentcheckup@1.2.3 fix\nnpx agentcheckup@1.2.3-rc.1+build.5 tasks\n' +
      'npx agentcheckup@latest\nnode 22.12.0\nagentcheckup@1.2 x\n';
    expect(pinnedVersions(text)).toEqual(['1.2.3', '1.2.3-rc.1+build.5']);
    expect(withVersion(text, '2.0.0')).toBe(
      'npx agentcheckup@2.0.0 fix\nnpx agentcheckup@2.0.0 tasks\n' +
        'npx agentcheckup@latest\nnode 22.12.0\nagentcheckup@1.2 x\n',
    );
    expect(withVersion('agentcheckup@1.0.0', '$&')).toBe('agentcheckup@$&');
  });
});
