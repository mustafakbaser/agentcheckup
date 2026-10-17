import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withVersion } from '../../src/cli/skill.js';
import { scanWithContext } from '../../src/core/engine.js';
import { PLATFORM_IDS } from '../../src/core/types.js';
import { walk } from '../../src/io/walk.js';
import { CONTEXT_AGENTS } from '../../src/platforms/load/types.js';
import { builtinRules } from '../../src/rules/index.js';
import { skillBytes } from './helpers.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A repository with an AGENTS.md and the skill's files in `directory`, edited by `edit`. */
async function repoWithSkill(
  directory: string,
  edit: (path: string, text: string) => string = (_path, text) => text,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentcheckup-skill-'));
  created.push(root);
  await writeFile(join(root, 'AGENTS.md'), '# Project\n\nRun `pnpm test` before you commit.\n');
  const decoder = new TextDecoder();
  for (const [path, bytes] of await skillBytes()) {
    const file = join(root, ...directory.split('/'), ...path.split('/'));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, edit(path, decoder.decode(bytes)));
  }
  return root;
}

/** Findings and load-plan skips of a scan from disk, with every rule on every target. */
async function scanned(root: string): Promise<string[]> {
  const snapshot = await walk(root, { respectGitignore: true });
  const result = scanWithContext(snapshot, {
    rules: builtinRules,
    targets: PLATFORM_IDS,
    agents: CONTEXT_AGENTS,
    matrix: true,
  });
  expect(result.ruleFailures).toEqual([]);
  const findings = result.findings.map(
    (finding) => `${finding.ruleId} ${finding.path}:${finding.range.start.line} ${finding.message}`,
  );
  const skips = result.context.plans.flatMap((plan) =>
    plan.skipped
      .filter((skip) => skip.path.includes('agentcheckup'))
      .map((skip) => `${plan.agent} skips ${skip.path}: ${skip.code}`),
  );
  return [...findings, ...skips];
}

const PLACEMENTS = [
  '.claude/skills/agentcheckup',
  '.agents/skills/agentcheckup',
  'skills/agentcheckup',
];

describe('the agentcheckup skill scanned by agentcheckup', () => {
  for (const placement of PLACEMENTS) {
    it(`has no findings in ${placement}`, async () => {
      expect(await scanned(await repoWithSkill(placement))).toEqual([]);
    });

    it(`has no findings in ${placement} with another version pinned`, async () => {
      const root = await repoWithSkill(placement, (_path, text) =>
        withVersion(text, '12.3.4-rc.1'),
      );
      expect(await scanned(root)).toEqual([]);
    });
  }

  it('is read: a broken copy has findings', async () => {
    const root = await repoWithSkill('.claude/skills/agentcheckup', (path, text) =>
      path === 'SKILL.md'
        ? text.replace('license: MIT\n', 'license: MIT\nwhen: always\n').replace('Read\n', 'Bash\n')
        : text,
    );
    const found = await scanned(root);
    expect(found.some((line) => line.startsWith('skill/broad-allowed-tools '))).toBe(true);
  });

  it('is read in every placement: a missing reference is reported', async () => {
    for (const placement of PLACEMENTS) {
      const root = await repoWithSkill(placement, (path, text) =>
        path === 'SKILL.md'
          ? text.replace('](references/tasks.md)', '](references/task.md)')
          : text,
      );
      const found = await scanned(root);
      expect(
        found.some((line) => line.startsWith('skill/broken-reference ')),
        placement,
      ).toBe(true);
    }
  });
});
