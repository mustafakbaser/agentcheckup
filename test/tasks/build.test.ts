import { describe, expect, it } from 'vitest';
import { codePointLength } from '../../src/core/measure.js';
import { buildTasks, taskId } from '../../src/tasks/index.js';
import { MAX_VALUE_CHARS, MAX_VALUE_LINES } from '../../src/tasks/excerpt.js';
import { GITHUB_TOKEN, SAMPLE_REPO, scanOf } from './fixture.js';

const sample = scanOf(SAMPLE_REPO);

describe('buildTasks', () => {
  const list = buildTasks(sample, { version: '1.2.3' });

  it('makes one task per rule and file without a ready fix, errors first, then by path', () => {
    expect(list.tasks.map((task) => [task.severity, task.ruleId, task.path])).toEqual([
      ['error', 'skill/broken-reference', '.claude/skills/deploy/SKILL.md'],
      ['error', 'instr/import-unresolved', 'CLAUDE.md'],
      ['warn', 'skill/broad-allowed-tools', '.claude/skills/deploy/SKILL.md'],
      ['info', 'skill/description-quality', '.claude/skills/deploy/SKILL.md'],
      ['info', 'skill/body-too-long', '.claude/skills/guide/SKILL.md'],
      ['info', 'cursor/rule-never-applied', '.cursor/rules/manual.mdc'],
      ['info', 'instr/vague-directive', 'AGENTS.md'],
    ]);
    expect(list.open).toBe(7);
  });

  it('never hands a finding with a ready fix to an agent: step 0 previews it and asks first', () => {
    const ruleIds = list.tasks.map((task) => task.ruleId);
    expect(ruleIds).not.toContain('instr/agents-md-ignored-by-claude');
    expect(list.readyFixes).toEqual({ safe: 1, review: 0 });
    expect(list.steps).toEqual([
      expect.objectContaining({
        kind: 'preview',
        command: 'npx agentcheckup@1.2.3 fix --rule instr/agents-md-ignored-by-claude',
      }),
      expect.objectContaining({
        kind: 'write',
        command: 'npx agentcheckup@1.2.3 fix --write --rule instr/agents-md-ignored-by-claude',
      }),
    ]);
    expect(list.steps[1]?.text).toMatch(/^Ask the user, then run /);
  });

  it('lists a literal credential for the user, without its message', () => {
    expect(list.tasks.map((task) => task.ruleId)).not.toContain('mcp/literal-secret');
    expect(list.forYou).toEqual([
      {
        ruleId: 'mcp/literal-secret',
        severity: 'error',
        path: '.mcp.json',
        line: 10,
        count: 1,
        title: 'Configuration file contains a literal credential',
        reason: 'credential',
        note: 'revoke and rotate the credential first; then `npx agentcheckup@1.2.3 fix --rule mcp/literal-secret` replaces it with a reference to an environment variable.',
      },
    ]);
    expect(JSON.stringify(list)).not.toContain(GITHUB_TOKEN);
  });

  it('leaves every finding in a JSON file to the user, whatever the rule', () => {
    const scan = scanOf({ '.mcp.json': '{"mcpServers": {"a": {"command": "x"}, "a": {}}}\n' });
    const built = buildTasks(scan);
    expect(scan.findings.some((finding) => finding.ruleId === 'json/duplicate-key')).toBe(true);
    expect(built.tasks).toEqual([]);
    expect(built.forYou.map((item) => [item.ruleId, item.reason])).toContainEqual([
      'json/duplicate-key',
      'security',
    ]);
    // Its fix is the user's too: step 0 must not let the agent apply it.
    expect(built.steps).toEqual([]);
  });

  it('pins every command to the version and gives each task its id and check', () => {
    const task = list.tasks.find((candidate) => candidate.ruleId === 'skill/description-quality');
    expect(task).toMatchObject({
      id: taskId('skill/description-quality', '.claude/skills/deploy/SKILL.md'),
      line: 3,
      anchor: { kind: 'frontmatter', key: 'description' },
      template: 'rule',
      askUser: null,
      excerpt: {
        kind: 'value',
        text: 'Deploys the API to staging and production with a blue-green rollout.',
        truncated: false,
        redacted: false,
      },
    });
    expect(task?.check.command).toBe(`npx agentcheckup@1.2.3 tasks --check ${task?.id ?? ''}`);
    expect(task?.guardRules).toContain('skill/frontmatter-invalid');
    expect(task?.constraints.at(-1)).toBe('do not add agentcheckup-disable comments');
    expect(list.check.command).toBe('npx agentcheckup@1.2.3 tasks --check');
  });

  it('collects the findings of one rule in one file into one task', () => {
    const task = list.tasks.find((candidate) => candidate.ruleId === 'skill/broken-reference');
    expect(task?.message).toContain('runbook.md');
    expect(task?.also).toHaveLength(1);
    expect(task?.also[0]?.message).toContain('rollback.md');
    expect(task?.omittedLocations).toBe(0);
  });

  it('shows the heading outline of a long skill body, never its text', () => {
    const task = list.tasks.find((candidate) => candidate.ruleId === 'skill/body-too-long');
    expect(task?.excerpt).toEqual({
      kind: 'outline',
      text: [
        '# Guide (564 lines, from line 5)',
        '## Setup (123 lines, from line 9)',
        '## API reference (437 lines, from line 132)',
        '### Errors (3 lines, from line 566)',
      ].join('\n'),
      truncated: false,
      redacted: false,
    });
    expect(task?.askUser).not.toBeNull();
  });

  it('builds a generic task from the rule documentation and the hint', () => {
    const scan = scanOf({ 'tools/AGENTS.override.md': '', 'tools/AGENTS.md': '# Tools\n' });
    const [task] = buildTasks(scan).tasks.filter(
      (candidate) => candidate.ruleId === 'instr/override-shadows-agents-md',
    );
    expect(task?.template).toBe('generic');
    expect(task?.hint).toContain('delete the empty AGENTS.override.md');
    expect(task?.why).toMatch(/^In each directory, Codex reads/);
    expect(task?.do.at(-1)).toContain('docs/rules/instr/override-shadows-agents-md.md');
    expect(task?.guardRules).toEqual(['risk/hidden-unicode']);
  });

  it('filters by rule and limits the number of tasks', () => {
    const only = buildTasks(sample, { rules: new Set(['skill/description-quality']) });
    expect(only.tasks.map((task) => task.ruleId)).toEqual(['skill/description-quality']);
    expect(only.steps).toEqual([]);
    expect(only.forYou).toEqual([]);
    expect(only.rerun.command).toBe(
      'npx agentcheckup@0.0.0 tasks --rule skill/description-quality',
    );

    const two = buildTasks(sample, { max: 2 });
    expect(two.open).toBe(7);
    expect(two.tasks.map((task) => task.ruleId)).toEqual([
      'skill/broken-reference',
      'instr/import-unresolved',
    ]);
  });

  it('puts the path base in front of paths and the scanned directory into commands', () => {
    const based = buildTasks(sample, {
      version: '1.2.3',
      pathBase: 'packages/web',
      commandPath: 'packages/web',
    });
    const task = based.tasks[0];
    expect(task?.path).toBe('packages/web/.claude/skills/deploy/SKILL.md');
    // The id stays relative to the scanned directory, as `tasks packages/web --check` sees it.
    expect(task?.id).toBe(taskId('skill/broken-reference', '.claude/skills/deploy/SKILL.md'));
    expect(task?.check.command).toBe(
      `npx agentcheckup@1.2.3 tasks packages/web --check ${task?.id ?? ''}`,
    );
    expect(based.preamble.at(-1)).toBe(
      'Finish with `npx agentcheckup@1.2.3 tasks packages/web --check`; it must exit 0.',
    );
  });

  it('with --untrusted, previews the fixes but leaves applying them to the user', () => {
    const untrusted = buildTasks(sample, { untrusted: true, version: '1.2.3' });
    expect(untrusted.untrusted).toBe(true);
    expect(untrusted.steps).toHaveLength(1);
    expect(untrusted.steps[0]?.command).toBe(
      'npx agentcheckup@1.2.3 fix --untrusted --rule instr/agents-md-ignored-by-claude',
    );
    expect(untrusted.forYou[0]?.note).toContain('fix --untrusted --rule mcp/literal-secret');
  });

  it('ignores suppressed findings', () => {
    const scan = scanOf({
      ...SAMPLE_REPO,
      'AGENTS.md':
        '# Project\n\n<!-- agentcheckup-disable-next-line instr/vague-directive -- kept on purpose -->\nWrite clean code.\n',
    });
    expect(buildTasks(scan).tasks.map((task) => task.ruleId)).not.toContain(
      'instr/vague-directive',
    );
  });

  it('has nothing to do for a clean repository', () => {
    const clean = buildTasks(scanOf({ 'AGENTS.md': '# Project\n\nRun `pnpm test` first.\n' }));
    expect(clean).toMatchObject({ open: 0, tasks: [], steps: [], forYou: [] });
  });
});

