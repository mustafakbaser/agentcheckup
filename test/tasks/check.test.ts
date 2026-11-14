import { describe, expect, it } from 'vitest';
import { buildTasks, checkTasks, openTasks, taskId } from '../../src/tasks/index.js';
import { SAMPLE_REPO, scanOf } from './fixture.js';

const SKILL = '.claude/skills/deploy/SKILL.md';
const DESCRIPTION_TASK = taskId('skill/description-quality', SKILL);

function withSkill(frontmatter: string): Record<string, string> {
  return {
    ...SAMPLE_REPO,
    [SKILL]: `---\n${frontmatter}\n---\n# Deploy\n\nRun \`pnpm deploy\`.\n`,
  };
}

describe('checkTasks', () => {
  it('reports a task open while a finding of its rule is in its file', () => {
    expect(checkTasks(scanOf(SAMPLE_REPO), [DESCRIPTION_TASK])).toEqual([
      {
        id: DESCRIPTION_TASK,
        open: [
          {
            kind: 'finding',
            ruleId: 'skill/description-quality',
            severity: 'info',
            path: SKILL,
            line: 3,
          },
        ],
      },
    ]);
  });

  it('reports it done once the finding is gone', () => {
    const fixed = withSkill(
      'name: deploy\ndescription: Deploys the API to staging. Use when the user asks to deploy or roll back.',
    );
    expect(checkTasks(scanOf(fixed), [DESCRIPTION_TASK])).toEqual([
      { id: DESCRIPTION_TASK, open: [] },
    ]);
  });

  it('keeps it open when a guard rule reports an error in the file', () => {
    // Deleting the description silences description-quality, but description-missing guards it.
    const deleted = withSkill('name: deploy');
    const [status] = checkTasks(scanOf(deleted), [DESCRIPTION_TASK]);
    expect(status?.open).toEqual([
      expect.objectContaining({ kind: 'guard', ruleId: 'skill/description-missing' }),
    ]);

    // So does invalid YAML.
    const broken = withSkill('name: deploy\ndescription: "Deploys the API. Use when asked');
    const [invalid] = checkTasks(scanOf(broken), [DESCRIPTION_TASK]);
    expect(invalid?.open.map((reason) => reason.ruleId)).toContain('skill/frontmatter-invalid');
  });

  it('does not count an info finding of a guard rule, or a guard in another file', () => {
    const scan = scanOf({
      ...withSkill(
        'name: deploy\ndescription: Deploys the API to staging. Use when the user asks to deploy.',
      ),
      '.claude/skills/other/SKILL.md': '---\nname: other\n---\n# Other\n',
    });
    expect(checkTasks(scan, [DESCRIPTION_TASK])).toEqual([{ id: DESCRIPTION_TASK, open: [] }]);
  });

  it('reports an unknown id as done but not found, and keeps the order of the ids', () => {
    const ids = ['ac-00000000', DESCRIPTION_TASK];
    expect(checkTasks(scanOf(SAMPLE_REPO), ids).map((status) => status.id)).toEqual(ids);
    expect(checkTasks(scanOf(SAMPLE_REPO), ['ac-00000000'])).toEqual([
      { id: 'ac-00000000', open: [], notFound: true },
    ]);
  });

  it('finds the id of a done task whose rule and file are still in the scan', () => {
    const fixed = withSkill(
      'name: deploy\ndescription: Deploys the API to staging. Use when the user asks to deploy or roll back.',
    );
    // The file is still there, so the id is known: done, and not "not found".
    expect(checkTasks(scanOf(fixed), [DESCRIPTION_TASK])[0]?.notFound).toBeUndefined();
    // Renamed away, the id belongs to no file of the scan.
    const renamed = Object.fromEntries(
      Object.entries(fixed).map(([path, text]) =>
        path === SKILL
          ? ['.claude/skills/ship/SKILL.md', text.replace('name: deploy', 'name: ship')]
          : [path, text],
      ),
    );
    expect(checkTasks(scanOf(renamed), [DESCRIPTION_TASK])).toEqual([
      { id: DESCRIPTION_TASK, open: [], notFound: true },
    ]);
  });

  it('treats the id of a suppressed finding as done', () => {
    const scan = scanOf({
      ...SAMPLE_REPO,
      'AGENTS.md':
        '# Project\n\n<!-- agentcheckup-disable-next-line instr/vague-directive -- kept on purpose -->\nWrite clean code.\n',
    });
    const id = taskId('instr/vague-directive', 'AGENTS.md');
    expect(checkTasks(scan, [id])).toEqual([{ id, open: [] }]);
  });
});

describe('openTasks', () => {
  it('lists every open task, as buildTasks counts them', () => {
    const scan = scanOf(SAMPLE_REPO);
    const open = openTasks(scan);
    const built = buildTasks(scan);
    expect(open).toHaveLength(built.open);
    expect(new Set(open.map((status) => status.id))).toEqual(
      new Set(built.tasks.map((task) => task.id)),
    );
  });

  it('is empty when no task is open, even with findings for the user and ready fixes', () => {
    const scan = scanOf({
      'AGENTS.md': '# Project\n\nRun `pnpm test` first.\n',
      'CLAUDE.md': '# Claude\n',
      '.mcp.json': SAMPLE_REPO['.mcp.json'] ?? '',
    });
    expect(scan.findings.length).toBeGreaterThan(0);
    expect(openTasks(scan)).toEqual([]);
  });
});
