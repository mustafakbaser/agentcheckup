import { describe, expect, it } from 'vitest';
import { buildAgents } from '../../src/agents/build.js';
import type { AgentDefinition, AgentsReport } from '../../src/agents/types.js';
import { analyze } from '../../src/core/engine.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';

function agentsOf(files: FileMap): AgentsReport {
  return buildAgents(analyze(snapshotFrom(files), {}));
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** The definitions of one file, by agent. */
function of(report: AgentsReport, file: string): Record<string, AgentDefinition> {
  return Object.fromEntries(
    report.definitions
      .filter((definition) => definition.file === file)
      .map((definition) => [definition.agent, definition]),
  );
}

const subagent = (model?: string, extra = '') =>
  `---\nname: reviewer\ndescription: Reviews code.\n${model === undefined ? '' : `model: ${model}\n`}${extra}---\nReview the diff.\n`;

describe('Claude Code subagents', () => {
  it('lists a subagent for Claude Code, and for the agents that read its folder too', () => {
    const report = agentsOf({ '.claude/agents/reviewer.md': subagent('opus', 'effort: high\n') });
    const byAgent = of(report, '.claude/agents/reviewer.md');
    expect(Object.keys(byAgent).sort()).toEqual([
      'claude-code',
      'copilot-cli',
      'copilot-vscode',
      'cursor',
    ]);
    expect(byAgent['claude-code']).toMatchObject({
      id: 'agent:.claude/agents/reviewer.md@claude-code',
      line: 2,
      name: 'reviewer',
      status: 'loads',
      model: { value: 'opus', form: 'alias', line: 4 },
      effective: { value: 'opus', source: 'definition' },
      effort: { value: 'high', line: 5 },
      tools: 'inherited',
      certainty: 'documented',
      evidence: ['claudeSubagents'],
    });
    // Cursor documents `inherit` or a Cursor model id; Copilot reads Claude's format.
    expect(byAgent['cursor']?.model).toMatchObject({ value: 'opus', form: 'not-documented' });
    expect(byAgent['copilot-vscode']?.model).toMatchObject({ value: 'opus', form: 'alias' });
  });

  it("follows Claude Code's order: the file, CLAUDE_CODE_SUBAGENT_MODEL, then the session", () => {
    const settings = (env: Record<string, string>, model?: string) =>
      json({ ...(model === undefined ? {} : { model }), env });
    const effective = (files: FileMap) =>
      agentsOf(files).definitions.find((definition) => definition.agent === 'claude-code')
        ?.effective;
    expect(
      effective({
        '.claude/agents/a.md': subagent(),
        '.claude/settings.json': settings({ CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }, 'sonnet'),
      }),
    ).toEqual({ value: 'haiku', source: 'setting', file: '.claude/settings.json' });
    expect(
      effective({
        '.claude/agents/a.md': subagent('inherit'),
        '.claude/settings.json': settings({ CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }, 'sonnet'),
      }),
    ).toEqual({ value: 'sonnet', source: 'session', file: '.claude/settings.json' });
    // ANTHROPIC_MODEL wins over `model`, and the local file over the shared one.
    expect(
      effective({
        '.claude/agents/a.md': subagent('inherit'),
        '.claude/settings.json': settings({ ANTHROPIC_MODEL: 'opus' }, 'sonnet'),
        '.claude/settings.local.json': settings({ ANTHROPIC_MODEL: 'haiku' }),
      }),
    ).toEqual({ value: 'haiku', source: 'session', file: '.claude/settings.local.json' });
    expect(effective({ '.claude/agents/a.md': subagent() })).toEqual({ source: 'not-visible' });
  });

  it('says that CLAUDE_CODE_SUBAGENT_MODEL_FORCE overrides the file', () => {
    const report = agentsOf({
      '.claude/agents/a.md': subagent('opus'),
      '.claude/settings.json': json({
        env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' },
      }),
    });
    expect(of(report, '.claude/agents/a.md')['claude-code']?.effective).toEqual({
      value: 'haiku',
      source: 'setting',
      file: '.claude/settings.json',
      overridden: { key: 'env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE', file: '.claude/settings.json' },
    });
    expect(report.settings.map(({ key, forced }) => ({ key, forced }))).toEqual([
      { key: 'env.CLAUDE_CODE_SUBAGENT_MODEL', forced: true },
      { key: 'env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE', forced: undefined },
    ]);
  });

  it('says why Claude Code skips a file, and lists no documentation', () => {
    const report = agentsOf({
      '.claude/agents/nameless.md': '---\ndescription: d\nmodel: opus\n---\n',
      '.claude/agents/README.md': '# Our agents\n',
      'docs/agents/reviewer.md': subagent('opus'),
    });
    expect(of(report, '.claude/agents/nameless.md')['claude-code']).toMatchObject({
      status: 'skipped',
      reason: 'no name',
      model: { value: 'opus', form: 'alias' },
    });
    expect(
      report.definitions.filter((definition) => definition.file !== '.claude/agents/nameless.md'),
    ).toEqual([]);
  });

  it('reads the model Claude Code reads from YAML only its retry repairs, at its line', () => {
    const text = '---\nname: a\ndescription: Use when: reviewing\nmodel: Claude Sonnet 4\n---\n';
    const definition = of(agentsOf({ '.claude/agents/a.md': text }), '.claude/agents/a.md')[
      'claude-code'
    ];
    expect(definition).toMatchObject({
      status: 'unknown',
      reason: "the frontmatter is not valid YAML, which Claude Code's reader may accept",
      model: { value: 'Claude Sonnet 4', form: 'not-documented', line: 4 },
    });
    // A merge key may supply the fields; a block ended inside a line is one only it finds.
    const report = agentsOf({
      '.claude/agents/merged.md': '---\nbase: &b\n  name: m\n<<: *b\ndescription: d\n---\n',
      '.claude/agents/inline.md': '---\nname: i\ndescription: d ---\nBody.\n',
    });
    expect(of(report, '.claude/agents/merged.md')['claude-code']).toMatchObject({
      status: 'unknown',
      reason: 'the frontmatter uses a << merge key',
    });
    expect(of(report, '.claude/agents/inline.md')['claude-code']).toMatchObject({
      status: 'unknown',
      reason: "only Claude Code's own reader finds the frontmatter",
    });
  });
});

describe('Codex custom agents', () => {
  const file = (lines: string[]) => `${lines.join('\n')}\n`;

  it('lists an agent file with its model and effort, from the config defaults too', () => {
    const report = agentsOf({
      '.codex/agents/reviewer.toml': file([
        'name = "reviewer"',
        'description = "Reviews code."',
        'developer_instructions = "Review the diff."',
        'model_reasoning_effort = "high"',
      ]),
      '.codex/agents/fast.toml': file([
        'name = "fast"',
        'description = "Quick fixes."',
        'developer_instructions = "Fix it."',
        'model = "gpt-6.1-mini"',
      ]),
      '.codex/config.toml': file([
        'model = "gpt-6.1-sol"',
        '[agents]',
        'default_subagent_model = "gpt-6.1-mini"',
      ]),
    });
    expect(of(report, '.codex/agents/reviewer.toml')['codex']).toMatchObject({
      name: 'reviewer',
      status: 'loads',
      effort: { value: 'high', line: 4 },
      effective: {
        value: 'gpt-6.1-mini',
        source: 'setting',
        file: '.codex/config.toml',
      },
      certainty: 'documented',
    });
    expect(of(report, '.codex/agents/fast.toml')['codex']).toMatchObject({
      model: { value: 'gpt-6.1-mini', form: 'id', line: 4 },
      effective: { value: 'gpt-6.1-mini', source: 'definition' },
    });
    expect(report.settings.map((setting) => [setting.key, setting.value, setting.applies])).toEqual(
      [
        ['agents.default_subagent_model', 'gpt-6.1-mini', 'subagents'],
        ['model', 'gpt-6.1-sol', 'session'],
      ],
    );
  });

  it('says why Codex ignores a file, as its source code does', () => {
    const report = agentsOf({
      '.codex/agents/a.toml': 'name = "a"\ndescription = "d"\n',
      '.codex/agents/b.toml': 'name = "b\n',
      '.codex/agents/c.toml': 'name = "c"\ndescription = "d"\ndeveloper_instructions = "  "\n',
    });
    expect(
      report.definitions.map(({ file, status, reason, certainty }) => ({
        file,
        status,
        reason,
        certainty,
      })),
    ).toEqual([
      {
        file: '.codex/agents/a.toml',
        status: 'skipped',
        reason: 'no developer_instructions',
        certainty: 'source-code',
      },
      {
        file: '.codex/agents/b.toml',
        status: 'skipped',
        reason: 'the file is not valid TOML',
        certainty: 'source-code',
      },
      {
        file: '.codex/agents/c.toml',
        status: 'skipped',
        reason: 'no developer_instructions',
        certainty: 'source-code',
      },
    ]);
  });
});

describe('Codex roles declared in config.toml', () => {
  it("names a declared role's file after the role, and needs no developer_instructions there", () => {
    const report = agentsOf({
      '.codex/config.toml': [
        '[agents]',
        'max_threads = 6',
        '[agents.explorer]',
        'description = "Explores the code."',
        'config_file = "agents/explorer.toml"',
        '[agents.planner]',
        'description = "Plans."',
        '[agents.remote]',
        'description = "Elsewhere."',
        'config_file = "../roles/remote.toml"',
        '',
      ].join('\n'),
      '.codex/agents/explorer.toml': 'model = "gpt-6-luna"\nsandbox_mode = "read-only"\n',
    });
    expect(
      report.definitions.map(({ id, name, status, reason, model }) => ({
        id,
        name,
        status,
        reason,
        model: model?.value,
      })),
    ).toEqual([
      {
        id: 'agent:.codex/agents/explorer.toml@codex',
        name: 'explorer',
        status: 'loads',
        reason: undefined,
        model: 'gpt-6-luna',
      },
      {
        id: 'agent:.codex/config.toml#planner@codex',
        name: 'planner',
        status: 'loads',
        reason: undefined,
        model: undefined,
      },
      {
        id: 'agent:.codex/config.toml#remote@codex',
        name: 'remote',
        status: 'skipped',
        reason: 'its config_file does not exist',
        model: undefined,
      },
    ]);
  });

  it('cannot tell the model of a role whose config_file is absolute or leaves the repository', () => {
    const report = agentsOf({
      '.codex/config.toml': [
        '[agents.abs]',
        'description = "x"',
        'config_file = "/etc/codex/abs.toml"',
        '[agents.out]',
        'description = "x"',
        'config_file = "../../out.toml"',
        '',
      ].join('\n'),
      '.codex/agents/abs.toml': 'name = "decoy"\n',
    });
    expect(report.definitions.map(({ name, status, reason }) => [name, status, reason])).toEqual([
      ['decoy', 'skipped', 'no description'],
      ['abs', 'unknown', 'its config_file is not a file agentcheckup reads'],
      ['out', 'unknown', 'its config_file is not a file agentcheckup reads'],
    ]);
  });

  it('keeps a declared role over a file of the same name, and skips a model that is not text', () => {
    const report = agentsOf({
      '.codex/config.toml': '[agents.reviewer]\ndescription = "Declared."\n',
      '.codex/agents/reviewer.toml':
        'name = "reviewer"\ndescription = "d"\ndeveloper_instructions = "x"\nmodel = "gpt-x"\n',
      '.codex/agents/typed.toml':
        'name = "typed"\ndescription = "d"\ndeveloper_instructions = "x"\nmodel = 5\n',
    });
    expect(of(report, '.codex/agents/reviewer.toml')['codex']).toMatchObject({
      status: 'shadowed',
      shadowedBy: '.codex/config.toml',
      certainty: 'documented',
    });
    expect(of(report, '.codex/agents/typed.toml')['codex']).toMatchObject({
      status: 'skipped',
      reason: 'model is not a string',
    });
  });

  it('lists a file past the TOML limits as unknown, never as skipped', () => {
    const big = `name = "many"\ndescription = "d"\ndeveloper_instructions = "x"\nmodel = "gpt-x"\npad = [${'0,'.repeat(150_000)}0]\n`;
    expect(
      of(agentsOf({ '.codex/agents/many.toml': big }), '.codex/agents/many.toml')['codex'],
    ).toMatchObject({
      status: 'unknown',
      reason: "the file is past agentcheckup's parser limits",
    });
  });

  it('still refuses blank developer_instructions in a declared file', () => {
    const report = agentsOf({
      '.codex/config.toml': '[agents.x]\ndescription = "d"\nconfig_file = "agents/x.toml"\n',
      '.codex/agents/x.toml': 'developer_instructions = " "\n',
    });
    expect(report.definitions.map(({ status, reason }) => [status, reason])).toEqual([
      ['skipped', 'no developer_instructions'],
    ]);
  });
});

describe('files reached through a symlink', () => {
  it('reads a file at every path an agent reaches it by, as what it is there', () => {
    const text = '---\nname: fix\ndescription: Fixes issues.\nmodel: sonnet\n---\nFix it.\n';
    const report = buildAgents(
      analyze(
        snapshotFrom(
          { '.github/agents/fix.agent.md': text, '.claude/agents/fix.agent.md': text },
          { symlinks: { '.claude/agents/fix.agent.md': '.github/agents/fix.agent.md' } },
        ),
        {},
      ),
    );
    const summary = report.definitions.map(
      ({ file, agent, status }) => `${agent} ${file} ${status}`,
    );
    expect(summary).toEqual([
      'claude-code .claude/agents/fix.agent.md loads',
      'copilot-cli .claude/agents/fix.agent.md shadowed',
      'copilot-vscode .claude/agents/fix.agent.md loads',
      'cursor .claude/agents/fix.agent.md loads',
      'copilot-cli .github/agents/fix.agent.md loads',
      'copilot-cloud .github/agents/fix.agent.md loads',
      'copilot-vscode .github/agents/fix.agent.md shadowed',
    ]);
    // The Copilot CLI loads .github/agents first, and the first of an id wins.
    expect(of(report, '.claude/agents/fix.agent.md')['copilot-cli']).toMatchObject({
      shadowedBy: '.github/agents/fix.agent.md',
      reason: 'another agent file has the same id',
      certainty: 'documented',
    });
    // Which of two files with one name VS Code keeps is not documented.
    expect(of(report, '.github/agents/fix.agent.md')['copilot-vscode']).toMatchObject({
      shadowedBy: '.claude/agents/fix.agent.md',
      certainty: 'unverified',
    });
    expect(of(report, '.claude/agents/fix.agent.md')['claude-code']?.model).toEqual({
      value: 'sonnet',
      form: 'alias',
      line: 4,
    });
  });
});

describe('Cursor', () => {
  it('takes .cursor over .claude over .codex for a name used twice', () => {
    const cursor = '---\nname: reviewer\nmodel: composer-2[fast=false]\nreadonly: true\n---\n';
    const report = agentsOf({
      '.cursor/agents/reviewer.md': cursor,
      '.claude/agents/reviewer.md': subagent('opus'),
      '.codex/agents/reviewer.md': '---\nname: reviewer\n---\n',
      '.codex/agents/other.md': '---\nmodel: inherit\n---\n',
    });
    const cursorOf = (file: string) => of(report, file)['cursor'];
    expect(cursorOf('.cursor/agents/reviewer.md')).toMatchObject({
      status: 'loads',
      model: { value: 'composer-2[fast=false]', form: 'id' },
      tools: 'read-only',
    });
    expect(cursorOf('.claude/agents/reviewer.md')).toMatchObject({
      status: 'shadowed',
      reason: 'another definition has the same name',
      shadowedBy: '.cursor/agents/reviewer.md',
      certainty: 'documented',
    });
    expect(cursorOf('.codex/agents/reviewer.md')).toMatchObject({
      status: 'shadowed',
      shadowedBy: '.cursor/agents/reviewer.md',
    });
    // Without `name`, the file name names the subagent.
    expect(cursorOf('.codex/agents/other.md')).toMatchObject({
      name: 'other',
      status: 'loads',
      model: { form: 'inherit' },
      effective: { source: 'not-visible' },
    });
  });

  it('reads nothing from a file without frontmatter, and leaves subfolders unverified', () => {
    const report = agentsOf({
      '.cursor/agents/README.md': '# Agents\n',
      '.cursor/agents/team/x.md': '---\nname: x\n---\n',
    });
    expect(report.definitions.map(({ file, certainty }) => ({ file, certainty }))).toEqual([
      { file: '.cursor/agents/team/x.md', certainty: 'unverified' },
    ]);
  });
});

describe('Gemini CLI', () => {
  it('requires a name and a description, and applies a settings override', () => {
    const report = agentsOf({
      '.gemini/agents/reviewer.md': '---\nname: reviewer\ndescription: d\nmodel: inherit\n---\n',
      '.gemini/agents/broken.md': '---\nname: broken\n---\n',
      '.gemini/settings.json': json({
        model: { name: 'gemini-3-pro' },
        agents: { overrides: { reviewer: { modelConfig: { model: 'gemini-3-flash' } } } },
      }),
    });
    expect(of(report, '.gemini/agents/reviewer.md')['gemini']?.effective).toEqual({
      value: 'gemini-3-flash',
      source: 'setting',
      file: '.gemini/settings.json',
      overridden: {
        key: 'agents.overrides.reviewer.modelConfig.model',
        file: '.gemini/settings.json',
      },
    });
    expect(of(report, '.gemini/agents/broken.md')['gemini']).toMatchObject({
      status: 'skipped',
      reason: 'no description',
    });
  });
});

describe('GitHub Copilot', () => {
  it('reads each surface where it looks, with its own names and fields', () => {
    const report = agentsOf({
      '.github/agents/docs.agent.md':
        '---\ndescription: Writes docs.\nmodel: [Claude Sonnet 4.5, GPT-5 (copilot)]\nreasoning-effort: high\n---\n',
      '.github/agents/team/review.md': '---\ndescription: Reviews.\nmodel: gpt-5\n---\n',
      '.github/copilot/settings.json': json({ model: 'claude-sonnet-5-5' }),
    });
    const docs = of(report, '.github/agents/docs.agent.md');
    expect(Object.keys(docs).sort()).toEqual(['copilot-cli', 'copilot-cloud', 'copilot-vscode']);
    expect(docs['copilot-vscode']).toMatchObject({
      name: 'docs',
      model: { value: ['Claude Sonnet 4.5', 'GPT-5 (copilot)'], form: 'name' },
      effort: { value: 'high' },
    });
    // The CLI takes a string only; a list is not documented there.
    expect(docs['copilot-cli']?.model?.form).toBe('not-documented');
    // Only the CLI reads subfolders, naming the agent by its path.
    const review = of(report, '.github/agents/team/review.md');
    expect(Object.keys(review)).toEqual(['copilot-cli']);
    expect(review['copilot-cli']).toMatchObject({
      name: 'team--review',
      effective: { value: 'gpt-5', source: 'definition' },
    });
  });

  it('skips a CLI or cloud agent without a description', () => {
    const report = agentsOf({ '.github/agents/x.agent.md': '---\nname: x\n---\n' });
    expect(report.definitions.map(({ agent, status }) => [agent, status]).sort()).toEqual([
      ['copilot-cli', 'skipped'],
      ['copilot-cloud', 'skipped'],
      ['copilot-vscode', 'loads'],
    ]);
  });
});

describe('Devin Local', () => {
  it('reads both layouts and its tool lists', () => {
    const report = agentsOf({
      '.devin/agents/reviewer.md': '---\nname: reviewer\nmodel: swe\nallowed-tools: [read]\n---\n',
      '.agents/agents/planner/AGENT.md': '---\ndescription: Plans.\n---\n',
    });
    expect(
      report.definitions.map(({ file, name, model, tools }) => ({
        file,
        name,
        form: model?.form,
        tools,
      })),
    ).toEqual([
      {
        file: '.agents/agents/planner/AGENT.md',
        name: 'planner',
        form: undefined,
        tools: 'inherited',
      },
      { file: '.devin/agents/reviewer.md', name: 'reviewer', form: 'alias', tools: 'listed' },
    ]);
  });
});

describe('the report', () => {
  const files: FileMap = {
    '.claude/agents/a.md': subagent('opus'),
    '.codex/agents/a.toml': 'name = "a"\ndescription = "d"\ndeveloper_instructions = "x"\n',
    '.claude/settings.json': json({ model: 'sonnet', availableModels: ['sonnet', 'haiku'] }),
  };

  it('is the same whatever the order of the files, with digests that ignore lines', () => {
    const forward = agentsOf(files);
    const backward = agentsOf(Object.fromEntries(Object.entries(files).reverse()));
    expect(backward).toEqual(forward);
    // A comment moves every field a line down: lines change, digests do not.
    const moved = agentsOf({
      ...files,
      '.claude/agents/a.md': subagent('opus').replace('---\n', '---\n# moved\n'),
    });
    const claudeOf = (report: AgentsReport) => of(report, '.claude/agents/a.md')['claude-code'];
    expect(claudeOf(moved)?.line).toBe((claudeOf(forward)?.line ?? 0) + 1);
    expect(moved.definitions.map((d) => d.digest)).toEqual(
      forward.definitions.map((d) => d.digest),
    );
    const changed = agentsOf({ ...files, '.claude/agents/a.md': subagent('haiku') });
    expect(of(changed, '.claude/agents/a.md')['claude-code']?.digest).not.toBe(
      of(forward, '.claude/agents/a.md')['claude-code']?.digest,
    );
  });

  it('lists the models a settings file allows', () => {
    expect(
      agentsOf(files).settings.find((setting) => setting.key === 'availableModels'),
    ).toMatchObject({
      value: 'sonnet, haiku',
      applies: 'allowed',
      line: 3,
    });
  });
});

describe('name collisions', () => {
  it('lets a nested folder serve its own sessions, and marks duplicates in one folder unverified', () => {
    const report = agentsOf({
      '.claude/agents/rev.md': subagent('haiku').replace('name: reviewer', 'name: rev'),
      '.claude/agents/team/rev.md': subagent('sonnet').replace('name: reviewer', 'name: rev'),
      'packages/api/.claude/agents/rev.md': subagent('opus').replace('name: reviewer', 'name: rev'),
    });
    const claude = (file: string) => of(report, file)['claude-code'];
    expect(claude('packages/api/.claude/agents/rev.md')).toMatchObject({
      status: 'loads',
      certainty: 'unverified',
    });
    expect(claude('.claude/agents/team/rev.md')).toMatchObject({
      status: 'shadowed',
      shadowedBy: '.claude/agents/rev.md',
      certainty: 'unverified',
    });
  });

  it('names Copilot CLI agents by path and loads two of one name under two ids', () => {
    const report = agentsOf({
      '.claude/agents/reviewer.md': subagent('opus'),
      '.claude/agents/zz-other.md': subagent('opus'),
    });
    const cli = report.definitions
      .filter((definition) => definition.agent === 'copilot-cli')
      .map(({ name, status }) => `${name ?? ''} ${status}`);
    expect(cli).toEqual(['reviewer loads', 'zz-other loads']);
  });
});

describe('Claude Code subagents agentcheckup cannot fully read', () => {
  it('lists a subagent with a merge key as unknown, and changes its digest with its text', () => {
    const text = (model: string) =>
      `---\nbase: &b\n  model: ${model}\nname: m\ndescription: d\n<<: *b\n---\n`;
    const definitionOf = (model: string) =>
      of(agentsOf({ '.claude/agents/m.md': text(model) }), '.claude/agents/m.md')['claude-code'];
    expect(definitionOf('opus')).toMatchObject({
      status: 'unknown',
      reason: 'the frontmatter uses a << merge key',
    });
    expect(definitionOf('opus')?.model).toBeUndefined();
    expect(definitionOf('opus')?.digest).not.toBe(definitionOf('haiku')?.digest);
  });

  it('still lists the readings of Cursor and Copilot when Claude Code calls a file documentation', () => {
    const report = agentsOf({ '.claude/agents/empty.md': '---\n---\nNotes.\n' });
    expect(report.definitions.map(({ agent }) => agent)).toEqual([
      'copilot-cli',
      'copilot-vscode',
      'cursor',
    ]);
  });
});

describe('model values and settings', () => {
  it('reads a null or blank model as no model', () => {
    for (const model of ['', '~', 'null', '""']) {
      const report = agentsOf({
        '.claude/agents/a.md': `---\nname: a\ndescription: d\nmodel: ${model}\n---\n`,
      });
      expect(of(report, '.claude/agents/a.md')['claude-code']?.model).toBeUndefined();
    }
  });

  it('keeps Codex inherit as written, since Codex does not document it', () => {
    const report = agentsOf({
      '.codex/agents/a.toml':
        'name = "a"\ndescription = "d"\ndeveloper_instructions = "x"\nmodel = "inherit"\n',
      '.codex/config.toml': '[agents]\ndefault_subagent_model = "gpt-x"\n',
    });
    expect(of(report, '.codex/agents/a.toml')['codex']?.effective).toEqual({
      value: 'inherit',
      source: 'definition',
    });
  });

  it('treats CLAUDE_CODE_SUBAGENT_MODEL set to inherit as unset, and reads the default session model', () => {
    const report = agentsOf({
      '.claude/agents/a.md': subagent(),
      '.claude/settings.json': json({
        env: { CLAUDE_CODE_SUBAGENT_MODEL: 'inherit', ANTHROPIC_DEFAULT_MODEL: 'sonnet' },
      }),
    });
    expect(of(report, '.claude/agents/a.md')['claude-code']?.effective).toEqual({
      value: 'sonnet',
      source: 'session',
      file: '.claude/settings.json',
    });
  });

  it('lists what the aliases resolve to, numbers as text, and never a credential', () => {
    const report = agentsOf({
      '.claude/settings.json': json({
        env: {
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-opus-5-5',
          CLAUDE_CODE_SUBAGENT_MODEL: 'https://user:hunter2@proxy.example/m',
          CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 1,
        },
      }),
    });
    expect(report.settings.map(({ key, value, applies }) => [key, value, applies])).toEqual([
      ['env.ANTHROPIC_DEFAULT_SONNET_MODEL', 'claude-opus-5-5', 'alias'],
      ['env.CLAUDE_CODE_SUBAGENT_MODEL', 'https://…@proxy.example/m', 'subagents'],
      ['env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE', '1', 'subagents'],
    ]);
    expect(JSON.stringify(report)).not.toContain('hunter2');
  });

  it("marks the subagent model forced by the local file's switch", () => {
    const report = agentsOf({
      '.claude/settings.json': json({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } }),
      '.claude/settings.local.json': json({ env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'true' } }),
    });
    expect(
      report.settings.find((setting) => setting.key === 'env.CLAUDE_CODE_SUBAGENT_MODEL')?.forced,
    ).toBe(true);
  });
});

