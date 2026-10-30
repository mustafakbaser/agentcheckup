import { describe, expect, it } from 'vitest';
import { buildAgents } from '../../src/agents/build.js';
import { isModelChoice } from '../../src/agents/settings.js';
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

  it('names a file without frontmatter after the file, unverified, and leaves subfolders unverified', () => {
    const report = agentsOf({
      '.cursor/agents/plain.md': 'You plan.\n',
      '.cursor/agents/team/x.md': '---\nname: x\n---\n',
    });
    // Every field is optional, the name taken from the file name; no example shows a file
    // without a header.
    expect(
      report.definitions.map(({ file, name, status, certainty }) => ({
        file,
        name,
        status,
        certainty,
      })),
    ).toEqual([
      { file: '.cursor/agents/plain.md', name: 'plain', status: 'loads', certainty: 'unverified' },
      { file: '.cursor/agents/team/x.md', name: 'x', status: 'loads', certainty: 'unverified' },
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

  it("gives the cloud agent the root's folder only, and the others a package's too", () => {
    const report = agentsOf({
      'pkg/.github/agents/fix.agent.md': '---\ndescription: Fixes.\n---\nFix.\n',
    });
    expect(Object.keys(of(report, 'pkg/.github/agents/fix.agent.md')).sort()).toEqual([
      'copilot-cli',
      'copilot-vscode',
    ]);
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

  it('reads the first of AGENT.md, AGENTS.md, agent.md and agents.md in a directory', () => {
    const report = agentsOf({
      '.devin/agents/scout/AGENT.md': '---\ndescription: First.\n---\n',
      '.devin/agents/scout/agents.md': '---\ndescription: Last.\n---\n',
      '.devin/agents/lone/agents.md': '---\ndescription: Alone.\n---\n',
    });
    expect(
      report.definitions.map(({ file, status, reason, certainty }) => [
        file,
        status,
        reason,
        certainty,
      ]),
    ).toEqual([
      ['.devin/agents/lone/agents.md', 'loads', undefined, 'documented'],
      ['.devin/agents/scout/AGENT.md', 'loads', undefined, 'documented'],
      [
        '.devin/agents/scout/agents.md',
        'shadowed',
        'another file of its directory comes first',
        'documented',
      ],
    ]);
  });

  it('skips a profile named like a built-in one, and names one without frontmatter after its file', () => {
    const report = agentsOf({
      '.devin/agents/explore.md': '---\nname: subagent_explore\ndescription: Mine.\n---\n',
      '.devin/agents/subagent_general.md': 'Body only.\n',
      '.devin/agents/plain.md': 'Body only.\n',
    });
    expect(
      report.definitions.map(({ file, name, status, reason, certainty }) => [
        file,
        name,
        status,
        reason,
        certainty,
      ]),
    ).toEqual([
      [
        '.devin/agents/explore.md',
        'subagent_explore',
        'skipped',
        'the name is a built-in profile',
        'documented',
      ],
      ['.devin/agents/plain.md', 'plain', 'loads', undefined, 'unverified'],
      [
        '.devin/agents/subagent_general.md',
        'subagent_general',
        'skipped',
        'the name is a built-in profile',
        'documented',
      ],
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
    // A setting a definition inherits from is a change of the setting, not of the definition.
    const inheriting = (model: string) =>
      agentsOf({
        '.claude/agents/b.md': subagent(),
        '.claude/settings.json': json({ model }),
      }).definitions.find((d) => d.agent === 'claude-code');
    expect(inheriting('opus')?.effective.value).not.toBe(inheriting('haiku')?.effective.value);
    expect(inheriting('opus')?.digest).toBe(inheriting('haiku')?.digest);
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

  it('lists a merge key as unknown for every agent, with the file text in each digest', () => {
    const text = (model: string, extra = '') =>
      `---\nbase: &b\n  model: ${model}\n  description: d\n<<: *b\nname: m\n${extra}---\nBody.\n`;
    const files = (model: string): FileMap => ({
      '.claude/agents/m.md': text(model),
      '.cursor/agents/m.md': text(model),
      '.github/agents/m.agent.md': text(model),
      '.gemini/agents/m.md': text(model),
      '.devin/agents/m.md': text(model),
    });
    const before = agentsOf(files('opus'));
    const after = agentsOf(files('haiku'));
    // The model and the description sit behind the merge key: no agent's reading is skipped
    // for want of them, and none claims the file has no model.
    expect(before.definitions.map(({ agent, status }) => `${agent} ${status}`)).toEqual(
      before.definitions.map(({ agent }) => `${agent} unknown`),
    );
    // Four agents read .claude/agents, three Copilot surfaces .github/agents.
    expect(before.definitions).toHaveLength(10);
    for (const definition of before.definitions) {
      expect(definition.reason).toBe('the frontmatter uses a << merge key');
      expect(definition.model).toBeUndefined();
    }
    const digests = (report: AgentsReport) => report.definitions.map(({ digest }) => digest);
    for (const [index, digest] of digests(before).entries()) {
      expect(digests(after)[index]).not.toBe(digest);
    }
    // A key set beside the merge key wins over it, so a model written there is read.
    const beside = agentsOf({ '.cursor/agents/m.md': text('opus', 'model: inherit\n') });
    expect(of(beside, '.cursor/agents/m.md')['cursor']?.model).toMatchObject({ value: 'inherit' });
  });

  it('reads a merge key written with its tag as one, for Claude Code too', () => {
    for (const key of ['!!merge ', '? !!merge\n', '!<tag:yaml.org,2002:merge> ']) {
      const text = (model: string) =>
        `---\nname: m\ndescription: d\n${key}: {model: ${model}}\n---\nBody.\n`;
      const files = (model: string): FileMap => ({
        '.claude/agents/m.md': text(model),
        '.gemini/agents/m.md': text(model),
      });
      const before = agentsOf(files('a'));
      const after = agentsOf(files('b'));
      expect(before.definitions.map(({ agent, status }) => `${agent} ${status}`)).toEqual(
        before.definitions.map(({ agent }) => `${agent} unknown`),
      );
      for (const [index, definition] of before.definitions.entries()) {
        expect(after.definitions[index]?.digest).not.toBe(definition.digest);
      }
    }
  });

  it('keeps a skip a key beside the merge key decides, and lets the merge key supply a missing one', () => {
    const report = agentsOf({
      '.github/agents/vs.agent.md':
        '---\nbase: &b\n  model: gpt-5\n<<: *b\ndescription: d\ntarget: vscode\n---\n',
      '.devin/agents/explore.md':
        '---\nbase: &b\n  model: swe\n<<: *b\nname: subagent_explore\n---\n',
      '.github/agents/nodesc.agent.md': '---\nbase: &b\n  description: d\n<<: *b\n---\n',
    });
    expect(of(report, '.github/agents/vs.agent.md')['copilot-cloud']).toMatchObject({
      status: 'skipped',
      reason: 'its target is vscode',
    });
    expect(of(report, '.devin/agents/explore.md')['windsurf']).toMatchObject({
      status: 'skipped',
      reason: 'the name is a built-in profile',
    });
    expect(of(report, '.github/agents/nodesc.agent.md')['copilot-cli']).toMatchObject({
      status: 'unknown',
      reason: 'the frontmatter uses a << merge key',
    });
  });

  it('knows no model for a file it cannot read, unless a setting overrides every one', () => {
    const merged = '---\nbase: &b\n  model: opus\n<<: *b\nname: m\ndescription: d\n---\n';
    const plain = of(
      agentsOf({
        '.claude/agents/m.md': merged,
        '.claude/settings.json': json({ model: 'sonnet' }),
      }),
      '.claude/agents/m.md',
    )['claude-code'];
    expect(plain?.effective).toEqual({ source: 'not-visible' });
    const forced = of(
      agentsOf({
        '.claude/agents/m.md': merged,
        '.claude/settings.json': json({
          env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' },
        }),
      }),
      '.claude/agents/m.md',
    )['claude-code'];
    expect(forced?.effective).toMatchObject({
      value: 'haiku',
      source: 'setting',
      overridden: { key: 'env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE' },
    });
    const overridden = of(
      agentsOf({
        '.gemini/agents/m.md': merged,
        '.gemini/settings.json': json({
          agents: { overrides: { m: { modelConfig: { model: 'gemini-3-flash' } } } },
        }),
      }),
      '.gemini/agents/m.md',
    )['gemini'];
    expect(overridden?.effective).toMatchObject({
      value: 'gemini-3-flash',
      source: 'setting',
      overridden: { key: 'agents.overrides.m.modelConfig.model' },
    });
    // A file it reads in full with no model still runs on the session's.
    const read = of(
      agentsOf({
        '.claude/agents/a.md': subagent(),
        '.claude/settings.json': json({ model: 'sonnet' }),
      }),
      '.claude/agents/a.md',
    )['claude-code'];
    expect(read?.effective).toMatchObject({ value: 'sonnet', source: 'session' });
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

  it('ignores ANTHROPIC_DEFAULT_MODEL set to a value Claude Code ignores', () => {
    const files = (model: string) => ({
      '.claude/agents/reviewer.md': subagent('inherit'),
      '.claude/agents/tester.md': '---\nname: tester\ndescription: Runs tests.\n---\nTest.\n',
      '.claude/settings.json': json({ env: { ANTHROPIC_DEFAULT_MODEL: model } }),
    });
    for (const ignored of ['haiku', 'default', ' inherit ', 'opusplan']) {
      const report = agentsOf(files(ignored));
      expect(of(report, '.claude/agents/reviewer.md')['claude-code']?.effective).toEqual({
        source: 'not-visible',
      });
      expect(of(report, '.claude/agents/tester.md')['claude-code']?.effective).toEqual({
        source: 'not-visible',
      });
      // Still listed as the setting it is, but it picks no model.
      const [setting] = report.settings;
      expect(setting?.key).toBe('env.ANTHROPIC_DEFAULT_MODEL');
      expect(isModelChoice(setting!)).toBe(false);
    }
    const sonnet = agentsOf(files('sonnet'));
    expect(of(sonnet, '.claude/agents/reviewer.md')['claude-code']?.effective).toEqual({
      value: 'sonnet',
      source: 'session',
      file: '.claude/settings.json',
    });
    expect(isModelChoice(sonnet.settings[0]!)).toBe(true);
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

  it('does not skip a file meant for GitHub Copilot in VS Code, whose target only picks a schema', () => {
    const report = agentsOf({
      '.github/agents/gh.agent.md': '---\ndescription: d\ntarget: github-copilot\n---\n',
      '.github/agents/both.agent.md': '---\ndescription: d\n---\n',
    });
    const gh = of(report, '.github/agents/gh.agent.md');
    expect(gh['copilot-vscode']).toMatchObject({
      status: 'unknown',
      reason: 'its target is github-copilot',
      certainty: 'unverified',
      evidence: ['copilotCustomAgents', 'vscodeCustomAgentFile'],
    });
    expect(gh['copilot-cli']?.status).toBe('loads');
    expect(gh['copilot-cloud']?.status).toBe('loads');
    // Without a target every surface loads it.
    expect(
      Object.values(of(report, '.github/agents/both.agent.md')).map(({ status }) => status),
    ).toEqual(['loads', 'loads', 'loads']);
  });

  it("runs every Copilot CLI subagent on the session's model when it is auto", () => {
    const files = (model: string): FileMap => ({
      '.github/agents/r.agent.md': '---\ndescription: d\nmodel: claude-sonnet-5\n---\n',
      '.github/agents/plain.agent.md': '---\ndescription: d\n---\n',
      '.github/copilot/settings.json': json({ model }),
    });
    const auto = agentsOf(files('Auto'));
    expect(of(auto, '.github/agents/r.agent.md')['copilot-cli']?.effective).toEqual({
      value: 'Auto',
      source: 'session',
      file: '.github/copilot/settings.json',
      overridden: { key: 'model', file: '.github/copilot/settings.json' },
    });
    expect(of(auto, '.github/agents/plain.agent.md')['copilot-cli']?.effective).toEqual({
      value: 'Auto',
      source: 'session',
      file: '.github/copilot/settings.json',
    });
    // VS Code does not read the CLI's settings.
    expect(of(auto, '.github/agents/r.agent.md')['copilot-vscode']?.effective).toEqual({
      value: 'claude-sonnet-5',
      source: 'definition',
    });
    // Another session model leaves the definition's own.
    expect(
      of(agentsOf(files('gpt-5')), '.github/agents/r.agent.md')['copilot-cli']?.effective,
    ).toEqual({ value: 'claude-sonnet-5', source: 'definition' });
  });

  it("reads Claude Code's aliases as models VS Code maps but the Copilot CLI does not document", () => {
    const forms = (model: string) =>
      Object.fromEntries(
        Object.entries(
          of(agentsOf({ '.claude/agents/r.md': subagent(model) }), '.claude/agents/r.md'),
        ).map(([agent, definition]) => [agent, definition.model?.form]),
      );
    expect(forms('opus')).toEqual({
      'claude-code': 'alias',
      'copilot-cli': 'not-documented',
      'copilot-vscode': 'alias',
      cursor: 'not-documented',
    });
    expect(forms('sonnet[1m]')['copilot-cli']).toBe('not-documented');
    expect(forms('Opus')['copilot-cli']).toBe('not-documented');
    // A model id is one the Copilot CLI takes, as in its own files, and `inherit` runs on the
    // session's model, as one it cannot use does.
    expect(forms('claude-opus-5.5')['copilot-cli']).toBe('id');
    expect(forms('inherit')['copilot-cli']).toBe('inherit');
    const inherits = agentsOf({
      '.claude/agents/r.md': subagent('inherit'),
      '.github/copilot/settings.json': json({ model: 'gpt-5' }),
    });
    expect(of(inherits, '.claude/agents/r.md')['copilot-cli']?.effective).toEqual({
      value: 'gpt-5',
      source: 'session',
      file: '.github/copilot/settings.json',
    });
    // The same in its own folder, where `inherit` is no model it can use either.
    const own = agentsOf({
      '.github/agents/r.agent.md':
        '---\ndescription: Reviews code.\nmodel: inherit\n---\nReview.\n',
      '.github/copilot/settings.json': json({ model: 'gpt-5' }),
    });
    expect(of(own, '.github/agents/r.agent.md')['copilot-cli']?.effective).toEqual({
      value: 'gpt-5',
      source: 'session',
      file: '.github/copilot/settings.json',
    });
    expect(of(own, '.github/agents/r.agent.md')['copilot-vscode']?.model?.form).toBe('id');
    // Its `models` list wins over `model` in Claude's folder too.
    const listed = of(
      agentsOf({ '.claude/agents/r.md': subagent('sonnet', 'models: [gpt-5, opus]\n') }),
      '.claude/agents/r.md',
    );
    expect(listed['copilot-cli']?.model).toMatchObject({
      value: ['gpt-5', 'opus'],
      form: 'not-documented',
    });
    expect(listed['claude-code']?.model).toMatchObject({ value: 'sonnet', form: 'alias' });
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

  it('judges a nested definition by the settings of a session started beside it', () => {
    const codex = 'name = "x"\ndescription = "d"\ndeveloper_instructions = "x"\n';
    const report = buildAgents(
      analyze(
        snapshotFrom(
          {
            // Codex layers config.toml from the root down: the root's switch reaches pkg's agents,
            // and app's own layer turns them back on.
            '.codex/config.toml': '[agents]\nenabled = false\n',
            'pkg/.codex/agents/x.toml': codex,
            'app/.codex/agents/x.toml': codex,
            'app/.codex/config.toml': '[agents]\nenabled = true\n',
            // Gemini CLI reads the settings of the folder it starts in, not the root's.
            '.gemini/settings.json': json({ experimental: { enableAgents: false } }),
            'pkg/.gemini/agents/g.md': '---\nname: g\ndescription: d\n---\n',
            'app/.gemini/agents/g.md': '---\nname: g\ndescription: d\n---\n',
            'app/.gemini/settings.json': json({ agents: { overrides: { g: { enabled: false } } } }),
          },
          // Codex's project root is the repository's.
          { paths: ['.git/HEAD'] },
        ),
        {},
      ),
    );
    expect(
      report.definitions.map(({ file, status, reason }) => [file, status, reason ?? '']),
    ).toEqual([
      ['app/.codex/agents/x.toml', 'loads', ''],
      [
        'app/.gemini/agents/g.md',
        'skipped',
        'the agent is turned off in a nested .gemini/settings.json',
      ],
      [
        'pkg/.codex/agents/x.toml',
        'skipped',
        "multi-agent tools are off in the root's .codex/config.toml",
      ],
      ['pkg/.gemini/agents/g.md', 'loads', ''],
    ]);
  });

  it('skips a Gemini CLI agent file without frontmatter', () => {
    const report = agentsOf({ '.gemini/agents/plain.md': 'You help.\n' });
    expect(
      report.definitions.map(({ status, reason, certainty }) => [status, reason, certainty]),
    ).toEqual([['skipped', 'no frontmatter', 'documented']]);
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

describe('agent folders on whole path segments, in any case, and files the scan did not read', () => {
  const brief = (report: AgentsReport): string[] =>
    report.definitions.map(
      ({ agent, file, name, status, certainty }) =>
        `${agent} ${file} ${name ?? '-'} ${status} ${certainty}`,
    );

  it('takes a folder only from whole path segments, so x.cursor/agents is no .cursor/agents', () => {
    const report = agentsOf({
      '.cursor/agents/reviewer.md': '---\nname: reviewer\ndescription: Real.\n---\nBig.\n',
      '.claude/agents/x.cursor/agents/r.md': '---\nname: reviewer\ndescription: Fake.\n---\nR.\n',
      '.github/agents/a.github/agents/reviewer.agent.md': '---\ndescription: Nested.\n---\nN.\n',
      '.codex/agents/team.codex/big.toml':
        'name = "big"\ndescription = "d"\ndeveloper_instructions = "x"\n',
    });
    // Cursor ranks the real .cursor folder first, so the Claude-folder file is the one shadowed.
    expect(of(report, '.cursor/agents/reviewer.md')['cursor']?.status).toBe('loads');
    expect(of(report, '.claude/agents/x.cursor/agents/r.md')['cursor']?.status).toBe('shadowed');
    // The Copilot CLI names the nested file by its whole path below .github/agents; VS Code does
    // not read a subfolder.
    const nested = of(report, '.github/agents/a.github/agents/reviewer.agent.md');
    expect(nested['copilot-cli']?.name).toBe('a.github--agents--reviewer');
    expect(Object.keys(nested)).not.toContain('copilot-vscode');
    // A folder named team.codex belongs to the root's .codex.
    expect(of(report, '.codex/agents/team.codex/big.toml')['codex']).toMatchObject({
      status: 'loads',
    });
  });

  it('reads a folder spelled in another case where the file system ignores case, unverified', () => {
    const report = agentsOf({
      '.claude/Agents/rev.md': '---\nname: rev\ndescription: Root.\n---\nR.\n',
      'packages/x/.Claude/agents/xx.md': '---\nname: xx\ndescription: Nested.\n---\nX.\n',
    });
    expect(brief(report).filter((line) => line.startsWith('claude-code'))).toEqual([
      'claude-code .claude/Agents/rev.md rev loads unverified',
      'claude-code packages/x/.Claude/agents/xx.md xx loads unverified',
    ]);
  });

  it('names agent.md after its directory for Devin Local only', () => {
    const report = agentsOf({
      '.cursor/agents/agent.md': '---\ndescription: d\n---\nA.\n',
      '.github/agents/team/agent.md': '---\ndescription: d\n---\nA.\n',
      '.devin/agents/scout/agent.md': '---\ndescription: d\n---\nA.\n',
    });
    expect(of(report, '.cursor/agents/agent.md')['cursor']?.name).toBe('agent');
    expect(of(report, '.github/agents/team/agent.md')['copilot-cli']?.name).toBe('team--agent');
    expect(of(report, '.devin/agents/scout/agent.md')['windsurf']?.name).toBe('scout');
  });

  it('reads a Gemini CLI remote agent by its card, and a list of them as unknown', () => {
    const report = agentsOf({
      '.gemini/agents/remote.md':
        '---\nkind: remote\nname: remote-one\nagent_card_url: https://example.com/card\n---\n',
      '.gemini/agents/cardless.md': '---\nkind: remote\nname: cardless\n---\n',
      '.gemini/agents/list.md':
        '---\n- kind: remote\n  name: a\n  agent_card_url: https://example.com/a\n---\n',
    });
    expect(brief(report)).toEqual([
      'gemini .gemini/agents/cardless.md cardless skipped documented',
      'gemini .gemini/agents/list.md list unknown unverified',
      'gemini .gemini/agents/remote.md remote-one loads unverified',
    ]);
    expect(of(report, '.gemini/agents/cardless.md')['gemini']?.reason).toBe(
      'no agent_card_url or agent_card_json',
    );
  });

  it('lets a declared Codex role it cannot read keep its precedence over a file of the same name', () => {
    const report = agentsOf({
      '.codex/config.toml': '[agents.reviewer]\nconfig_file = "/opt/roles/reviewer.toml"\n',
      '.codex/agents/reviewer.toml':
        'name = "reviewer"\ndescription = "d"\ndeveloper_instructions = "x"\n',
    });
    expect(brief(report)).toEqual([
      'codex .codex/agents/reviewer.toml reviewer shadowed unverified',
      'codex .codex/config.toml reviewer unknown unverified',
    ]);
  });

  it('lists an agent file the scan did not read as one each agent may load', () => {
    const analysis = analyze(
      {
        ...snapshotFrom({ '.claude/agents/small.md': subagent() }),
        skipped: [{ path: '.claude/agents/huge.md', reason: 'too-large', size: 2_000_000 }],
        unresolvedSymlinks: [
          { path: '.cursor/agents/outside.md', target: '/etc/agent.md', problem: 'outside-root' },
          { path: '.cursor/agents/broken.md', target: 'missing.md', problem: 'broken' },
        ],
      },
      {},
    );
    const report = buildAgents(analysis);
    expect(brief(report).filter((line) => !line.includes('small.md'))).toEqual([
      'claude-code .claude/agents/huge.md huge unknown unverified',
      'copilot-cli .claude/agents/huge.md huge unknown unverified',
      'copilot-vscode .claude/agents/huge.md huge unknown unverified',
      'cursor .claude/agents/huge.md huge unknown unverified',
      'cursor .cursor/agents/outside.md outside unknown unverified',
    ]);
    expect(of(report, '.claude/agents/huge.md')['claude-code']?.reason).toBe(
      'the scan did not read the file: it is larger than the scan reads',
    );
  });
});
