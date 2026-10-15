/**
 * Golden reports: the complete JSON report of two fixture repositories, compared byte for byte
 * with committed snapshots. They pin every finding, artifact, score and rule metadata field, so a
 * refactor of the engine, the loading helpers or the rules that changes any output fails here.
 *
 * Each fixture is scanned the way `agentcheckup <dir> --untrusted --format json` scans it: the
 * real walker, every built-in rule, every platform targeted, no configuration file and no inline
 * suppressions. Paths stay relative to the fixture, so the report does not depend on where the
 * repository is checked out. After an intended output change, regenerate the snapshots with
 * `pnpm vitest run test/core/golden.test.ts -u` and review the diff.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanSnapshot } from '../../src/core/engine.js';
import { PLATFORM_IDS, type Snapshot } from '../../src/core/types.js';
import { walk } from '../../src/io/walk.js';
import { formatJson } from '../../src/report/json.js';
import { builtinRules } from '../../src/rules/index.js';

/**
 * Stands in for the package version, which release-please bumps on every release. Everything
 * else in the report is compared as the CLI prints it.
 */
const PINNED_VERSION = '0.0.0-golden';

interface GoldenCase {
  /** Directory under test/fixtures. */
  readonly fixture: string;
  /**
   * Scan it as a git checkout. git cannot store a `.git` entry inside the fixture, so the walker's
   * result for one (an unlisted `.git/` directory) is added here. Rules use it as the project
   * root marker, for example for Codex's AGENTS.md chain.
   */
  readonly gitRoot: boolean;
}

const CASES: readonly GoldenCase[] = [
  { fixture: 'context', gitRoot: true },
  { fixture: 'smoke', gitRoot: false },
];

function asCheckout(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    paths: new Set([...snapshot.paths, '.git/']),
    opaqueDirectories: new Set([...snapshot.opaqueDirectories, '.git/']),
  };
}

async function goldenReport({ fixture, gitRoot }: GoldenCase): Promise<string> {
  const root = fileURLToPath(new URL(`../fixtures/${fixture}`, import.meta.url));
  // As `--untrusted` walks: a .gitignore in the fixture could not hide agent configuration.
  const walked = await walk(root, { scanIgnoredAgentConfig: true });
  const result = scanSnapshot(gitRoot ? asCheckout(walked) : walked, {
    rules: builtinRules,
    targets: PLATFORM_IDS,
    trustDirectives: false,
  });
  expect(result.ruleFailures).toEqual([]);
  return formatJson({ ...result, tool: { ...result.tool, version: PINNED_VERSION } });
}

describe('golden reports', () => {
  it.each(CASES)('$fixture matches its committed JSON report', async (golden) => {
    await expect(await goldenReport(golden)).toMatchFileSnapshot(
      `__snapshots__/golden.${golden.fixture}.txt`,
    );
  });

  it('the context fixture crosses the Codex budget in one subtree', async () => {
    // Guards the fixture itself, and the root marker: without one, Codex reads only the working
    // directory's file and no single AGENTS.md here comes near the budget.
    const report = JSON.parse(await goldenReport(CASES[0]!)) as {
      findings: { ruleId: string; severity: string; path: string }[];
    };
    expect(
      report.findings
        .filter((finding) => finding.ruleId === 'instr/codex-size-budget')
        .map(({ severity, path }) => `${severity} ${path}`),
    ).toEqual(['warn services/billing/AGENTS.md', 'error services/billing/ledger/AGENTS.md']);
  });
});
