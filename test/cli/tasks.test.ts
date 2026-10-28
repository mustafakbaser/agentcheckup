import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCommand, UsageError } from '../../src/cli/args.js';
import { TASKS_HELP } from '../../src/cli/help.js';
import { EXIT, run } from '../../src/cli/run.js';
import { VERSION } from '../../src/core/version.js';
import type { TasksReport } from '../../src/report/tasks-json.js';
import { UNTRUSTED_BANNER } from '../../src/report/tasks-markdown.js';
import { TASKS_JSON_SCHEMA } from '../../src/tasks/schema.js';
import { taskId } from '../../src/tasks/index.js';
import { GITHUB_TOKEN, SAMPLE_REPO } from '../tasks/fixture.js';
import { capture, removeTempDirs, tempDir, writeFiles } from './helpers.js';

afterEach(removeTempDirs);

const SKILL = '.claude/skills/deploy/SKILL.md';
const DESCRIPTION_TASK = taskId('skill/description-quality', SKILL);

async function sampleRepo(): Promise<string> {
  const root = await tempDir();
  await writeFiles(root, SAMPLE_REPO);
  return root;
}

async function tasks(cwd: string, ...args: string[]) {
  const io = capture(cwd);
  const code = await run(['tasks', ...args], io);
  return { code, out: io.output(), err: io.errors() };
}

describe('agentcheckup tasks', () => {
  it('prints the prompt and exits 1 while tasks are open', async () => {
    const root = await sampleRepo();
    const result = await tasks(root);
    expect(result.code).toBe(EXIT.findings);
    expect(
      result.out.startsWith(`# agentcheckup tasks · 7 open · agentcheckup ${VERSION} · `),
    ).toBe(true);
    expect(result.out).toContain(`## 4/7 · ${DESCRIPTION_TASK} · skill/description-quality (info)`);
    expect(result.out).toContain(`npx agentcheckup@${VERSION} tasks --check ${DESCRIPTION_TASK}`);
    expect(result.out).not.toContain(GITHUB_TOKEN);
    expect(result.err).toBe('');
  });

  it('writes JSON that follows the schema', async () => {
    const root = await sampleRepo();
    const result = await tasks(root, '--format', 'json');
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile<TasksReport>(
      JSON.parse(JSON.stringify(TASKS_JSON_SCHEMA)) as object,
    );
    const report = JSON.parse(result.out) as TasksReport;
    expect(validate(report), ajv.errorsText(validate.errors)).toBe(true);
    expect(report.open).toBe(7);
    expect(report.pathBase).toBe('');
  });

  it('puts the scanned directory in paths and commands', async () => {
    const root = await sampleRepo();
    const result = await tasks(
      join(root, '..'),
      join(root.split(/[/\\]/).at(-1) ?? ''),
      '--max',
      '1',
    );
    const name = root.split(/[/\\]/).at(-1) ?? '';
    expect(result.out).toContain(`File: \`${name}/.claude/skills/deploy/SKILL.md\` line 10`);
    expect(result.out).toContain(`tasks ${name} --check`);
  });

  it('filters by rule, and refuses an unknown rule', async () => {
    const root = await sampleRepo();
    const result = await tasks(root, '--rule', 'skill/description-quality');
    expect(result.out).toContain('· 1 open ·');
    const unknown = await tasks(root, '--rule', 'skill/nope');
    expect(unknown.code).toBe(EXIT.usage);
    expect(unknown.err).toContain('--rule: unknown rule "skill/nope"');
  });

  it('writes to --output through the safe writer', async () => {
    const root = await sampleRepo();
    const result = await tasks(root, '--output', 'tasks.md');
    expect(result.code).toBe(EXIT.findings);
    expect(result.out).toBe('');
    expect(await readFile(join(root, 'tasks.md'), 'utf8')).toContain('## Final check');
  });

  it('warns on stderr with --untrusted', async () => {
    const root = await sampleRepo();
    const result = await tasks(root, '--untrusted', '--format', 'json');
    expect(result.err).toBe(`Warning: ${UNTRUSTED_BANNER}.\n`);
    expect((JSON.parse(result.out) as TasksReport).untrusted).toBe(true);
  });

  it('exits 0 when there is nothing to do', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'AGENTS.md': '# Project\n\nRun `pnpm test` before you commit.\n' });
    const result = await tasks(root);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain('Nothing to do');
  });

  it('prints its help', async () => {
    const root = await tempDir();
    expect(await tasks(root, '--help')).toEqual({ code: EXIT.ok, out: TASKS_HELP, err: '' });
    // --help wins over --check, as over every other option.
    expect((await tasks(root, '--check', '--help')).out).toBe(TASKS_HELP);
  });
});