describe('GitHub Copilot fields', () => {
  it('reads the Copilot CLI models list over model, and target', () => {
    const report = agentsOf({
      '.github/agents/a.agent.md':
        '---\ndescription: d\nmodel: gpt-x\nmodels: [claude-sonnet-5, gpt-y]\ntarget: vscode\n---\n',
    });
    const copilot = of(report, '.github/agents/a.agent.md');
    expect(copilot['copilot-cli']?.model?.value).toEqual(['claude-sonnet-5', 'gpt-y']);
    expect(copilot['copilot-vscode']?.model?.value).toBe('gpt-x');
    expect(copilot['copilot-cloud']).toMatchObject({
      status: 'skipped',
      reason: 'its target is vscode',
    });
  });

  it('reads a file without a header as a VS Code agent only', () => {
    const report = agentsOf({ '.github/agents/plain.agent.md': 'You review code.\n' });
    expect(report.definitions.map(({ agent, status }) => `${agent} ${status}`)).toEqual([
      'copilot-cli skipped',
      'copilot-cloud skipped',
      'copilot-vscode loads',
    ]);
  });
});

describe('switches and Gemini CLI names', () => {
  it("skips Codex's and Gemini CLI's agents where the root's settings turn them off", () => {
    const codex = 'name = "x"\ndescription = "d"\ndeveloper_instructions = "x"\n';
    const gemini = '---\nname: g\ndescription: d\n---\n';
    const off = agentsOf({
      '.codex/agents/x.toml': codex,
      '.codex/config.toml': '[features]\nmulti_agent = false\n',
      '.gemini/agents/g.md': gemini,
      '.gemini/settings.json': json({ agents: { overrides: { g: { enabled: false } } } }),
    });
    expect(off.definitions.map(({ agent, status, reason }) => [agent, status, reason])).toEqual([
      ['codex', 'skipped', "multi-agent tools are off in the root's .codex/config.toml"],
      ['gemini', 'skipped', "the agent is turned off in the root's .gemini/settings.json"],
    ]);
    const on = agentsOf({
      '.codex/agents/x.toml': codex,
      '.codex/config.toml': '[agents]\nenabled = true\n',
      '.gemini/agents/g.md': gemini,
    });
    expect(on.definitions.map(({ status }) => status)).toEqual(['loads', 'loads']);
  });

  it('skips a Gemini CLI agent whose name is not a slug', () => {
    const report = agentsOf({
      '.gemini/agents/bad.md': '---\nname: Bad Name\ndescription: d\n---\n',
    });
    expect(report.definitions.map(({ status, reason }) => [status, reason])).toEqual([
      ['skipped', 'the name is not lowercase letters, digits, hyphens and underscores'],
    ]);
  });

  it("does not count Devin Local's agent folder layout as a subfolder", () => {
    const report = agentsOf({ '.devin/agents/helper/AGENT.md': '---\nname: helper\n---\n' });
    expect(report.definitions.map(({ certainty }) => certainty)).toEqual(['documented']);
  });
});

describe('caching', () => {
  it('builds one report per artifact list', () => {
    const analysis = analyze(snapshotFrom({ '.claude/agents/a.md': subagent('opus') }), {});
    expect(buildAgents(analysis)).toBe(buildAgents(analysis));
  });
});
