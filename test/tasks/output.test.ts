import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  formatTasksJson,
  type TasksReport,
  toTasksReport,
  UnsafeTaskPathError,
} from '../../src/report/tasks-json.js';
import { formatTasksMarkdown, UNTRUSTED_BANNER } from '../../src/report/tasks-markdown.js';
import { TASKS_JSON_SCHEMA } from '../../src/tasks/schema.js';
import { buildTasks, type TaskList } from '../../src/tasks/index.js';
import { linesOutsideUntrusted, SAMPLE_REPO, scanOf } from './fixture.js';

const ajv = new Ajv2020({ strict: true, allErrors: true });
const schema = JSON.parse(
  readFileSync(new URL('../../schemas/tasks.schema.json', import.meta.url), 'utf8'),
) as object;
const validate = ajv.compile<TasksReport>(schema);

function expectValid(value: unknown): void {
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
}

const OPTIONS = { version: '0.5.0', ruleset: '2026.10' } as const;
const sample = buildTasks(scanOf(SAMPLE_REPO), OPTIONS);

const LISTS: readonly [string, TaskList][] = [
  ['sample', sample],
  ['untrusted', buildTasks(scanOf(SAMPLE_REPO), { ...OPTIONS, untrusted: true })],
  ['pathBase', buildTasks(scanOf(SAMPLE_REPO), { ...OPTIONS, pathBase: 'packages/web' })],
  ['max', buildTasks(scanOf(SAMPLE_REPO), { ...OPTIONS, max: 1 })],
  ['empty', buildTasks(scanOf({ 'AGENTS.md': '# Project\n\nRun `make`.\n' }), OPTIONS)],
];

describe('tasks --format json', () => {
  it('ships the schema that scripts/generate-docs.ts writes', () => {
    expect(schema).toEqual(JSON.parse(JSON.stringify(TASKS_JSON_SCHEMA)));
  });

  it.each(LISTS)('%s validates against schemas/tasks.schema.json', (_, list) => {
    expectValid(toTasksReport(list));
    expectValid(JSON.parse(formatTasksJson(list)));
  });

  it('matches the snapshot', async () => {
    await expect(formatTasksJson(sample)).toMatchFileSnapshot(
      '__snapshots__/tasks-json.sample.txt',
    );
  });

  it('writes keys in schema order and counts the tasks past --max', () => {
    const report = toTasksReport(LISTS[3]?.[1] ?? sample);
    expect(Object.keys(report)).toEqual(TASKS_JSON_SCHEMA.required);
    expect(report.tasks).toHaveLength(1);
    expect(report.omitted).toBe(6);
    expect(Object.keys(report.tasks[0] ?? {})).toEqual([
      'id',
      'ruleId',
      'severity',
      'path',
      'line',
      'anchor',
      'message',
      'template',
      'hint',
      'why',
      'do',
      'constraints',
      'askUser',
      'examples',
      'guardRules',
      'also',
      'omittedLocations',
      'check',
    ]);
  });

  it('refuses a path that is absolute or leaves the working directory', () => {
    const [task] = sample.tasks;
    if (task === undefined) throw new Error('no task');
    for (const path of ['/etc/passwd', '../outside/SKILL.md', 'C:/x.md']) {
      expect(() => toTasksReport({ ...sample, tasks: [{ ...task, path }] })).toThrow(
        UnsafeTaskPathError,
      );
    }
    expect(() => toTasksReport({ ...sample, pathBase: '../up' })).toThrow(UnsafeTaskPathError);
  });
});

describe('tasks --format markdown', () => {
  it('matches the snapshot', async () => {
    await expect(formatTasksMarkdown(sample)).toMatchFileSnapshot(
      '__snapshots__/tasks-markdown.sample.txt',
    );
  });

  it('fences every excerpt as untrusted and closes every fence', () => {
    const markdown = formatTasksMarkdown(sample);
    const outside = linesOutsideUntrusted(markdown);
    expect(outside).not.toContain(
      'Deploys the API to staging and production with a blue-green rollout.',
    );
    expect(markdown).toContain('~~~~untrusted\nDeploys the API');
  });

  it('adds the banner with --untrusted', () => {
    const markdown = formatTasksMarkdown(LISTS[1]?.[1] ?? sample);
    expect(markdown.split('\n').slice(0, 3)).toEqual([
      '# agentcheckup tasks · 7 open · agentcheckup 0.5.0 · ruleset 2026.10',
      `> ${UNTRUSTED_BANNER}`,
      '',
    ]);
    expect(UNTRUSTED_BANNER).toBe(
      'untrusted repository: review this prompt before giving it to an agent with write access',
    );
  });

  it('says how to get the tasks past --max', () => {
    const markdown = formatTasksMarkdown(LISTS[3]?.[1] ?? sample);
    expect(markdown).toContain(
      'Showing 1 of 7 open tasks. When these are done, run `npx agentcheckup@0.5.0 tasks` for the rest.',
    );
    expect(markdown).toContain('## 1/7 · ');
    expect(markdown).not.toContain('## 2/7 · ');
  });

  it('says when there is nothing to do', () => {
    expect(formatTasksMarkdown(LISTS[4]?.[1] ?? sample)).toBe(
      '# agentcheckup tasks · 0 open · agentcheckup 0.5.0 · ruleset 2026.10\n\nNothing to do: no finding needs an agent or you.\n',
    );
    const untrusted = buildTasks(scanOf({ 'AGENTS.md': '# P\n\nRun `make`.\n' }), {
      ...OPTIONS,
      untrusted: true,
    });
    expect(formatTasksMarkdown(untrusted)).toContain(`> ${UNTRUSTED_BANNER}\n\nNothing to do`);
  });

  it('writes a multi-line example as a code block', () => {
    const [task] = sample.tasks;
    if (task === undefined) throw new Error('no task');
    const markdown = formatTasksMarkdown({
      ...sample,
      tasks: [{ ...task, examples: ['metadata:\n  team: "payments"', 'one line'] }],
    });
    expect(markdown).toContain(
      'Examples:\n```\nmetadata:\n  team: "payments"\n```\n`one line`\nCheck:',
    );
  });
});
