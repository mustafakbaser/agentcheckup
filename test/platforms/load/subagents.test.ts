import { describe, expect, it } from 'vitest';
import { analyze } from '../../../src/core/engine.js';
import { PLATFORM_IDS } from '../../../src/core/types.js';
import { loadPlans } from '../../../src/platforms/load/index.js';
import { loadCline } from '../../../src/platforms/load/cline.js';
import { withSubagents } from '../../../src/platforms/load/subagents.js';
import {
  CONTEXT_AGENTS,
  type ContextAgent,
  type LoadEntry,
  type LoadPlan,
  type OwnContext,
} from '../../../src/platforms/load/types.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

interface Options {
  readonly cwd?: string;
  readonly extras?: SnapshotExtras;
}

function plansOf(files: FileMap, options: Options = {}): LoadPlan[] {
  const extras = options.extras ?? {};
  // The walker reads a file an instruction file imports; the snapshot helper needs telling.
  const imported = Object.keys(files).filter((path) => path.startsWith('docs/'));
  const analysis = analyze(
    snapshotFrom(files, {
      ...extras,
      imported: [...imported, ...(extras.imported ?? [])],
      paths: ['.git/HEAD', ...(extras.paths ?? [])],
    }),
    { targets: PLATFORM_IDS },
  );
  return loadPlans(analysis, {
    agents: CONTEXT_AGENTS,
    cwd: options.cwd ?? '',
    config: analysis.config,
  });
}

function planOf(plans: readonly LoadPlan[], agent: ContextAgent): LoadPlan {
  const plan = plans.find((item) => item.agent === agent);
  if (plan === undefined) throw new Error(`No plan for ${agent}.`);
  return plan;
}

/** `trigger path` of each subagent entry, `?` marking unverified ones. */
function subagents(plan: LoadPlan): string[] {
  return plan.entries
    .filter((entry) => entry.role === 'subagent')
    .map(
      (entry) => `${entry.trigger} ${entry.path}${entry.certainty === 'unverified' ? ' ?' : ''}`,
    );
}

/** `code path` of each subagent skip, with the rule when it has one. */
function skips(plan: LoadPlan): string[] {
  return plan.skipped
    .filter((skip) => skip.role === 'subagent')
    .map(
      (skip) => `${skip.code} ${skip.path}${skip.ruleId === undefined ? '' : ` ${skip.ruleId}`}`,
    );
}

