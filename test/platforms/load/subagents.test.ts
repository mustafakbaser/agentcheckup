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
} from '../../../src/platforms/load/types.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

interface Options {
  readonly cwd?: string;
  readonly extras?: SnapshotExtras;
}

function plansOf(files: FileMap, options: Options = {}): LoadPlan[] {
  const extras = options.extras ?? {};
  const analysis = analyze(
    snapshotFrom(files, { ...extras, paths: ['.git/HEAD', ...(extras.paths ?? [])] }),
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
