import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EMPTY_CONFIG, resolveConfig, type ResolvedConfig } from '../../../src/core/config.js';
import { type Analysis, analyze, type RuleResult, runRules } from '../../../src/core/engine.js';
import { hash53 } from '../../../src/core/fingerprint.js';
import { PLATFORM_IDS, type Snapshot } from '../../../src/core/types.js';
import { walk } from '../../../src/io/walk.js';
import { loadCodex } from '../../../src/platforms/load/codex.js';
import type { LoadPlan, SkipCode } from '../../../src/platforms/load/types.js';
import { builtinRules } from '../../../src/rules/index.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

interface PlanOptions {
  readonly extras?: SnapshotExtras;
  readonly config?: unknown;
  readonly contextWindow?: number;
  /** Add a `.git` entry at the scan root, the project root marker. Default true. */
  readonly git?: boolean;
}

interface Scan {
  readonly plan: LoadPlan;
  readonly result: RuleResult;
  readonly analysis: Analysis;
}

function configOf(options: PlanOptions): ResolvedConfig {
  return options.config === undefined ? EMPTY_CONFIG : resolveConfig(options.config);
}

function snapshotOf(files: FileMap, options: PlanOptions = {}): Snapshot {
  const extras = options.extras ?? {};
  return snapshotFrom(files, {
    ...extras,
    paths: [...(options.git === false ? [] : ['.git/HEAD']), ...(extras.paths ?? [])],
  });
}

/** Runs every rule, then the loader over the same analysis, as the engine does. */
function scanAt(snapshot: Snapshot, cwd: string, options: PlanOptions = {}): Scan {
  const config = configOf(options);
  const analysis = analyze(snapshot, { config, targets: PLATFORM_IDS });
  const result = runRules(analysis, { rules: builtinRules, trustDirectives: false });
  expect(result.ruleFailures).toEqual([]);
  const plan = loadCodex(analysis, {
    cwd,
    config,
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
  });
  return { plan, result, analysis };
}

function scan(files: FileMap, cwd = '', options: PlanOptions = {}): Scan {
  return scanAt(snapshotOf(files, options), cwd, options);
}

/** The loader alone, for inputs too large to run every rule on quickly. */
function planOnly(snapshot: Snapshot, cwd = '', options: PlanOptions = {}): LoadPlan {
  const config = configOf(options);
  return loadCodex(analyze(snapshot, { config }), { cwd, config });
}

const startupPaths = (plan: LoadPlan): string[] =>
  plan.entries.filter((entry) => entry.trigger === 'startup').map((entry) => entry.path);

const skips = (plan: LoadPlan): string[] =>
  plan.skipped.map(
    (skip) => `${skip.path} ${skip.code}${skip.ruleId === undefined ? '' : ` ${skip.ruleId}`}`,
  );

const entry = (plan: LoadPlan, id: string) => plan.entries.find((candidate) => candidate.id === id);

const limit = (plan: LoadPlan, key: string, subject?: string) =>
  plan.limits.find(
    (usage) => usage.key === key && (subject === undefined || usage.subject === subject),
  );

/**
 * Skips whose finding sits on the file that hides them, which lists them as related: the override
 * for a shadowed AGENTS.md, the cut file for a dropped one.
 */
const FINDING_ON_HIDING_FILE: ReadonlySet<SkipCode> = new Set([
  'shadowed-by-override',
  'over-byte-budget',
]);

/** Every skip with a rule id has an active finding of that rule, for Codex, on that path. */
function expectFindingsForSkips({ plan, result, analysis }: Scan): void {
  for (const skip of plan.skipped) {
    if (skip.ruleId === undefined) {
      expect(skip.code).toBe('not-read');
      continue;
    }
    const path = analysis.index.get(skip.path)?.path ?? skip.path;
    const found = result.findings.some(
      (finding) =>
        finding.suppressed === undefined &&
        finding.ruleId === skip.ruleId &&
        finding.platforms.includes('codex') &&
        (finding.path === path ||
          (FINDING_ON_HIDING_FILE.has(skip.code) &&
            finding.related.some((related) => related.path === path))),
    );
    expect(found, `${skip.ruleId ?? ''} finding for ${skip.code} ${skip.path}`).toBe(true);
  }
}