function subagent(plan: LoadPlan, id: string): LoadEntry {
  const found = plan.entries.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No entry ${id} in ${plan.agent}.`);
  return found;
}

const reviewer = '---\nname: reviewer\ndescription: Reviews code.\n---\nYou review code.\n';

describe('subagents in every plan', () => {
  it("lists each agent's definitions, with the listing's size at startup", () => {
    const plans = plansOf({
      '.claude/agents/reviewer.md': reviewer,
      '.cursor/agents/planner.md': '---\nname: planner\ndescription: Plans.\n---\nPlan.\n',
      '.codex/agents/tester.toml':
        'name = "tester"\ndescription = "Runs tests."\ndeveloper_instructions = "Run the tests."\n',
      '.gemini/agents/helper.md': '---\nname: helper\ndescription: Helps.\n---\nHelp.\n',
      '.github/agents/fixer.agent.md': '---\ndescription: Fixes issues.\n---\nFix.\n',
      '.devin/agents/scout.md': '---\nname: scout\ndescription: Explores.\n---\nLook.\n',
    });
    expect(subagents(planOf(plans, 'claude-code'))).toEqual(['startup .claude/agents/reviewer.md']);
    // Cursor reads `.cursor/agents` and Claude Code's folder, and documents that its model reads
    // the descriptions, as Gemini CLI and Devin Local do; Codex and Copilot do not document it.
    expect(subagents(planOf(plans, 'cursor'))).toEqual([
      'startup .claude/agents/reviewer.md',
      'startup .cursor/agents/planner.md',
    ]);
    expect(subagents(planOf(plans, 'codex'))).toEqual(['startup .codex/agents/tester.toml ?']);
    expect(subagents(planOf(plans, 'gemini'))).toEqual(['startup .gemini/agents/helper.md']);
    expect(subagents(planOf(plans, 'copilot-cli'))).toEqual([
      'startup .claude/agents/reviewer.md ?',
      'startup .github/agents/fixer.agent.md ?',
    ]);
    expect(subagents(planOf(plans, 'copilot-cloud'))).toEqual([
      'startup .github/agents/fixer.agent.md ?',
    ]);
    expect(subagents(planOf(plans, 'windsurf'))).toEqual(['startup .devin/agents/scout.md']);
    // Cline reads no custom agent files.
    expect(subagents(planOf(plans, 'cline'))).toEqual([]);

    expect(subagent(planOf(plans, 'codex'), 'subagent:.codex/agents/tester.toml')).toEqual({
      id: 'subagent:.codex/agents/tester.toml',
      role: 'subagent',
      trigger: 'startup',
      path: '.codex/agents/tester.toml',
      realPath: '.codex/agents/tester.toml',
      name: 'tester',
      size: { bytes: 'testerRuns tests.'.length, chars: 'testerRuns tests.'.length, tokens: 5 },
      // What the subagent starts with: `developer_instructions` is its prompt; whether
      // AGENTS.md reaches it is not documented.
      ownContext: {
        size: { bytes: 14, chars: 14, tokens: 4 },
        parts: [
          {
            kind: 'prompt',
            size: { bytes: 14, chars: 14, tokens: 4 },
            certainty: 'documented',
            evidence: ['codexSubagents'],
          },
        ],
        notVisible: ['environment', 'task', 'tools', 'instructions'],
      },
      certainty: 'unverified',
      evidence: ['codexSubagents'],
    });
    // The Copilot CLI knows the agent by its file name; the listing has no name of its own.
    expect(
      subagent(planOf(plans, 'copilot-cli'), 'subagent:.github/agents/fixer.agent.md'),
    ).toMatchObject({ name: 'fixer', size: { chars: 'fixerFixes issues.'.length } });
  });

  it('adds the listing to the startup total, and nothing to the on-demand total', () => {
    const files = { 'CLAUDE.md': 'Rules.\n' };
    const without = planOf(plansOf(files), 'claude-code');
    const plan = planOf(
      plansOf({ ...files, '.claude/agents/reviewer.md': reviewer }),
      'claude-code',
    );
    const listing = 'reviewerReviews code.'.length;
    expect(plan.totals.startup).toEqual({
      bytes: without.totals.startup.bytes + listing,
      chars: without.totals.startup.chars + listing,
      tokens: Math.ceil((without.totals.startup.chars + listing) / 4),
    });
    expect(plan.totals.onDemand).toEqual(without.totals.onDemand);
  });

  it('gives a plan without custom agents back as it is', () => {
    const analysis = analyze(snapshotFrom({ 'AGENTS.md': 'Rules.\n' }, { paths: ['.git/HEAD'] }));
    const plan = loadCline(analysis, { cwd: '', config: analysis.config });
    expect(withSubagents(plan, analysis)).toBe(plan);
  });

  it('names a role config.toml declares by the file and the role', () => {
    const plan = planOf(
      plansOf({
        '.codex/config.toml':
          '[agents.reviewer]\ndescription = "Reviews."\n\n[agents.writer]\ndescription = "Writes."\n',
      }),
      'codex',
    );
    expect(
      plan.entries.filter((entry) => entry.role === 'subagent').map((entry) => entry.id),
    ).toEqual(['subagent:.codex/config.toml#reviewer', 'subagent:.codex/config.toml#writer']);
  });
});

describe('subagents the agent does not list', () => {
  it('skips a definition the agent drops, citing the rule only where one reports it', () => {
    const plans = plansOf({
      '.claude/agents/nameless.md': '---\ndescription: No name.\n---\n',
      '.gemini/agents/Upper.md': '---\nname: Upper\ndescription: Upper case.\n---\n',
      '.codex/agents/broken.toml': 'name = [\n',
    });
    expect(skips(planOf(plans, 'claude-code'))).toEqual([
      'invalid-subagent .claude/agents/nameless.md instr/subagent-invalid',
    ]);
    expect(skips(planOf(plans, 'gemini'))).toEqual(['invalid-subagent .gemini/agents/Upper.md']);
    expect(skips(planOf(plans, 'codex'))).toEqual(['invalid-toml .codex/agents/broken.toml']);
  });

  it('skips the definitions a root switch turns off', () => {
    const plans = plansOf({
      '.gemini/settings.json': JSON.stringify({ experimental: { enableAgents: false } }),
      '.gemini/agents/helper.md': '---\nname: helper\ndescription: Helps.\n---\n',
    });
    expect(skips(planOf(plans, 'gemini'))).toEqual(['disabled .gemini/agents/helper.md']);
    expect(subagents(planOf(plans, 'gemini'))).toEqual([]);
  });

  it('skips the loser of a name both folders of an agent use', () => {
    const plan = planOf(
      plansOf({
        '.cursor/agents/reviewer.md': '---\nname: reviewer\ndescription: Cursor one.\n---\n',
        '.claude/agents/reviewer.md': reviewer,
      }),
      'cursor',
    );
    expect(subagents(plan)).toEqual(['startup .cursor/agents/reviewer.md']);
    expect(skips(plan)).toEqual(['shadowed-by-preferred .claude/agents/reviewer.md']);
  });

  it('lists a Copilot agent the model does not pick as manual, without a size', () => {
    const plan = planOf(
      plansOf({
        '.github/agents/deploy.agent.md':
          '---\ndescription: Deploys.\ndisable-model-invocation: true\n---\nDeploy.\n',
        '.github/agents/legacy.agent.md': '---\ndescription: Old.\ninfer: false\n---\nOld.\n',
        // Hidden from the agent picker, still picked by the model.
        '.github/agents/helper.agent.md':
          '---\ndescription: Helps.\nuser-invocable: false\n---\nHelp.\n',
        // disable-model-invocation takes precedence over infer.
        '.github/agents/both.agent.md':
          '---\ndescription: Both.\ndisable-model-invocation: false\ninfer: false\n---\nBoth.\n',
      }),
      'copilot-cloud',
    );
    expect(subagents(plan)).toEqual([
      'startup .github/agents/both.agent.md ?',
      'startup .github/agents/helper.agent.md ?',
      'manual .github/agents/deploy.agent.md ?',
      'manual .github/agents/legacy.agent.md ?',
    ]);
    expect(subagent(plan, 'subagent:.github/agents/deploy.agent.md').size).toBeUndefined();
  });
});

describe('subagents and the working directory', () => {
  const files = {
    '.claude/agents/reviewer.md': reviewer,
    'pkg/.claude/agents/reviewer.md':
      '---\nname: reviewer\ndescription: Reviews the package.\n---\nReview it.\n',
    'pkg/.claude/agents/linter.md': '---\nname: linter\ndescription: Lints.\n---\nLint.\n',
    'other/.claude/agents/far.md': '---\nname: far\ndescription: Far away.\n---\nFar.\n',
  };

  it('leaves folders below the working directory to sessions started there', () => {
    const plan = planOf(plansOf(files), 'claude-code');
    expect(subagents(plan)).toEqual(['startup .claude/agents/reviewer.md']);
    expect(plan.outOfScope).toEqual([
      { path: 'other/.claude/agents/far.md', because: 'below-start-dir' },
      { path: 'pkg/.claude/agents/linter.md', because: 'below-start-dir' },
      { path: 'pkg/.claude/agents/reviewer.md', because: 'below-start-dir' },
    ]);
  });

  it('takes the definition closest to the working directory, and leaves other branches out', () => {
    const plan = planOf(plansOf(files, { cwd: 'pkg' }), 'claude-code');
    expect(subagents(plan)).toEqual([
      'startup pkg/.claude/agents/linter.md',
      'startup pkg/.claude/agents/reviewer.md',
    ]);
    expect(skips(plan)).toEqual(['shadowed-by-preferred .claude/agents/reviewer.md']);
    // `other` is not on the way from `pkg` to the root, nor below it.
    expect(plan.outOfScope.some((item) => item.path.startsWith('other/'))).toBe(false);
  });

  it("reads the root's folders where the agent walks up, and the opened folder's only elsewhere", () => {
    const files = {
      '.cursor/agents/root.md': '---\nname: root\ndescription: Root.\n---\n',
      'pkg/.cursor/agents/near.md': '---\nname: near\ndescription: Near.\n---\n',
      '.codex/agents/root.toml':
        'name = "root"\ndescription = "Root."\ndeveloper_instructions = "Root."\n',
      '.github/agents/root.agent.md': '---\ndescription: Root.\n---\nRoot.\n',
      'pkg/.github/agents/near.agent.md': '---\ndescription: Near.\n---\nNear.\n',
      '.gemini/agents/root.md': '---\nname: root\ndescription: Root.\n---\n',
      'pkg/.gemini/agents/near.md': '---\nname: near\ndescription: Near.\n---\n',
    };
    const plans = plansOf(files, { cwd: 'pkg' });
    // Cursor and Gemini CLI read the folder opened, or started in: not the root's.
    expect(subagents(planOf(plans, 'cursor'))).toEqual(['startup pkg/.cursor/agents/near.md ?']);
    expect(subagents(planOf(plans, 'gemini'))).toEqual(['startup pkg/.gemini/agents/near.md ?']);
    expect(
      planOf(plans, 'cursor').outOfScope.some((item) => item.path.startsWith('.cursor/')),
    ).toBe(false);
    // Codex and the Copilot CLI read up to the repository root.
    expect(subagents(planOf(plans, 'codex'))).toEqual(['startup .codex/agents/root.toml ?']);
    expect(subagents(planOf(plans, 'copilot-cli'))).toEqual([
      'startup .github/agents/root.agent.md ?',
      'startup pkg/.github/agents/near.agent.md ?',
    ]);
    // Copilot in VS Code takes the working directory as the workspace.
    expect(subagents(planOf(plans, 'copilot-vscode'))).toEqual([
      'startup pkg/.github/agents/near.agent.md ?',
    ]);
  });

  it("gives the Copilot cloud agent the repository root's agents, wherever it starts", () => {
    const files = {
      '.github/agents/root.agent.md': '---\ndescription: Root.\n---\nRoot.\n',
      'pkg/.github/agents/root.agent.md': '---\ndescription: Nested.\n---\nNested.\n',
    };
    for (const cwd of ['', 'pkg']) {
      const plan = planOf(plansOf(files, { cwd }), 'copilot-cloud');
      expect(subagents(plan), cwd).toEqual(['startup .github/agents/root.agent.md ?']);
      expect(skips(plan), cwd).toEqual([]);
      expect(
        plan.outOfScope.some((item) => item.path.startsWith('pkg/')),
        cwd,
      ).toBe(false);
    }
  });

  it("names documentation in the folders a session reads or leaves to a deeper start, not in another branch's", () => {
    const files = {
      '.claude/agents/README.md': '# Our agents\n',
      'pkg/.claude/agents/README.md': '# Package agents\n',
      'other/.claude/agents/README.md': '# Other agents\n',
    };
    const documentation = (cwd: string): string[] =>
      planOf(plansOf(files, { cwd }), 'claude-code')
        .outOfScope.filter((item) => item.because === 'documentation')
        .map((item) => item.path);
    expect(documentation('')).toEqual([
      '.claude/agents/README.md',
      'other/.claude/agents/README.md',
      'pkg/.claude/agents/README.md',
    ]);
    expect(documentation('pkg')).toEqual([
      '.claude/agents/README.md',
      'pkg/.claude/agents/README.md',
    ]);
  });

  it('lets the Copilot CLI take every .github/agents before any .claude/agents, as documented', () => {
    const plan = planOf(
      plansOf(
        {
          '.github/agents/reviewer.agent.md': '---\ndescription: Root.\n---\nRoot.\n',
          'pkg/.claude/agents/reviewer.md': reviewer,
        },
        { cwd: 'pkg' },
      ),
      'copilot-cli',
    );
    expect(subagents(plan)).toEqual(['startup .github/agents/reviewer.agent.md ?']);
    // The order is documented, so the loser surely does not load.
    expect(plan.skipped.find((skip) => skip.role === 'subagent')).toMatchObject({
      path: 'pkg/.claude/agents/reviewer.md',
      code: 'shadowed-by-preferred',
      certainty: 'documented',
    });
  });

  it('stops at the repository root of the working directory', () => {
    const plan = planOf(
      plansOf(
        {
          '.claude/agents/reviewer.md': reviewer,
          'sub/.claude/agents/inner.md': '---\nname: inner\ndescription: Inner.\n---\n',
        },
        { cwd: 'sub', extras: { paths: ['sub/.git/HEAD'] } },
      ),
      'claude-code',
    );
    expect(subagents(plan)).toEqual(['startup sub/.claude/agents/inner.md']);
  });
});

describe("Claude Code's subagents listing limit", () => {
  it('measures the names and descriptions against 15,000 tokens, and notes when they pass it', () => {
    const files: Record<string, string> = {};
    // 31 agents of about 2,000 characters each: about 15,500 tokens.
    for (let i = 0; i < 31; i++) {
      const name = `agent-${String(i).padStart(2, '0')}`;
      files[`.claude/agents/${name}.md`] =
        `---\nname: ${name}\ndescription: ${'d'.repeat(1992)}\n---\nBody.\n`;
    }
    const plan = planOf(plansOf(files), 'claude-code');
    const usage = plan.limits.find((item) => item.key === 'claude-code.agent_descriptions_tokens');
    expect(usage).toMatchObject({ unit: 'tokens', limit: 15_000, effect: 'advice' });
    expect(usage?.used).toBe(Math.ceil((31 * (8 + 1992)) / 4));
    expect(usage?.used).toBeGreaterThan(15_000);
    // Every subagent still loads.
    expect(subagents(plan)).toHaveLength(31);
  });

  it('is not measured without a listed subagent', () => {
    const plan = planOf(
      plansOf({ '.claude/agents/broken.md': '---\nname: x\n---\n' }),
      'claude-code',
    );
    expect(plan.limits.some((item) => item.key === 'claude-code.agent_descriptions_tokens')).toBe(
      false,
    );
  });
});

describe('what a subagent starts with when it runs', () => {
  const skill = (name: string, extra = ''): string =>
    `---\nname: ${name}\ndescription: ${name} skill.\n${extra}---\n${name} body.\n`;

  it("gives a Claude Code subagent its prompt, the session's startup instructions and its preloaded skills", () => {
    const plan = planOf(
      plansOf({
        'CLAUDE.md': 'Rules.\n@docs/style.md\n',
        'docs/style.md': 'Style.\n',
        '.claude/rules/always.md': 'Always.\n',
        // Loads when Claude opens a matching file: not at startup, so not for the subagent.
        '.claude/rules/tests.md': '---\npaths: "**/*.test.ts"\n---\nTests.\n',
        '.claude/skills/api/SKILL.md': skill('api'),
        '.claude/skills/deploy/SKILL.md': skill('deploy', 'disable-model-invocation: true\n'),
        '.claude/skills/old/SKILL.md': skill('old'),
        '.claude/settings.json': JSON.stringify({ skillOverrides: { old: 'off' } }),
        '.claude/agents/builder.md':
          '---\nname: builder\ndescription: Builds.\nskills:\n  - api\n  - api\n  - deploy\n  - old\n  - personal\nmemory: project\n---\nBuild it.\n',
        '.claude/agent-memory/builder/MEMORY.md': 'Learned.\n',
      }),
      'claude-code',
    );
    const context = subagent(plan, 'subagent:.claude/agents/builder.md').ownContext;
    const instructions = 'Rules.\n@docs/style.md\n'.length + 'Style.\n'.length + 'Always.\n'.length;
    expect(context?.parts).toEqual([
      {
        kind: 'prompt',
        size: { bytes: 10, chars: 10, tokens: 3 },
        certainty: 'documented',
        evidence: ['claudeSubagents'],
      },
      {
        kind: 'instructions',
        size: { bytes: instructions, chars: instructions, tokens: Math.ceil(instructions / 4) },
        certainty: 'documented',
        evidence: ['claudeSubagents', 'claudeMemory'],
      },
      {
        kind: 'skill',
        path: '.claude/skills/api/SKILL.md',
        name: 'api',
        size: { bytes: 10, chars: 10, tokens: 3 },
        certainty: 'documented',
        evidence: ['claudeSubagents', 'claudeSkills'],
      },
      // The memory the `memory` field adds, from the file in the repository.
      {
        kind: 'memory',
        path: '.claude/agent-memory/builder/MEMORY.md',
        size: { bytes: 9, chars: 9, tokens: 3 },
        certainty: 'documented',
        evidence: ['claudeSubagents'],
      },
    ]);
    expect(context?.size.chars).toBe(10 + instructions + 10 + 'Learned.\n'.length);
    // A name twice is preloaded once.
    expect(context?.notLoaded).toEqual([
      { name: 'deploy', reason: 'not-model-invocable' },
      { name: 'old', reason: 'off' },
      { name: 'personal', reason: 'not-found' },
    ]);
    expect(context?.memory).toEqual({
      scope: 'project',
      path: '.claude/agent-memory/builder/MEMORY.md',
      exists: true,
    });
    expect(context?.notVisible).toEqual([
      'environment',
      'task',
      'tools',
      'git-status',
      'user-instructions',
      'managed-instructions',
    ]);
    // A separate window: the session's startup total is its startup entries, without it.
    const startup = plan.entries
      .filter((item) => item.trigger === 'startup')
      .reduce((sum, item) => sum + (item.size?.chars ?? 0), 0);
    expect(plan.totals.startup.chars).toBe(startup);
  });

  it('leaves out the instruction files with omitClaudeMd, and preloads only the first 32 names', () => {
    const files: Record<string, string> = { 'CLAUDE.md': 'Rules.\n' };
    const names = Array.from({ length: 35 }, (_, i) => `s${String(i).padStart(2, '0')}`);
    for (const name of names.slice(0, 33)) files[`.claude/skills/${name}/SKILL.md`] = skill(name);
    files['.claude/agents/lean.md'] =
      `---\nname: lean\ndescription: Lean.\nomitClaudeMd: true\nskills: [${names.join(', ')}]\n---\nLean.\n`;
    const context = subagent(
      planOf(plansOf(files), 'claude-code'),
      'subagent:.claude/agents/lean.md',
    ).ownContext;
    expect(context?.parts.map((part) => part.kind)).toEqual([
      'prompt',
      ...Array.from({ length: 32 }, () => 'skill'),
    ]);
    // Past the first 32, a count: the names do not load, found or not.
    expect(context?.notLoaded).toBeUndefined();
    expect(context?.overLimit).toBe(3);
    // The user's CLAUDE.md is not loaded either; the organization's still is.
    expect(context?.notVisible).not.toContain('user-instructions');
    expect(context?.notVisible).toContain('managed-instructions');
  });

  it("counts the instruction files as unverified when omitClaudeMd is a skill's boolean form", () => {
    const parts = (value: string): unknown =>
      subagent(
        planOf(
          plansOf({
            'CLAUDE.md': 'Rules.\n',
            '.claude/agents/a.md': `---\nname: a\ndescription: A.\nomitClaudeMd: ${value}\n---\nA.\n`,
          }),
          'claude-code',
        ),
        'subagent:.claude/agents/a.md',
      ).ownContext?.parts.map((part) => `${part.kind} ${part.certainty}`);
    expect(parts('true')).toEqual(['prompt documented']);
    // Claude Code reads yes as true in a skill; for omitClaudeMd that is not documented.
    expect(parts('yes')).toEqual(['prompt documented', 'instructions unverified']);
    expect(parts('"TRUE"')).toEqual(['prompt documented', 'instructions unverified']);
    expect(parts('false')).toEqual(['prompt documented', 'instructions documented']);
    expect(parts('no')).toEqual(['prompt documented', 'instructions documented']);
  });

  it("preloads a skill by its directory's name, as unverified", () => {
    const context = subagent(
      planOf(
        plansOf({
          '.claude/skills/deploy-staging/SKILL.md': skill('deploy'),
          '.claude/agents/a.md':
            '---\nname: a\ndescription: A.\nskills: [deploy-staging, deploy]\n---\nA.\n',
        }),
        'claude-code',
      ),
      'subagent:.claude/agents/a.md',
    ).ownContext;
    expect(
      context?.parts
        .filter((part) => part.kind === 'skill')
        .map((part) => `${part.name ?? ''} ${part.path ?? ''} ${part.certainty}`),
    ).toEqual([
      'deploy-staging .claude/skills/deploy-staging/SKILL.md unverified',
      'deploy .claude/skills/deploy-staging/SKILL.md documented',
    ]);
    expect(context?.notLoaded).toBeUndefined();
  });

  it('measures each definition once for every plan of a scan', () => {
    const analysis = analyze(
      snapshotFrom(
        {
          '.codex/agents/a.toml':
            'name = "a"\ndescription = "A."\ndeveloper_instructions = "Do it."\n',
          'pkg/AGENTS.md': 'Package.\n',
        },
        { paths: ['.git/HEAD'] },
      ),
      { targets: PLATFORM_IDS },
    );
    const [root, pkg] = ['', 'pkg'].map((cwd) =>
      planOf(loadPlans(analysis, { agents: ['codex'], cwd, config: analysis.config }), 'codex'),
    );
    const id = 'subagent:.codex/agents/a.toml';
    // The prompt, the part that grows with the file, is the same object in every plan.
    const prompt = (plan: LoadPlan | undefined) =>
      subagent(plan!, id).ownContext?.parts.find((part) => part.kind === 'prompt');
    expect(prompt(pkg)).toBeDefined();
    expect(prompt(pkg)).toBe(prompt(root));
  });

  it('reads a comma-separated skills value as unverified, and ignores one of another type', () => {
    const files = {
      '.claude/skills/api/SKILL.md': skill('api'),
      '.claude/agents/listed.md':
        '---\nname: listed\ndescription: L.\nskills: api, other\n---\nL.\n',
      '.claude/agents/odd.md': '---\nname: odd\ndescription: O.\nskills: 3\n---\nO.\n',
    };
    const plan = planOf(plansOf(files), 'claude-code');
    const listed = subagent(plan, 'subagent:.claude/agents/listed.md').ownContext;
    expect(listed?.parts.find((part) => part.kind === 'skill')).toMatchObject({
      name: 'api',
      certainty: 'unverified',
    });
    expect(listed?.notLoaded).toEqual([{ name: 'other', reason: 'not-found' }]);
    const odd = subagent(plan, 'subagent:.claude/agents/odd.md').ownContext;
    expect(odd?.parts.map((part) => part.kind)).toEqual(['prompt']);
    expect(odd?.notLoaded).toBeUndefined();
  });

  it('names the memory file without reading it, and none when auto memory is off', () => {
    const agent = (memory: string): string =>
      `---\nname: keeper\ndescription: Keeps.\nmemory: ${memory}\n---\nKeep.\n`;
    const memoryOf = (files: Record<string, string>): unknown =>
      subagent(planOf(plansOf(files), 'claude-code'), 'subagent:.claude/agents/keeper.md')
        .ownContext?.memory;
    expect(memoryOf({ '.claude/agents/keeper.md': agent('local') })).toEqual({
      scope: 'local',
      path: '.claude/agent-memory-local/keeper/MEMORY.md',
      exists: false,
    });
    // The user's scope is never read.
    expect(memoryOf({ '.claude/agents/keeper.md': agent('user') })).toEqual({ scope: 'user' });
    expect(
      memoryOf({
        '.claude/agents/keeper.md': agent('project'),
        '.claude/settings.json': JSON.stringify({ autoMemoryEnabled: false }),
      }),
    ).toBeUndefined();
    expect(
      memoryOf({
        '.claude/agents/keeper.md': agent('project'),
        '.claude/settings.local.json': JSON.stringify({
          env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        }),
      }),
    ).toBeUndefined();
    // The variable wins over autoMemoryEnabled in either direction, whichever file sets them.
    expect(
      memoryOf({
        '.claude/agents/keeper.md': agent('project'),
        '.claude/settings.json': JSON.stringify({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } }),
        '.claude/settings.local.json': JSON.stringify({ autoMemoryEnabled: true }),
      }),
    ).toBeUndefined();
    expect(
      memoryOf({
        '.claude/agents/keeper.md': agent('project'),
        '.claude/settings.json': JSON.stringify({
          autoMemoryEnabled: false,
          env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' },
        }),
      }),
    ).toMatchObject({ scope: 'project' });
    // Not a documented scope: no memory.
    expect(memoryOf({ '.claude/agents/keeper.md': agent('team') })).toBeUndefined();
  });

  it('measures the first 200 lines or 25 KB of the memory file, and none it did not read', () => {
    const keeper = '---\nname: keeper\ndescription: Keeps.\nmemory: project\n---\nKeep.\n';
    const call = (memory: string): OwnContext | undefined =>
      subagent(
        planOf(
          plansOf({
            '.claude/agents/keeper.md': keeper,
            '.claude/agent-memory/keeper/MEMORY.md': memory,
          }),
          'claude-code',
        ),
        'subagent:.claude/agents/keeper.md',
      ).ownContext;
    const part = (memory: string) => call(memory)?.parts.find((item) => item.kind === 'memory');
    expect(part('line\n'.repeat(300))?.size.chars).toBe('line\n'.length * 200);
    expect(part(`${'x'.repeat(40_000)}\n`)?.size.bytes).toBe(25 * 1024);
    // Past what the scan reads, the file is named as unmeasured.
    const analysis = analyze(
      {
        ...snapshotFrom({ '.claude/agents/keeper.md': keeper }, { paths: ['.git/HEAD'] }),
        skipped: [
          { path: '.claude/agent-memory/keeper/MEMORY.md', reason: 'too-large', size: 2_000_000 },
        ],
      },
      { targets: PLATFORM_IDS },
    );
    const unread = subagent(
      planOf(
        loadPlans(analysis, { agents: ['claude-code'], cwd: '', config: analysis.config }),
        'claude-code',
      ),
      'subagent:.claude/agents/keeper.md',
    ).ownContext;
    expect(unread?.parts.map((item) => item.kind)).toEqual(['prompt']);
    expect(unread?.unmeasured).toEqual(['.claude/agent-memory/keeper/MEMORY.md']);
  });

  it('names a preloaded skill the scan did not read as unmeasured, not as missing', () => {
    const analysis = analyze(
      {
        ...snapshotFrom(
          {
            '.claude/agents/a.md': '---\nname: a\ndescription: A.\nskills: [huge, gone]\n---\nA.\n',
          },
          { paths: ['.git/HEAD'] },
        ),
        skipped: [{ path: '.claude/skills/huge/SKILL.md', reason: 'too-large', size: 2_000_000 }],
      },
      { targets: PLATFORM_IDS },
    );
    const context = subagent(
      planOf(
        loadPlans(analysis, { agents: ['claude-code'], cwd: '', config: analysis.config }),
        'claude-code',
      ),
      'subagent:.claude/agents/a.md',
    ).ownContext;
    expect(context?.unmeasured).toEqual(['.claude/skills/huge/SKILL.md']);
    expect(context?.notLoaded).toEqual([{ name: 'gone', reason: 'not-found' }]);
  });

  it('measures the call of a definition that may load instead of the preferred one', () => {
    const plan = planOf(
      plansOf({
        '.claude/agents/a.md': '---\nname: reviewer\ndescription: Small.\n---\nSmall.\n',
        '.claude/agents/b.md': `---\nname: reviewer\ndescription: Big.\n---\n${'big '.repeat(500)}\n`,
      }),
      'claude-code',
    );
    const skip = plan.skipped.find((item) => item.path === '.claude/agents/b.md');
    // Which of two files in one folder loads is not documented: either may run.
    expect(skip).toMatchObject({ code: 'shadowed-by-preferred', certainty: 'unverified' });
    expect(skip?.ownContext?.size.chars).toBeGreaterThan(2000);
  });

  it("gives a Copilot CLI agent the repository's instructions only with include-custom-instructions", () => {
    const files = {
      'AGENTS.md': 'Use pnpm.\n',
      '.github/agents/with.agent.md':
        '---\ndescription: With.\ninclude-custom-instructions: true\n---\nWith.\n',
      '.github/agents/without.agent.md': '---\ndescription: Without.\n---\nWithout.\n',
    };
    const plans = plansOf(files);
    const cli = planOf(plans, 'copilot-cli');
    const parts = (id: string) =>
      subagent(cli, id).ownContext?.parts.map((part) => `${part.kind} ${part.certainty}`);
    expect(parts('subagent:.github/agents/with.agent.md')).toEqual([
      'prompt documented',
      'instructions documented',
    ]);
    expect(parts('subagent:.github/agents/without.agent.md')).toEqual(['prompt documented']);
    // Documented either way on the CLI; VS Code does not say.
    expect(
      subagent(cli, 'subagent:.github/agents/without.agent.md').ownContext?.notVisible,
    ).not.toContain('instructions');
    expect(
      subagent(planOf(plans, 'copilot-vscode'), 'subagent:.github/agents/without.agent.md')
        .ownContext?.notVisible,
    ).toContain('instructions');
  });

  it('gives a Codex agent its skills instructions block unless the file turns it off', () => {
    const agent = (name: string, extra = ''): string =>
      `name = "${name}"\ndescription = "d"\ndeveloper_instructions = "Do it."\n${extra}`;
    const plan = planOf(
      plansOf({
        '.agents/skills/api/SKILL.md': '---\nname: api\ndescription: API rules.\n---\nBody.\n',
        '.codex/agents/plain.toml': agent('plain'),
        '.codex/agents/off.toml': agent('off', '[skills]\ninclude_instructions = false\n'),
        '.codex/agents/some.toml': agent(
          'some',
          '[[skills.config]]\npath = "x"\nenabled = false\n',
        ),
      }),
      'codex',
    );
    const parts = (name: string) =>
      subagent(plan, `subagent:.codex/agents/${name}.toml`).ownContext?.parts.map(
        (part) => `${part.kind} ${part.certainty}`,
      );
    expect(parts('plain')).toEqual(['prompt documented', 'listing documented']);
    expect(parts('off')).toEqual(['prompt documented']);
    expect(parts('some')).toEqual(['prompt documented', 'listing unverified']);
  });

  it('names no memory path for a name that is not one folder name', () => {
    for (const name of ['../../../tmp/x', 'a/b', '..']) {
      const plan = planOf(
        plansOf({
          '.claude/agents/keeper.md': `---\nname: "${name}"\ndescription: Keeps.\nmemory: project\n---\nKeep.\n`,
        }),
        'claude-code',
      );
      expect(subagent(plan, 'subagent:.claude/agents/keeper.md').ownContext?.memory, name).toEqual({
        scope: 'project',
      });
    }
  });

  it("gives another agent's subagent its prompt only, and none for a Codex role without a file", () => {
    const plans = plansOf({
      '.cursor/agents/planner.md': '---\nname: planner\ndescription: Plans.\n---\nPlan.\n',
      '.codex/config.toml': '[agents.reviewer]\ndescription = "Reviews."\n',
    });
    expect(
      subagent(planOf(plans, 'cursor'), 'subagent:.cursor/agents/planner.md').ownContext,
    ).toEqual({
      size: { bytes: 6, chars: 6, tokens: 2 },
      parts: [
        {
          kind: 'prompt',
          size: { bytes: 6, chars: 6, tokens: 2 },
          certainty: 'documented',
          evidence: ['cursorSubagents'],
        },
      ],
      notVisible: ['environment', 'task', 'tools', 'instructions'],
    });
    expect(
      subagent(planOf(plans, 'codex'), 'subagent:.codex/config.toml#reviewer').ownContext,
    ).toEqual({
      size: { bytes: 0, chars: 0, tokens: 0 },
      parts: [],
      notVisible: ['prompt', 'environment', 'task', 'tools', 'instructions'],
    });
  });
});