describe('agentcheckup tasks --check', () => {
  it('exits 1 while a task is open and 0 once it is done', async () => {
    const root = await sampleRepo();
    const open = await tasks(root, '--check', DESCRIPTION_TASK);
    expect(open.code).toBe(EXIT.findings);
    expect(open.out).toBe(
      `${DESCRIPTION_TASK}  open  skill/description-quality  ${SKILL}:3\n1 of 1 task open.\n`,
    );

    const skill = join(root, SKILL);
    const text = await readFile(skill, 'utf8');
    await writeFile(
      skill,
      text.replace(
        'blue-green rollout.',
        'blue-green rollout. Use when the user asks to deploy, ship or roll back the API.',
      ),
    );
    const done = await tasks(root, '--check', DESCRIPTION_TASK);
    expect(done).toEqual({
      code: EXIT.ok,
      out: `${DESCRIPTION_TASK}  done\n0 of 1 task open.\n`,
      err: '',
    });
  });

  it('names a guard rule that keeps a task open', async () => {
    const root = await sampleRepo();
    await writeFile(join(root, SKILL), '---\nname: deploy\n---\n# Deploy\n');
    const result = await tasks(root, '--check', DESCRIPTION_TASK);
    expect(result.code).toBe(EXIT.findings);
    expect(result.out).toContain(
      `${DESCRIPTION_TASK}  open  guard skill/description-missing (warning)  ${SKILL}:1\n`,
    );
  });

  it('without ids, checks every task', async () => {
    const root = await sampleRepo();
    const open = await tasks(root, '--check');
    expect(open.code).toBe(EXIT.findings);
    expect(open.out).toContain('7 tasks are open. Run "agentcheckup tasks" to see what to do.\n');

    const clean = await tempDir();
    await writeFiles(clean, { 'AGENTS.md': '# Project\n\nRun `pnpm test` before you commit.\n' });
    expect(await tasks(clean, '--check')).toEqual({
      code: EXIT.ok,
      out: 'No open tasks.\n',
      err: '',
    });
  });

  it('takes the repository root as the one argument that is not an id', async () => {
    const root = await sampleRepo();
    const io = capture(join(root, '..'));
    expect(await run(['tasks', root, '--check', DESCRIPTION_TASK], io)).toBe(EXIT.findings);
  });

  it.each([
    ['--output', 'tasks.md'],
    ['-o', 'tasks.md'],
    ['--format', 'json'],
    ['--rule', 'skill/description-quality'],
    ['--max', '5'],
    ['--untrusted'],
    ['--no-config'],
    ['--version'],
  ])('refuses %s, and writes nothing', async (...flag) => {
    const root = await sampleRepo();
    const before = await readdir(root);
    const result = await tasks(root, '--check', DESCRIPTION_TASK, ...flag);
    expect(result.code).toBe(EXIT.usage);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/^--check takes only task ids, so it cannot be combined with --/);
    expect(await readdir(root)).toEqual(before);
  });

  it('refuses something that looks like an id but is not one, and a second path', async () => {
    const root = await sampleRepo();
    const bad = await tasks(root, '--check', 'ac-XYZ');
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.err).toContain('"ac-XYZ" is not a task id');
    const two = await tasks(root, '--check', 'a', 'b');
    expect(two.code).toBe(EXIT.usage);
  });
});

describe('parsing', () => {
  function usage(argv: readonly string[]): string {
    try {
      parseCommand(argv);
    } catch (error) {
      if (error instanceof UsageError) return error.message;
      throw error;
    }
    throw new Error('expected a usage error');
  }

  it('parses the options', () => {
    expect(
      parseCommand(['tasks', 'repo', '--format', 'json', '--max', '5', '--rule', 'a/b,a/b']),
    ).toMatchObject({
      kind: 'tasks',
      options: { path: 'repo', format: 'json', max: 5, rules: ['a/b'], useConfig: true },
    });
    expect(parseCommand(['tasks', 'repo'])).toMatchObject({ options: { check: undefined } });
    expect(parseCommand(['tasks', '--check', 'ac-0123abcd', 'ac-0123abcd'])).toMatchObject({
      kind: 'tasks',
      options: { path: '.', check: ['ac-0123abcd'] },
    });
  });

  it('refuses a bad --max and options tasks --check could not repeat', () => {
    expect(usage(['tasks', '--max', '0'])).toContain('--max must be a whole number from 1 to 500');
    expect(usage(['tasks', '--max', '501'])).toContain('--max');
    expect(usage(['tasks', '--max', '1e2'])).toContain('--max');
    for (const flag of ['--config=x.json', '--no-config', '--targets=codex', '--no-gitignore']) {
      expect(usage(['tasks', flag])).toContain('does not apply to the tasks command');
    }
    expect(usage(['tasks', '--write'])).toContain('works only with the fix command');
    expect(usage(['tasks', '--cwd', 'x'])).toContain(
      'works only with the context and tokens commands',
    );
    expect(usage(['tasks', '--by-directory'])).toContain('works only with the tokens command');
    expect(usage(['tasks', 'a', 'b'])).toContain('"tasks" takes at most one path');
    expect(usage(['tasks', '--format', 'diff'])).toContain(
      '--format must be one of: markdown, json',
    );
  });

  it('keeps --check and --max to the tasks command', () => {
    for (const command of [[], ['fix'], ['context']]) {
      expect(usage([...command, '--check'])).toContain('works only with the tasks command');
      expect(usage([...command, '--max', '3'])).toContain('works only with the tasks command');
    }
  });
});