const SKILL = (name: string, description = `Does ${name}. Use when asked.`): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps for ${name}.\n`;

describe('loadCodex: instructions', () => {
  it('reads one file per directory from the Git root down to the working directory', () => {
    const scanned = scan(
      {
        'AGENTS.md': 'Root rules.\n',
        'a/b/AGENTS.md': 'Package rules.\n',
        'a/b/c/AGENTS.md': 'Below the start.\n',
        'other/AGENTS.md': 'Beside it.\n',
      },
      'a/b',
    );
    const { plan } = scanned;
    expect(plan.entries.map(({ id, trigger, position }) => [id, trigger, position])).toEqual([
      ['instructions:AGENTS.md', 'startup', 1],
      ['instructions:a/b/AGENTS.md', 'startup', 2],
    ]);
    expect(entry(plan, 'instructions:AGENTS.md')).toMatchObject({
      role: 'instructions',
      realPath: 'AGENTS.md',
      size: { bytes: 12, chars: 12, tokens: 3 },
      certainty: 'documented',
    });
    expect(plan.outOfScope).toEqual([{ path: 'a/b/c/AGENTS.md', because: 'below-start-dir' }]);
    expect(plan.skipped).toEqual([]);
    expect(plan.totals.startup).toEqual({ bytes: 27, chars: 27, tokens: 7 });
    expect(limit(plan, 'codex.project_doc_max_bytes')).toMatchObject({
      limit: 32_768,
      used: 27,
      unit: 'bytes',
      effect: 'truncates',
    });
  });

  it('reads only the working directory without a root marker', () => {
    const { plan } = scan(
      { 'AGENTS.md': 'Root rules.\n', 'a/AGENTS.md': 'Package rules.\n' },
      'a',
      { git: false },
    );
    expect(startupPaths(plan)).toEqual(['a/AGENTS.md']);
    expect(plan.skipped).toEqual([]);
  });

  it('prefers AGENTS.override.md and skips the AGENTS.md it hides', () => {
    const scanned = scan({
      'AGENTS.override.md': 'Override.\n',
      'AGENTS.md': 'Hidden.\n',
    });
    expect(startupPaths(scanned.plan)).toEqual(['AGENTS.override.md']);
    expect(skips(scanned.plan)).toEqual([
      'AGENTS.md shadowed-by-override instr/override-shadows-agents-md',
    ]);
    expectFindingsForSkips(scanned);
  });

  it('skips an empty override, which still hides the AGENTS.md next to it', () => {
    const scanned = scan(
      {
        'AGENTS.md': 'Root.\n',
        'pkg/AGENTS.override.md': ' \n\t\n',
        'pkg/AGENTS.md': 'Hidden.\n',
      },
      'pkg',
    );
    expect(startupPaths(scanned.plan)).toEqual(['AGENTS.md']);
    expect(skips(scanned.plan)).toEqual([
      'pkg/AGENTS.md shadowed-by-override instr/override-shadows-agents-md',
      'pkg/AGENTS.override.md empty-override instr/override-shadows-agents-md',
    ]);
    expectFindingsForSkips(scanned);
  });

  it('skips blank files without using the budget', () => {
    const scanned = scan(
      { 'AGENTS.md': '\n  \n', 'a/AGENTS.override.md': '', 'a/b/AGENTS.md': 'Rules.\n' },
      'a/b',
    );
    expect(startupPaths(scanned.plan)).toEqual(['a/b/AGENTS.md']);
    expect(skips(scanned.plan)).toEqual([
      'AGENTS.md blank-file instr/empty-file',
      'a/AGENTS.override.md blank-file instr/empty-file',
    ]);
    expect(limit(scanned.plan, 'codex.project_doc_max_bytes')?.used).toBe(7);
    expectFindingsForSkips(scanned);
  });

  it('cuts the file that crosses project_doc_max_bytes and drops the rest', () => {
    const scanned = scan(
      {
        'AGENTS.md': 'a'.repeat(60) + '\n',
        'x/AGENTS.md': 'line one\nline two\nline three\n',
        'x/y/AGENTS.md': 'Dropped.\n',
        'x/y/z/AGENTS.md': 'Also dropped.\n',
      },
      'x/y/z',
      { config: { rules: { 'instr/codex-size-budget': ['error', { maxBytes: 75 }] } } },
    );
    const { plan } = scanned;
    expect(startupPaths(plan)).toEqual(['AGENTS.md', 'x/AGENTS.md']);
    // 61 bytes read in full leave 14: "line one\nline".
    expect(entry(plan, 'instructions:x/AGENTS.md')).toMatchObject({
      size: { bytes: 29, chars: 14, tokens: 4 },
      truncated: { atByte: 14, line: 2 },
    });
    expect(skips(plan)).toEqual([
      'x/y/AGENTS.md over-byte-budget instr/codex-size-budget',
      'x/y/z/AGENTS.md over-byte-budget instr/codex-size-budget',
    ]);
    expect(limit(plan, 'codex.project_doc_max_bytes')).toMatchObject({ limit: 75, used: 113 });
    expect(plan.assumptions.find((a) => a.key === 'codex.project_doc_max_bytes')).toMatchObject({
      value: 75,
      origin: 'rule-option',
    });
    expect(plan.totals.startup.chars).toBe(61 + 14);
    expectFindingsForSkips(scanned);
  });

  it('skips a file the budget reaches at its first byte', () => {
    const scanned = scan(
      { 'AGENTS.md': 'a'.repeat(9) + '\n', 'x/AGENTS.md': 'Nothing left.\n' },
      'x',
      { config: { rules: { 'instr/codex-size-budget': ['error', { maxBytes: 10 }] } } },
    );
    expect(startupPaths(scanned.plan)).toEqual(['AGENTS.md']);
    expect(skips(scanned.plan)).toEqual(['x/AGENTS.md over-byte-budget instr/codex-size-budget']);
    expectFindingsForSkips(scanned);
  });

  it('skips a cut that keeps only whitespace, and the budget carries over', () => {
    const scanned = scan(
      {
        'AGENTS.md': 'a'.repeat(9) + '\n',
        'x/AGENTS.md': '\n\n\nLate text.\n',
        'x/y/AGENTS.md': 'Hi\n',
      },
      'x/y',
      { config: { rules: { 'instr/codex-size-budget': ['error', { maxBytes: 13 }] } } },
    );
    expect(startupPaths(scanned.plan)).toEqual(['AGENTS.md', 'x/y/AGENTS.md']);
    expect(skips(scanned.plan)).toEqual(['x/AGENTS.md over-byte-budget instr/codex-size-budget']);
    expectFindingsForSkips(scanned);
  });

  it('counts what Codex receives: a byte order mark stays, a cut character is replaced', () => {
    const bom = scan({ 'AGENTS.md': '\uFEFFRules.\n' }).plan;
    expect(entry(bom, 'instructions:AGENTS.md')?.size).toEqual({ bytes: 10, chars: 8, tokens: 2 });

    // "é" is two bytes; the budget ends between them.
    const cut = scan({ 'AGENTS.md': 'abcé\n' }, '', {
      config: { rules: { 'instr/codex-size-budget': ['error', { maxBytes: 4 }] } },
    }).plan;
    expect(entry(cut, 'instructions:AGENTS.md')).toMatchObject({
      size: { bytes: 6, chars: 4, tokens: 1 },
      truncated: { atByte: 4, line: 1 },
    });
  });

  it('stops the chain at a candidate that exists but was not read', () => {
    const { plan } = scan({ 'AGENTS.md': 'Root.\n', 'a/b/AGENTS.md': 'Deeper.\n' }, 'a/b', {
      extras: { ignoredFiles: ['a/AGENTS.override.md'] },
    });
    expect(startupPaths(plan)).toEqual(['AGENTS.md']);
    expect(plan.incomplete).toEqual(['unread:a/AGENTS.override.md']);
  });

  it('skips an instruction file whose name matches only case-insensitively', () => {
    const scanned = scan({ 'AGENTS.md': 'Root.\n', 'pkg/Agents.md': 'Wrong case.\n' }, 'pkg');
    expect(startupPaths(scanned.plan)).toEqual(['AGENTS.md']);
    expect(skips(scanned.plan)).toEqual(['pkg/Agents.md case-mismatch instr/filename-case']);
    expectFindingsForSkips(scanned);
  });

  it('rejects an invalid maxBytes option the way the rule does', () => {
    const config = { rules: { 'instr/codex-size-budget': ['error', { maxBytes: 0 }] } };
    const message = 'Option "maxBytes" must be a positive integer, got 0.';
    const snapshot = snapshotOf({ 'AGENTS.md': 'Root.\n' });
    const analysis = analyze(snapshot, { config: resolveConfig(config) });
    expect(runRules(analysis, { rules: builtinRules }).ruleFailures).toEqual([
      { ruleId: 'instr/codex-size-budget', message },
    ]);
    expect(() => planOnly(snapshot, '', { config })).toThrow(message);
  });

  it('rejects a working directory that is not a normalized relative path', () => {
    const analysis = analyze(snapshotOf({ 'AGENTS.md': 'x\n' }));
    for (const cwd of ['../x', 'a/', 'a/../b', '/a']) {
      expect(() => loadCodex(analysis, { cwd, config: EMPTY_CONFIG })).toThrow(
        'Working directory must be a normalized relative path',
      );
    }
    expect(() => loadCodex(analysis, { cwd: '', config: EMPTY_CONFIG, contextWindow: 0 })).toThrow(
      'Context window must be a positive integer',
    );
  });
});

describe('loadCodex: skills', () => {
  it('lists .agents/skills from the working directory up to the root, at any depth', () => {
    const scanned = scan(
      {
        'AGENTS.md': 'Root.\n',
        '.agents/skills/deploy/SKILL.md': SKILL('deploy'),
        '.agents/skills/group/nested/SKILL.md': SKILL('nested-skill'),
        'apps/web/.agents/skills/storybook/SKILL.md': SKILL('storybook'),
        'apps/web/src/.agents/skills/below/SKILL.md': SKILL('below'),
        'apps/api/.agents/skills/beside/SKILL.md': SKILL('beside'),
        '.claude/skills/claude-only/SKILL.md': SKILL('claude-only'),
      },
      'apps/web',
    );
    const { plan } = scanned;
    expect(plan.entries.map(({ id, position, name }) => [id, position, name])).toEqual([
      ['instructions:AGENTS.md', 1, undefined],
      ['skill:.agents/skills/deploy/SKILL.md', 2, 'deploy'],
      ['skill:.agents/skills/group/nested/SKILL.md', 3, 'nested-skill'],
      ['skill:apps/web/.agents/skills/storybook/SKILL.md', 4, 'storybook'],
    ]);
    const listing = '- deploy: Does deploy. Use when asked. (file: .agents/skills/deploy/SKILL.md)';
    expect(entry(plan, 'skill:.agents/skills/deploy/SKILL.md')).toMatchObject({
      trigger: 'startup',
      size: { bytes: listing.length, chars: listing.length, tokens: Math.ceil(listing.length / 4) },
      deferred: { bytes: SKILL('deploy').length, chars: SKILL('deploy').length },
      certainty: 'documented',
    });
    expect(plan.outOfScope).toEqual([
      { path: 'apps/web/src/.agents/skills/below/SKILL.md', because: 'below-start-dir' },
    ]);
    expect(plan.skipped).toEqual([]);
    expect(limit(plan, 'codex.skills_listing')).toMatchObject({
      unit: 'chars',
      limit: 8000,
      effect: 'shortens',
    });
    expect(limit(plan, 'codex.skills_scan_depth', '.agents/skills')).toMatchObject({
      unit: 'levels',
      limit: 6,
      used: 2,
    });
    expect(limit(plan, 'codex.skills_scan_directories', '.agents/skills')).toMatchObject({
      unit: 'directories',
      limit: 2000,
      // The root, deploy, group and group/nested.
      used: 4,
    });
    expect(plan.totals.onDemand.bytes).toBe(
      SKILL('deploy').length + SKILL('nested-skill').length + SKILL('storybook').length,
    );
  });

  it('names a skill after its directory when `name` is missing, and collapses whitespace', () => {
    const { plan } = scan({
      '.agents/skills/fallback/SKILL.md': '---\ndescription: "Two\n  lines."\n---\n',
    });
    expect(entry(plan, 'skill:.agents/skills/fallback/SKILL.md')?.name).toBe('fallback');
    expect(entry(plan, 'skill:.agents/skills/fallback/SKILL.md')?.size?.chars).toBe(
      '- fallback: Two lines. (file: .agents/skills/fallback/SKILL.md)'.length,
    );
  });

  it('skips skills Codex cannot read, each reported by the rule that decides it', () => {
    const scanned = scan({
      '.agents/skills/plain/SKILL.md': '# Plain\n\nNo frontmatter.\n',
      '.agents/skills/empty/SKILL.md': '',
      '.agents/skills/unclosed/SKILL.md': '---\nname: unclosed\ndescription: x\n',
      '.agents/skills/late/SKILL.md': '\n---\nname: late\ndescription: x\n---\n',
      '.agents/skills/bom/SKILL.md': `\uFEFF${SKILL('bom')}`,
      '.agents/skills/toml/SKILL.md': '+++\nname = "toml"\n+++\n',
      '.agents/skills/quote/SKILL.md': '---\nname: quote\ndescription: "Deploys\n---\n',
      '.agents/skills/list/SKILL.md': '---\n- name\n- description\n---\n',
      '.agents/skills/twice/SKILL.md':
        '---\nname: twice\ndescription: One.\ndescription: Two.\n---\n',
      '.agents/skills/nodesc/SKILL.md': '---\nname: nodesc\n---\n# Heading\n',
      '.agents/skills/blankdesc/SKILL.md': '---\nname: blankdesc\ndescription: "  "\n---\n',
      '.agents/skills/listdesc/SKILL.md': '---\nname: listdesc\ndescription:\n  - a\n---\n',
      '.agents/skills/meta/SKILL.md': '---\nname: meta\ndescription: x\nmetadata: v1\n---\n',
      '.agents/skills/longname/SKILL.md': `---\nname: ${'n'.repeat(65)}\ndescription: x\n---\n`,
      '.agents/skills/mapname/SKILL.md': '---\nname:\n  a: b\ndescription: x\n---\n',
    });
    expect(scanned.plan.entries).toEqual([]);
    expect(skips(scanned.plan)).toEqual([
      '.agents/skills/blankdesc/SKILL.md no-description skill/description-missing',
      '.agents/skills/bom/SKILL.md bom skill/frontmatter-bom',
      '.agents/skills/empty/SKILL.md no-frontmatter skill/frontmatter-missing',
      '.agents/skills/late/SKILL.md no-frontmatter skill/frontmatter-missing',
      '.agents/skills/list/SKILL.md invalid-frontmatter skill/frontmatter-invalid',
      '.agents/skills/listdesc/SKILL.md no-description skill/description-missing',
      '.agents/skills/longname/SKILL.md invalid-frontmatter skill/name-format',
      '.agents/skills/mapname/SKILL.md invalid-frontmatter skill/name-format',
      '.agents/skills/meta/SKILL.md invalid-frontmatter skill/field-type',
      '.agents/skills/nodesc/SKILL.md no-description skill/description-missing',
      '.agents/skills/plain/SKILL.md no-frontmatter skill/frontmatter-missing',
      '.agents/skills/quote/SKILL.md invalid-frontmatter skill/frontmatter-invalid',
      '.agents/skills/toml/SKILL.md invalid-frontmatter skill/frontmatter-invalid',
      '.agents/skills/twice/SKILL.md invalid-frontmatter skill/frontmatter-invalid',
      '.agents/skills/unclosed/SKILL.md no-frontmatter skill/frontmatter-missing',
    ]);
    expect(new Set(scanned.plan.skipped.map((skip) => skip.certainty))).toEqual(
      new Set(['documented', 'source-code']),
    );
    expectFindingsForSkips(scanned);
  });

  it('lists a skill after the one YAML repair Codex attempts', () => {
    const { plan } = scan({
      '.agents/skills/repair/SKILL.md':
        '---\nname: repair\ndescription: Deploys: production\n---\n',
    });
    expect(plan.skipped).toEqual([]);
    expect(entry(plan, 'skill:.agents/skills/repair/SKILL.md')).toMatchObject({
      name: 'repair',
      certainty: 'source-code',
      size: {
        chars: '- repair: Deploys: production (file: .agents/skills/repair/SKILL.md)'.length,
      },
    });
  });

  it('marks skills whose fields no rule can check as unverified', () => {
    const { plan } = scan({
      // Codex trims lines, so it finds this block; agentcheckup's parser does not.
      '.agents/skills/indented/SKILL.md': '  ---\nname: indented\ndescription: x\n---\n',
      // A repeated key Codex does not read.
      '.agents/skills/tags/SKILL.md': '---\nname: tags\ndescription: One.\ntags: a\ntags: b\n---\n',
      // The repair parses, but leaves no description.
      '.agents/skills/repaired/SKILL.md': '---\nname: Deploys: x\n---\n',
    });
    expect(plan.skipped).toEqual([]);
    expect(plan.entries.map(({ name, certainty }) => [name, certainty])).toEqual([
      ['indented', 'unverified'],
      ['Deploys: x', 'unverified'],
      ['tags', 'unverified'],
    ]);
  });

  it('reports frontmatter beyond the parser limits as not analyzed', () => {
    const { plan } = scan({
      '.agents/skills/huge/SKILL.md': `---\nname: huge\ndescription: ${'x'.repeat(70_000)}\n---\n`,
    });
    expect(plan.entries).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.incomplete).toEqual(['unparsed:.agents/skills/huge/SKILL.md']);
  });

  it('does not read a case variant of SKILL.md, which no rule reports for Codex', () => {
    const scanned = scan({ '.agents/skills/lower/skill.md': SKILL('lower') });
    expect(scanned.plan.entries).toEqual([]);
    expect(skips(scanned.plan)).toEqual(['.agents/skills/lower/skill.md not-read']);
    expect(scanned.plan.skipped[0]?.ruleId).toBeUndefined();
  });

  it('leaves bundled skills and payload folders out, as the rules do', () => {
    const { plan } = scan({
      '.agents/skills/outer/SKILL.md': SKILL('outer'),
      '.agents/skills/outer/assets/inner/SKILL.md': '# no frontmatter\n',
      '.agents/skills/templates/starter/SKILL.md': '# no frontmatter\n',
    });
    expect(startupPaths(plan)).toEqual(['.agents/skills/outer/SKILL.md']);
    expect(plan.skipped).toEqual([]);
    expect(plan.outOfScope).toEqual([
      { path: '.agents/skills/outer/assets/inner/SKILL.md', because: 'payload-folder' },
      { path: '.agents/skills/templates/starter/SKILL.md', because: 'payload-folder' },
    ]);
  });

  it('stops at six directory levels below a skills root', () => {
    const { plan } = scan({
      '.agents/skills/a/b/c/d/e/six/SKILL.md': SKILL('six'),
      '.agents/skills/g/h/i/j/k/l/seven/SKILL.md': SKILL('seven'),
    });
    expect(startupPaths(plan)).toEqual(['.agents/skills/a/b/c/d/e/six/SKILL.md']);
    expect(plan.skipped).toEqual([
      expect.objectContaining({
        path: '.agents/skills/g/h/i/j/k/l/seven/SKILL.md',
        code: 'not-read',
        certainty: 'unverified',
      }),
    ]);
    expect(limit(plan, 'codex.skills_scan_depth')?.used).toBe(7);
  });

  it('lists .codex/skills of the chain as unverified', () => {
    const { plan } = scan({ '.codex/skills/local/SKILL.md': SKILL('local') });
    expect(entry(plan, 'skill:.codex/skills/local/SKILL.md')).toMatchObject({
      certainty: 'unverified',
      evidence: ['codexSkillDiscovery', 'codexSkillRoots', 'codexSkills'],
    });
  });

  it('sizes the listing limit from the context window when one is given', () => {
    const { plan } = scan({ '.agents/skills/a/SKILL.md': SKILL('a') }, '', {
      contextWindow: 200_000,
    });
    expect(limit(plan, 'codex.skills_listing')?.limit).toBe(16_000);
    expect(plan.assumptions.find((a) => a.key === 'codex.context_window')).toMatchObject({
      value: 200_000,
      origin: 'flag',
    });
  });

  it('reports SKILL.md files and folders under a root that were not read', () => {
    const { plan } = scan({ '.agents/skills/read/SKILL.md': SKILL('read') }, '', {
      extras: {
        paths: ['.agents/skills/big/SKILL.md'],
        ignoredFiles: ['.agents/skills/local/SKILL.md'],
        opaqueDirectories: ['.agents/skills/vendor/'],
      },
    });
    expect(plan.incomplete).toEqual([
      'unread:.agents/skills/big/SKILL.md',
      'unread:.agents/skills/local/SKILL.md',
      'unread:.agents/skills/vendor/',
    ]);
  });
});

describe('loadCodex: hooks and config.toml', () => {
  const command = 'node scripts/guard.js';

  it('loads .codex/hooks.json handlers after approval, linked to the inventory', () => {
    const hooks = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command },
              { type: 'command', command },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
      },
    };
    const { plan } = scan({ '.codex/hooks.json': JSON.stringify(hooks) });
    // The inventory's id format (src/platforms/inventory-ids.ts): the last 8 hex digits.
    const digest = hash53(command).slice(-8);
    expect(
      plan.entries.map(({ id, trigger, name, inventoryId, certainty }) => [
        id,
        trigger,
        name,
        inventoryId,
        certainty,
      ]),
    ).toEqual([
      [
        `hook:.codex/hooks.json#PreToolUse:${digest}`,
        'on-approval',
        'PreToolUse',
        `hook:.codex/hooks.json#PreToolUse:${digest}`,
        'documented',
      ],
      [
        `hook:.codex/hooks.json#PreToolUse:${digest}:2`,
        'on-approval',
        'PreToolUse',
        `hook:.codex/hooks.json#PreToolUse:${digest}:2`,
        'documented',
      ],
      [
        `hook:.codex/hooks.json#Stop:${hash53('echo done').slice(-8)}`,
        'on-approval',
        'Stop',
        `hook:.codex/hooks.json#Stop:${hash53('echo done').slice(-8)}`,
        'documented',
      ],
    ]);
    expect(
      plan.entries.every((hook) => hook.size === undefined && hook.position === undefined),
    ).toBe(true);
    expect(plan.totals.startup.bytes).toBe(0);
  });

  it('skips handlers under unknown events, and every handler when an event sits outside "hooks"', () => {
    const unknown = scan({
      '.codex/hooks.json': JSON.stringify({
        hooks: { preToolUse: [{ hooks: [{ type: 'command', command }] }] },
      }),
    });
    expect(skips(unknown.plan)).toEqual(['.codex/hooks.json unknown-event hooks/unknown-event']);
    expect(unknown.plan.skipped[0]?.name).toBe('preToolUse');
    expectFindingsForSkips(unknown);

    const misplaced = scan({
      '.codex/hooks.json': JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] },
        PreToolUse: [{ hooks: [{ type: 'command', command }] }],
      }),
    });
    expect(misplaced.plan.entries).toEqual([]);
    expect(misplaced.plan.skipped.map((skip) => [skip.name, skip.code])).toEqual([
      ['PreToolUse', 'unknown-event'],
      ['Stop', 'unknown-event'],
    ]);
    expectFindingsForSkips(misplaced);
  });

  it('skips an unknown or misplaced event without handlers as a whole', () => {
    const scanned = scan({
      '.codex/hooks.json': JSON.stringify({
        hooks: { beforeShellExecution: [{ command: './g.sh' }], Stop: [] },
        SessionStart: [],
      }),
    });
    expect(scanned.plan.skipped.map((skip) => [skip.id, skip.code])).toEqual([
      ['hook:.codex/hooks.json#SessionStart', 'unknown-event'],
      ['hook:.codex/hooks.json#beforeShellExecution', 'unknown-event'],
    ]);
    expectFindingsForSkips(scanned);
  });

  it('leaves case variants below the working directory to a deeper start', () => {
    const { plan } = scan({ 'AGENTS.md': 'Root.\n', 'pkg/Agents.md': 'Variant.\n' });
    expect(plan.outOfScope).toEqual([{ path: 'pkg/Agents.md', because: 'below-start-dir' }]);
  });

  it('skips a hooks file that is not valid JSON', () => {
    const scanned = scan({ '.codex/hooks.json': '{ "hooks": { , }' });
    expect(skips(scanned.plan)).toEqual(['.codex/hooks.json invalid-json json/invalid-syntax']);
    expectFindingsForSkips(scanned);
  });

  it('reads hooks files of the chain only, nested ones as unverified', () => {
    const hooks = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });
    const { plan } = scan(
      {
        'pkg/.codex/hooks.json': hooks,
        'pkg/sub/.codex/hooks.json': hooks,
        'other/.codex/hooks.json': hooks,
      },
      'pkg',
    );
    expect(plan.entries.map((hook) => [hook.path, hook.certainty])).toEqual([
      ['pkg/.codex/hooks.json', 'unverified'],
    ]);
    expect(plan.outOfScope).toEqual([
      { path: 'pkg/sub/.codex/hooks.json', because: 'below-start-dir' },
    ]);
  });

  it('reports .codex/config.toml as not parsed and invents nothing from it', () => {
    const { plan } = scan({ 'AGENTS.md': 'Root.\n' }, '', {
      extras: { paths: ['.codex/config.toml'] },
    });
    expect(plan.incomplete).toEqual(['unparsed:.codex/config.toml']);
    expect(plan.entries.map((loaded) => loaded.role)).toEqual(['instructions']);
    expect(scan({ 'AGENTS.md': 'Root.\n' }).plan.incomplete).toEqual([]);
  });

  it('states its assumptions and the scopes it cannot see', () => {
    const { plan } = scan({ 'AGENTS.md': 'Root.\n' });
    expect(plan.agent).toBe('codex');
    expect(plan.cwd).toBe('');
    expect(plan.assumptions.map(({ key, value, origin }) => [key, value, origin])).toEqual([
      ['codex.context_window', 'unknown', 'default'],
      ['codex.project_doc_fallback_filenames', '[]', 'default'],
      ['codex.project_doc_max_bytes', 32_768, 'default'],
      ['codex.project_root_markers', '[".git"]', 'default'],
      ['codex.trust_level', 'trusted', 'default'],
    ]);
    expect(plan.hidden.flatMap((scope) => scope.locations)).toEqual([
      '/etc/codex/skills',
      '$CODEX_HOME/AGENTS.override.md',
      '$CODEX_HOME/AGENTS.md',
      '~/.agents/skills',
      '~/.codex/config.toml',
      '~/.codex/hooks.json',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

async function contextFixture(): Promise<Snapshot> {
  const root = fileURLToPath(new URL('../../fixtures/context', import.meta.url));
  const walked = await walk(root);
  // As in test/core/golden.test.ts: a checkout, with `.git` at the fixture root.
  return {
    ...walked,
    paths: new Set([...walked.paths, '.git/']),
    opaqueDirectories: new Set([...walked.opaqueDirectories, '.git/']),
  };
}

describe('loadCodex: context fixture', () => {
  it('at the root: the root AGENTS.md and the .agents skills', async () => {
    const scanned = scanAt(await contextFixture(), '');
    const { plan } = scanned;
    expect(plan.entries.map(({ id, position }) => [id, position])).toEqual([
      ['instructions:AGENTS.md', 1],
      ['skill:.agents/skills/changelog/SKILL.md', 2],
    ]);
    expect(skips(plan)).toEqual(['.agents/skills/db-migrate/SKILL.md bom skill/frontmatter-bom']);
    expect(plan.incomplete).toEqual(['unparsed:.codex/config.toml']);
    expect(plan.outOfScope.map((out) => out.path)).toContain('services/billing/AGENTS.md');
    expect(plan.outOfScope.every((out) => out.because === 'below-start-dir')).toBe(true);
    expect(limit(plan, 'codex.project_doc_max_bytes')?.used).toBe(271);
    expectFindingsForSkips(scanned);
  });

  it('in services/billing/ledger/export: the chain is cut in ledger and export is dropped', async () => {
    const scanned = scanAt(await contextFixture(), 'services/billing/ledger/export');
    const { plan } = scanned;
    expect(startupPaths(plan)).toEqual([
      'AGENTS.md',
      'services/AGENTS.md',
      'services/billing/AGENTS.md',
      'services/billing/ledger/AGENTS.md',
      '.agents/skills/changelog/SKILL.md',
    ]);
    // 271 + 13,542 + 12,639 bytes are read in full, leaving 6,316 of 32,768.
    expect(entry(plan, 'instructions:services/billing/ledger/AGENTS.md')).toMatchObject({
      size: { bytes: 6953, chars: 6316, tokens: 1579 },
      truncated: { atByte: 6316 },
    });
    expect(skips(plan)).toEqual([
      '.agents/skills/db-migrate/SKILL.md bom skill/frontmatter-bom',
      'services/billing/ledger/export/AGENTS.md over-byte-budget instr/codex-size-budget',
    ]);
    expect(limit(plan, 'codex.project_doc_max_bytes')).toMatchObject({
      limit: 32_768,
      used: 33_494,
    });
    expect(plan.outOfScope).toEqual([]);
    expectFindingsForSkips(scanned);
  });

  it('in packages/api and tools: overrides hide AGENTS.md, an empty one too', async () => {
    const snapshot = await contextFixture();
    const api = scanAt(snapshot, 'packages/api');
    expect(startupPaths(api.plan).slice(0, 2)).toEqual([
      'AGENTS.md',
      'packages/api/AGENTS.override.md',
    ]);
    expect(skips(api.plan)).toContain(
      'packages/api/AGENTS.md shadowed-by-override instr/override-shadows-agents-md',
    );
    expectFindingsForSkips(api);

    const tools = scanAt(snapshot, 'tools');
    expect(skips(tools.plan)).toEqual([
      '.agents/skills/db-migrate/SKILL.md bom skill/frontmatter-bom',
      'tools/AGENTS.md shadowed-by-override instr/override-shadows-agents-md',
      'tools/AGENTS.override.md empty-override instr/override-shadows-agents-md',
    ]);
    expectFindingsForSkips(tools);
  });
});

// ---------------------------------------------------------------------------------------------
// Determinism and hostile input
// ---------------------------------------------------------------------------------------------

/** The same snapshot with files, paths and every other set in the given orders. */
function reordered(
  snapshot: Snapshot,
  files: readonly number[],
  paths: readonly number[],
): Snapshot {
  const pathList = [...snapshot.paths];
  return {
    ...snapshot,
    files: files.map((i) => snapshot.files[i]!),
    paths: new Set(paths.map((i) => pathList[i]!)),
    opaqueDirectories: new Set([...snapshot.opaqueDirectories].reverse()),
    ignoredFiles: new Set([...snapshot.ignoredFiles].reverse()),
  };
}

const permutation = (length: number) =>
  fc.shuffledSubarray(
    Array.from({ length }, (_, i) => i),
    { minLength: length, maxLength: length },
  );

describe('loadCodex: determinism', () => {
  it('gives the same plan for any order of the same input', async () => {
    const synthetic = snapshotOf(
      {
        'AGENTS.md': 'a'.repeat(40) + '\n',
        'x/AGENTS.override.md': 'b'.repeat(40) + '\n',
        'x/AGENTS.md': 'hidden\n',
        'x/y/AGENTS.md': 'c'.repeat(40) + '\n',
        '.agents/skills/b/SKILL.md': SKILL('b'),
        '.agents/skills/a/SKILL.md': SKILL('a'),
        'x/.agents/skills/c/SKILL.md': '# none\n',
        'x/y/.agents/skills/d/deep/SKILL.md': SKILL('d'),
        '.codex/hooks.json': JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: 'command', command: 'b' },
                  { type: 'command', command: 'a' },
                ],
              },
            ],
            bad: [],
          },
        }),
      },
      { extras: { ignoredFiles: ['.agents/skills/z/SKILL.md'], paths: ['.codex/config.toml'] } },
    );
    const fixture = await contextFixture();
    const config = { rules: { 'instr/codex-size-budget': ['error', { maxBytes: 100 }] } };
    for (const [snapshot, cwd, options] of [
      [synthetic, 'x/y', { config }],
      [fixture, 'services/billing/ledger/export', {}],
    ] as const) {
      const expected = JSON.stringify(planOnly(snapshot, cwd, options));
      fc.assert(
        fc.property(
          permutation(snapshot.files.length),
          permutation(snapshot.paths.size),
          (files, paths) => {
            expect(JSON.stringify(planOnly(reordered(snapshot, files, paths), cwd, options))).toBe(
              expected,
            );
          },
        ),
        { numRuns: 25 },
      );
    }
  });
});

