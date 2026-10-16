/**
 * Fixes of the GitHub Copilot rules: golden before/after fixtures verified with fixRounds, the
 * class and id of each fix, idempotency, and the findings that must stay manual.
 */
import { describe, expect, it } from 'vitest';
import { scanSnapshot } from '../../../src/core/engine.js';
import type { Finding } from '../../../src/core/types.js';
import { builtinRules } from '../../../src/rules/index.js';
import { type FileMap, type SnapshotExtras, snapshotFrom } from '../../helpers/lint.js';
import { checkGolden, filesOf, goldenCases, runFix } from '../cursor/golden.js';

/** Expected fix id and class per golden case. */
const EXPECTED: Readonly<Record<string, Readonly<Record<string, readonly [string, string]>>>> = {
  'copilot/apply-to': {
    'block-list': ['copilot/apply-to#string', 'safe'],
    'flow-list-crlf-bom': ['copilot/apply-to#string', 'safe'],
  },
  'copilot/instructions-misplaced': {
    'path-specific': ['copilot/instructions-misplaced#move', 'review'],
    'repository-wide': ['copilot/instructions-misplaced#move', 'review'],
  },
};

function scan(files: FileMap, extras: SnapshotExtras = {}) {
  return scanSnapshot(snapshotFrom(files, extras), { rules: builtinRules });
}

function only(findings: readonly Finding[], ruleId: string): Finding {
  const matching = findings.filter((finding) => finding.ruleId === ruleId);
  expect(matching).toHaveLength(1);
  const [finding] = matching;
  if (finding === undefined) throw new Error(`no ${ruleId} finding`);
  return finding;
}

describe.each(Object.keys(EXPECTED))('%s golden fixes', (ruleId) => {
  const cases = EXPECTED[ruleId] ?? {};
  it('has a fixture for every expected case', () => {
    expect(goldenCases(ruleId)).toEqual(Object.keys(cases).sort());
  });
  it.each(Object.keys(cases))('%s', (name) => {
    const run = checkGolden(ruleId, name);
    const [id, cls] = cases[name] ?? [];
    expect(run.applied.map((planned) => [planned.fix.id, planned.fix.class])).toEqual([[id, cls]]);
  });
});

describe('copilot/apply-to fixes', () => {
  const RULE = 'copilot/apply-to';
  const PATH = '.github/instructions/ts.instructions.md';

  const reported = (text: string, extras: SnapshotExtras = {}) =>
    only(scan({ [PATH]: text }, extras).findings, RULE);

  it('joins the patterns with a bare comma, as GitHub documents', () => {
    const fix = reported('---\napplyTo: [src/**, test/**]\n---\nx\n').fix;
    expect(fix).toEqual({
      id: 'copilot/apply-to#string',
      class: 'safe',
      title:
        'Write "applyTo" as one comma-separated string in .github/instructions/ts.instructions.md',
      changes: [
        {
          kind: 'edit',
          path: PATH,
          edits: [{ offset: 12, length: 18, text: ' "src/**,test/**"' }],
        },
      ],
    });
  });

  it.each([
    ['no frontmatter', 'x\n', 'start the file with a frontmatter block'],
    ['no applyTo', '---\nname: ts\n---\nx\n', 'add "applyTo" with the files'],
    ['a description only', '---\ndescription: TS\n---\nx\n', 'if Copilot cloud agent and code'],
    ['an unclosed block', '---\napplyTo: "**"\n', 'add a "---" line'],
    ['TOML frontmatter', '+++\napplyTo = "**"\n+++\n', 'write the frontmatter as YAML'],
    ['invalid YAML', '---\napplyTo: [a/**\n---\n', 'correct the YAML'],
    ['an empty value', '---\napplyTo:\n---\n', 'set "applyTo" to the files'],
    ['a blank string', '---\napplyTo: " "\n---\n', 'set "applyTo" to the files'],
    ['a number', '---\napplyTo: 3\n---\n', 'write "applyTo" as one quoted string'],
    ['a pattern with a comma', '---\napplyTo: ["src/{a,b}/**"]\n---\n', 'expand a pattern'],
    ['a list with a comment', '---\napplyTo:\n  - a/** # app\n---\n', 'by hand'],
  ])('leaves %s to the user', (_label, text, guidance) => {
    const finding = reported(text);
    expect(finding.fix).toBeUndefined();
    expect(finding.guidance).toContain(guidance);
  });

  it('gives a manual step for an undocumented excludeAgent', () => {
    const finding = only(
      scan({ [PATH]: '---\napplyTo: "**"\nexcludeAgent: reviewer\n---\nx\n' }).findings,
      RULE,
    );
    expect(finding.guidance).toBe(
      'set "excludeAgent" to "code-review" or "cloud-agent", or remove it',
    );
  });

  it('never edits a linked file', () => {
    const finding = reported('---\napplyTo: [a/**]\n---\nx\n', {
      symlinks: { [PATH]: 'shared/ts.instructions.md' },
    });
    expect(finding.fix).toBeUndefined();
    expect(finding.guidance).toContain('is a symbolic link');
  });

  it('never fixes a suppressed finding', () => {
    const text =
      '---\n# agentcheckup-disable-next-line copilot/apply-to -- read by our own tool\napplyTo: [a/**]\n---\nx\n';
    const run = runFix(snapshotFrom({ [PATH]: text }), RULE);
    expect(run.before.findings.filter((finding) => finding.ruleId === RULE)).toEqual([
      expect.objectContaining({ suppressed: expect.anything() as unknown }),
    ]);
    expect(run.files).toEqual([]);
  });
});