describe('excerpts', () => {
  function descriptionTask(description: string) {
    const scan = scanOf({
      '.claude/skills/deploy/SKILL.md': `---\nname: deploy\ndescription: ${description}\n---\n# Deploy\n`,
    });
    return buildTasks(scan).tasks.find((task) => task.ruleId === 'skill/description-quality');
  }

  it(`cuts a value after ${MAX_VALUE_LINES} lines`, () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `  Deploys part ${i} of the service to the cluster.`,
    );
    const task = descriptionTask(`>-\n${lines.join('\n')}`);
    // A folded scalar is one line of text: the line cap does not apply, the length cap does.
    expect(task?.excerpt?.truncated).toBe(true);
    expect(codePointLength(task?.excerpt?.text ?? '')).toBe(MAX_VALUE_CHARS);

    const literal = descriptionTask(`|-\n${lines.join('\n')}`);
    expect(literal?.excerpt?.text.split('\n')).toHaveLength(MAX_VALUE_LINES);
    expect(literal?.excerpt?.truncated).toBe(true);
  });

  it('redacts a credential before cutting', () => {
    const task = descriptionTask(`Deploys the API with the token ${GITHUB_TOKEN} for the cluster.`);
    expect(task?.excerpt).toMatchObject({
      text: 'Deploys the API with the token ghp_…(40 chars) for the cluster.',
      redacted: true,
    });
  });

  it('shows a list value as written', () => {
    const scan = scanOf({
      '.claude/skills/deploy/SKILL.md':
        '---\nname: deploy\ndescription: Deploys the API. Use when the user asks to deploy.\nallowed-tools:\n  - Bash\n  - Read\n---\n# Deploy\n',
    });
    const task = buildTasks(scan).tasks.find(
      (candidate) => candidate.ruleId === 'skill/broad-allowed-tools',
    );
    expect(task?.excerpt?.text).toBe('- Bash\n  - Read');
    expect(task?.anchor).toEqual({ kind: 'frontmatter', key: 'allowed-tools' });
  });
});