describe('loadCodex: hostile input', () => {
  it('handles a very deep directory tree within the budget', () => {
    const files: Record<string, string> = {};
    const segments: string[] = [];
    for (let depth = 1; depth <= 400; depth++) {
      segments.push(`d${String(depth)}`);
      if (depth % 4 === 0) files[`${segments.join('/')}/AGENTS.md`] = 'r'.repeat(299) + '\n';
    }
    const cwd = segments.join('/');
    files[`${cwd}/.agents/skills/deep/SKILL.md`] = SKILL('deep');
    const started = performance.now();
    const plan = planOnly(snapshotOf(files), cwd);
    expect(performance.now() - started).toBeLessThan(5000);
    // 100 files of 300 bytes: 30,000 bytes, under the 32,768-byte budget.
    expect(plan.entries.filter((loaded) => loaded.role === 'instructions')).toHaveLength(100);
    expect(limit(plan, 'codex.project_doc_max_bytes')?.used).toBe(30_000);
    expect(startupPaths(plan).at(-1)).toBe(`${cwd}/.agents/skills/deep/SKILL.md`);
  });

  it('cuts a deep chain at the budget and drops every later file', () => {
    const files: Record<string, string> = {};
    const segments: string[] = [];
    for (let depth = 1; depth <= 300; depth++) {
      segments.push('d');
      files[`${segments.join('/')}/AGENTS.md`] = 'r'.repeat(999) + '\n';
    }
    const plan = planOnly(snapshotOf(files), segments.join('/'));
    expect(plan.entries).toHaveLength(33);
    expect(plan.entries.at(-1)?.truncated).toEqual({ atByte: 768, line: 1 });
    expect(plan.skipped).toHaveLength(267);
    expect(plan.skipped.every((skip) => skip.code === 'over-byte-budget')).toBe(true);
  });

  it('handles thousands of skills and directories past the scan limits', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2500; i++) {
      const name = `skill-${String(i).padStart(4, '0')}`;
      files[`.agents/skills/${name}/SKILL.md`] = SKILL(name);
    }
    const deep = `.agents/skills/${Array.from({ length: 40 }, (_, i) => `l${String(i)}`).join('/')}`;
    files[`${deep}/SKILL.md`] = SKILL('deep');
    const started = performance.now();
    const plan = planOnly(snapshotOf(files));
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(plan.entries).toHaveLength(2500);
    expect(plan.entries.at(-1)?.position).toBe(2500);
    // Past 2,000 directories, which skills the walk reaches depends on its order.
    expect(plan.entries.every((skill) => skill.certainty === 'unverified')).toBe(true);
    expect(limit(plan, 'codex.skills_scan_directories')?.used).toBe(2541);
    expect(limit(plan, 'codex.skills_scan_depth')?.used).toBe(40);
    const listing = limit(plan, 'codex.skills_listing');
    expect(listing?.used).toBeGreaterThan(listing?.limit ?? 0);
    expect(skips(plan)).toEqual([`${deep}/SKILL.md not-read`]);
  });
});