describe('copilot/instructions-misplaced fixes', () => {
  const RULE = 'copilot/instructions-misplaced';

  it('says what the move changes', () => {
    const fix = only(scan({ '.github/prompts/ts.instructions.md': 'x\n' }).findings, RULE).fix;
    expect(fix?.title).toBe(
      'Move .github/prompts/ts.instructions.md to .github/instructions/ts.instructions.md',
    );
    expect(fix?.notes).toEqual([
      'GitHub Copilot then applies these instructions to the files their "applyTo" matches.',
    ]);
  });

  it('moves a file in a nested repository within that repository', () => {
    const run = runFix(
      snapshotFrom(
        { 'vendor/tool/.github/docs/copilot-instructions.md': 'x\n' },
        { paths: ['vendor/tool/.git'] },
      ),
      RULE,
    );
    expect(Object.keys(filesOf(run.snapshot))).toEqual([
      'vendor/tool/.github/copilot-instructions.md',
    ]);
  });

  it.each([
    [
      'a case-only difference in the file name',
      '.github/Copilot-Instructions.md',
      `rename it to ".github/copilot-instructions.md" in two steps, so that git also records the new letter case on macOS and Windows: git mv .github/Copilot-Instructions.md .github/Copilot-Instructions.md.tmp && git mv .github/Copilot-Instructions.md.tmp .github/copilot-instructions.md`,
    ],
    [
      'a case-only difference in a directory',
      '.github/Instructions/my file.instructions.md',
      `rename it to ".github/instructions/my file.instructions.md" in two steps, so that git also records the new letter case on macOS and Windows: git mv '.github/Instructions/my file.instructions.md' '.github/Instructions/my file.instructions.md.tmp' && git mv '.github/Instructions/my file.instructions.md.tmp' '.github/instructions/my file.instructions.md'`,
    ],
    [
      'a repository-wide file in a subdirectory',
      'packages/web/.github/copilot-instructions.md',
      'to use it on GitHub.com, merge it into .github/copilot-instructions.md at the repository root by hand',
    ],
    [
      'a path-specific file in a subdirectory',
      'packages/web/.github/instructions/ts.instructions.md',
      'to use it on GitHub.com, move it into .github/instructions/ at the repository root by hand and limit its "applyTo" to "packages/web/**"',
    ],
    [
      'a misplaced file in a subdirectory',
      'packages/web/.github/prompts/ts.instructions.md',
      'to use it on GitHub.com, move it into .github/instructions/ at the repository root by hand and limit its "applyTo" to "packages/web/**"',
    ],
    [
      'a .github folder in another case',
      '.GitHub/prompts/copilot-instructions.md',
      'move it to ".github/copilot-instructions.md" by hand',
    ],
  ])('leaves %s to the user', (_label, path, guidance) => {
    const finding = only(scan({ [path]: '---\napplyTo: "**"\n---\nx\n' }).findings, RULE);
    expect(finding.fix).toBeUndefined();
    expect(finding.guidance).toBe(guidance);
  });

  it.each([
    [
      'repository-wide',
      '.github/instructions/copilot-instructions.md',
      '.github/Copilot-Instructions.md',
      '".github/copilot-instructions.md" already exists: merge this file into it by hand',
    ],
    [
      'path-specific',
      '.github/prompts/ts.instructions.md',
      '.github/instructions/TS.instructions.md',
      '".github/instructions/ts.instructions.md" already exists: move this file into ".github/instructions/" under another name by hand',
    ],
  ])('leaves a %s move onto an existing file to the user', (_label, path, existing, guidance) => {
    const findings = scan({ [path]: 'x\n', [existing]: 'y\n' }).findings.filter(
      (finding) => finding.ruleId === RULE && finding.path === path,
    );
    expect(findings.map((finding) => [finding.fix, finding.guidance])).toEqual([
      [undefined, guidance],
    ]);
  });

  it('never moves a linked file', () => {
    const finding = only(
      scan(
        { '.github/prompts/copilot-instructions.md': 'x\n' },
        { symlinks: { '.github/prompts/copilot-instructions.md': 'AGENTS.md' } },
      ).findings,
      RULE,
    );
    expect(finding.fix).toBeUndefined();
    expect(finding.guidance).toContain('is a symbolic link');
  });

  it('refuses a name that Windows does not allow', () => {
    const finding = only(scan({ '.github/prompts/a<b.instructions.md': 'x\n' }).findings, RULE);
    expect(finding.fix).toBeUndefined();
    expect(finding.guidance).toBe(
      'move it by hand: the path has a character Windows does not allow',
    );
  });

  it('moves only one of two files with the same target', () => {
    const run = runFix(
      snapshotFrom({
        '.github/a/copilot-instructions.md': 'a\n',
        '.github/b/copilot-instructions.md': 'b\n',
      }),
      RULE,
    );
    expect(run.applied).toHaveLength(1);
    expect(Object.keys(filesOf(run.snapshot)).sort()).toEqual([
      '.github/b/copilot-instructions.md',
      '.github/copilot-instructions.md',
    ]);
  });
});

describe('fix classes', () => {
  it("match each rule's meta.fix.classes", () => {
    const { findings } = scan({
      '.github/instructions/a.instructions.md': '---\napplyTo: [a/**]\n---\nx\n',
      '.github/prompts/b.instructions.md': '---\napplyTo: b/**\n---\nx\n',
    });
    const metas = new Map(builtinRules.map((rule) => [rule.meta.id, rule.meta]));
    const seen: string[] = [];
    for (const finding of findings) {
      if (finding.fix === undefined || !finding.ruleId.startsWith('copilot/')) continue;
      expect(metas.get(finding.ruleId)?.fix?.classes).toContain(finding.fix.class);
      seen.push(`${finding.fix.id} ${finding.fix.class}`);
    }
    expect(seen.sort()).toEqual([
      'copilot/apply-to#string safe',
      'copilot/instructions-misplaced#move review',
    ]);
  });
});
