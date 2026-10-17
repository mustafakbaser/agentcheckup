/**
 * Fixes of the Cursor rules: golden before/after fixtures verified with fixRounds, the class and
 * id of each fix, idempotency, and the findings that must stay manual.
 */
import { describe, expect, it } from 'vitest';
import { scanSnapshot } from '../../../src/core/engine.js';
import type { Finding } from '../../../src/core/types.js';
import { fixRounds } from '../../../src/fix/verify.js';
import { builtinRules } from '../../../src/rules/index.js';
import { testRule } from '../../fix/helpers.js';
import { type FileMap, type SnapshotExtras, snapshotFrom } from '../../helpers/lint.js';
import { checkGolden, filesOf, goldenCases, runFix } from './golden.js';

/** Expected fix id and class per golden case. */
const EXPECTED: Readonly<Record<string, Readonly<Record<string, readonly [string, string]>>>> = {
  'cursor/md-file-ignored': {
    'always-apply-string': ['cursor/md-file-ignored#rename', 'safe'],
    'crlf-bom': ['cursor/md-file-ignored#always-apply', 'review'],
    description: ['cursor/md-file-ignored#rename', 'safe'],
    linked: ['cursor/md-file-ignored#rename', 'safe'],
    'no-frontmatter': ['cursor/md-file-ignored#always-apply', 'review'],
    'other-fields': ['cursor/md-file-ignored#always-apply', 'review'],
    'paths-list': ['cursor/md-file-ignored#globs', 'review'],
  },
  'cursor/rule-frontmatter': {
    'always-apply-string': ['cursor/rule-frontmatter#always-apply-boolean', 'safe'],
    'apply-to-list': ['cursor/rule-frontmatter#globs-key', 'review'],
    'globs-flow-list-crlf': ['cursor/rule-frontmatter#globs-string', 'safe'],
    'globs-list': ['cursor/rule-frontmatter#globs-string', 'safe'],
    'paths-to-globs': ['cursor/rule-frontmatter#globs-key', 'review'],
  },
  'cursor/legacy-cursorrules': {
    root: ['cursor/legacy-cursorrules#cursor-rule', 'review'],
    'with-agents-md': ['cursor/legacy-cursorrules#cursor-rule', 'review'],
  },
};

function scan(files: FileMap, extras: SnapshotExtras = {}) {
  return scanSnapshot(snapshotFrom(files, extras), { rules: builtinRules });
}

function ofRule(findings: readonly Finding[], ruleId: string): Finding[] {
  return findings.filter((finding) => finding.ruleId === ruleId);
}

function only(findings: readonly Finding[], ruleId: string): Finding {
  const [finding, ...rest] = ofRule(findings, ruleId);
  expect(rest).toEqual([]);
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

describe('cursor/md-file-ignored fixes', () => {
  const RULE = 'cursor/md-file-ignored';

  it('notes the effect of alwaysApply, Devin Local and links to the old path', () => {
    const { findings } = scan({
      'AGENTS.md':
        'See [style](.cursor/rules/style.md) and [again](./.cursor/rules/style.md#top).\n',
      'docs/AGENTS.md': 'Also [style](../.cursor/rules/style.md), [web](https://x.dev/a.md).\n',
      '.cursor/rules/style.md': 'Prefer named exports.\n',
    });
    const fix = only(findings, RULE).fix;
    expect(fix?.title).toBe(
      'Rename .cursor/rules/style.md to style.mdc and add "alwaysApply: true"',
    );
    expect(fix?.notes).toEqual([
      'With "alwaysApply: true", Cursor adds this rule to every conversation. To load it only when it is relevant, replace it with "globs" or a "description".',
      'Devin Local reads the file under either name.',
      'Update the links to ".cursor/rules/style.md" in "AGENTS.md" and "docs/AGENTS.md": they still point to the old name.',
    ]);
  });

  it('names at most three files that link to the old path', () => {
    const files: Record<string, string> = {
      '.cursor/rules/style.md': '---\nalwaysApply: false\n---\nx\n',
    };
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      files[`.cursor/rules/${name}.mdc`] = `---\nalwaysApply: true\n---\n[style](style.md)\n`;
    }
    const note = only(scan(files).findings, RULE).fix?.notes?.at(-1);
    expect(note).toBe(
      'Update the links to ".cursor/rules/style.md" in ".cursor/rules/a.mdc", ".cursor/rules/b.mdc", ".cursor/rules/c.mdc" and 2 other files: they still point to the old name.',
    );
  });

  it('renames a rule with frontmatter that is not valid YAML, for review', () => {
    const { findings } = scan({ '.cursor/rules/ts.md': '---\nglobs: *.ts\n---\nUse strict.\n' });
    const fix = only(findings, RULE).fix;
    expect([fix?.id, fix?.class, fix?.changes]).toEqual([
      'cursor/md-file-ignored#rename-unchecked',
      'review',
      [{ kind: 'rename', from: '.cursor/rules/ts.md', to: '.cursor/rules/ts.mdc' }],
    ]);
  });

  it.each([
    ['an existing .mdc file', { '.cursor/rules/style.mdc': '---\nalwaysApply: true\n---\nx\n' }],
    ['one that differs in letter case', { '.cursor/rules/Style.mdc': 'x' }],
    ['an identical one', { '.cursor/rules/style.mdc': 'Prefer named exports.\n' }],
  ])('leaves a name collision with %s to the user', (_label, extra: FileMap) => {
    const { findings } = scan({ '.cursor/rules/style.md': 'Prefer named exports.\n', ...extra });
    const finding = only(findings, RULE);
    expect(finding.fix).toBeUndefined();
    expect(finding.guidance).toBe(
      '"style.mdc", or a name that differs from it only in letter case, already exists: merge the two files by hand',
    );
  });

  it('leaves a collision with a gitignored file to the user', () => {
    const finding = only(
      scan({ '.cursor/rules/style.md': 'x\n' }, { ignoredFiles: ['.cursor/rules/STYLE.MDC'] })
        .findings,
      RULE,
    );
    expect(finding.fix).toBeUndefined();
  });

  it('applies one of two renames whose targets differ only in letter case', () => {
    const run = runFix(
      snapshotFrom({ '.cursor/rules/Style.md': 'x\n', '.cursor/rules/style.md': 'y\n' }),
      RULE,
    );
    expect(run.applied).toHaveLength(1);
    const left = ofRule(run.after.findings, RULE);
    expect(left).toHaveLength(1);
    expect(left[0]?.fix).toBeUndefined();
    expect(left[0]?.guidance).toContain('already exists');
  });

  it.each([
    [
      'a symlink alias',
      { '.cursor/rules/style.md': 'x\n', '.clinerules/style.md': 'x\n' },
      { symlinks: { '.clinerules/style.md': '.cursor/rules/style.md' } },
      '".clinerules/style.md" links to this file: rename the file to "style.mdc" by hand and update the link',
    ],
    [
      'a symlinked file',
      { '.cursor/rules/style.md': 'x\n' },
      { symlinks: { '.cursor/rules/style.md': 'docs/style.md' } },
      '".cursor/rules/style.md" is a symbolic link to "docs/style.md": rename the file to "style.mdc" by hand',
    ],
  ])('never renames %s', (_label, files: FileMap, extras: SnapshotExtras, guidance) => {
    const finding = only(scan(files, extras).findings, RULE);
    expect(finding.fix).toBeUndefined();
    expect(finding.guidance).toBe(guidance);
  });

  it.each([
    ['an unclosed block', '---\nalwaysApply: true\n', 'close the frontmatter with a "---" line'],
    ['TOML frontmatter', '+++\ntitle = "x"\n+++\n', 'replace the frontmatter with YAML'],
    ['a quoted "false"', '---\nalwaysApply: "false"\n---\n', 'without quotes, then rename'],
    ['a misspelled field', '---\nalways_apply: true\n---\n', 'rename "always_apply" to'],
    ['paths next to globs', '---\nglobs: "*.ts"\npaths: src/**\n---\n', 'into "globs" by hand'],
    ['paths and applyTo', '---\npaths: a/**\napplyTo: b/**\n---\n', 'merge "paths" and "applyTo"'],
    ['a list of numbers as paths', '---\npaths: [1, 2]\n---\n', 'replace "paths" with one'],
    ['a pattern with a comma', '---\npaths: ["src/{a,b}/**"]\n---\n', 'replace "paths" with one'],
    ['a description that is a list', '---\ndescription: [a]\n---\n', 'write "description" as'],
    ['globs that are a number', '---\nglobs: 3\n---\n', 'write "globs" as one'],
  ])('leaves %s to the user', (_label, text, guidance) => {
    const finding = only(scan({ '.cursor/rules/x.md': `${text}Body\n` }).findings, RULE);
    expect(finding.fix).toBeUndefined();
    expect(finding.guidance).toContain(guidance);
  });

  it('refuses a name that Windows does not allow', () => {
    const finding = only(scan({ '.cursor/rules/a:b.md': 'x\n' }).findings, RULE);
    expect(finding.fix).toBeUndefined();
    expect(finding.guidance).toBe(
      'choose another name ending in .mdc by hand: the path has a character Windows does not allow',
    );
  });

  it('never fixes a suppressed finding', () => {
    const text =
      '<!-- agentcheckup-disable-file cursor/md-file-ignored -- documentation for humans -->\nx\n';
    const run = runFix(snapshotFrom({ '.cursor/rules/notes.md': text }), RULE);
    expect(run.applied).toEqual([]);
    expect(run.files).toEqual([]);
  });

  it('does not report or fix a README', () => {
    const run = runFix(snapshotFrom({ '.cursor/rules/README.md': '# Rules\n' }), RULE);
    expect(run.before.findings.filter((finding) => finding.ruleId === RULE)).toEqual([]);
    expect(run.files).toEqual([]);
  });
});

describe('cursor/rule-frontmatter fixes', () => {
  const RULE = 'cursor/rule-frontmatter';
  const PATH = '.cursor/rules/x.mdc';

  function fixes(text: string, extras: SnapshotExtras = {}) {
    return ofRule(scan({ [PATH]: text }, extras).findings, RULE).map((finding) => ({
      id: finding.fix?.id,
      guidance: finding.guidance,
    }));
  }

  function fixed(text: string): string {
    const run = runFix(snapshotFrom({ [PATH]: text }), RULE);
    expect(ofRule(run.after.findings, RULE).filter((f) => f.severity !== 'info')).toEqual([]);
    return new TextDecoder().decode(run.snapshot.files[0]?.bytes);
  }

  it('renames a quoted key', () => {
    expect(fixed('---\n"paths": "src/**"\n---\nx\n')).toBe('---\nglobs: "src/**"\n---\nx\n');
  });

  it('fixes several fields of one rule in one run', () => {
    expect(fixed('---\napplyTo: ["a/**"]\nalwaysApply: "true"\n---\nx\n')).toBe(
      '---\nglobs: "a/**"\nalwaysApply: true\n---\nx\n',
    );
  });

  it("keeps a block list that sits at the key's indentation readable", () => {
    expect(fixed('---\nglobs:\n- a/**\n- b/**\nalwaysApply: false\n---\nx\n')).toBe(
      '---\nglobs: "a/**, b/**"\nalwaysApply: false\n---\nx\n',
    );
  });

  it.each([
    ['alwaysApply: "false"', '---\nalwaysApply: "false"\n---\n', 'write "alwaysApply: true" or'],
    ['alwaysApply: 1', '---\nalwaysApply: 1\n---\n', 'without quotes'],
    ['a pattern with a comma', '---\nglobs: ["src/{a,b}/**"]\n---\n', 'expand a pattern'],
    ['an anchor', '---\nglobs: &g ["a/**"]\n---\n', 'one comma-separated string'],
    ['a comment in the list', '---\nglobs:\n  # sources\n  - a/**\n---\n', 'comma-separated'],
    ['an empty list', '---\nglobs: []\n---\n', 'comma-separated'],
    ['a pattern with spaces around it', '---\nglobs: [" a/** "]\n---\n', 'comma-separated'],
    ['paths next to globs', '---\nglobs: a/**\npaths: b/**\n---\n', 'move the patterns'],
    ['an empty paths', '---\npaths: ""\n---\n', 'replace "paths" with one'],
    ['a description list', '---\ndescription: [a]\n---\n', 'write the description as one line'],
    ['globs as a map', '---\nglobs: {a: 1}\n---\n', 'write "globs" as one quoted'],
  ])('leaves %s to the user', (_label, text, guidance) => {
    const found = fixes(`${text}x\n`);
    expect(found.every((entry) => entry.id === undefined)).toBe(true);
    expect(found.some((entry) => entry.guidance?.includes(guidance))).toBe(true);
  });

  it('gives both aliases a manual step when paths and applyTo are set', () => {
    expect(fixes('---\npaths: a/**\napplyTo: b/**\n---\nx\n')).toEqual([
      { id: undefined, guidance: 'merge "paths" and "applyTo" into one "globs" field by hand' },
      { id: undefined, guidance: 'merge "paths" and "applyTo" into one "globs" field by hand' },
    ]);
  });

  it('adds no step for a misspelling the message already corrects', () => {
    expect(fixes('---\nalways_apply: true\n---\nx\n')).toEqual([
      { id: undefined, guidance: undefined },
    ]);
  });

  it('never edits a linked rule', () => {
    expect(
      fixes('---\nalwaysApply: "true"\n---\nx\n', { symlinks: { [PATH]: 'shared/x.mdc' } }),
    ).toEqual([
      {
        id: undefined,
        guidance:
          '".cursor/rules/x.mdc" is a symbolic link to "shared/x.mdc": correct the frontmatter by hand',
      },
    ]);
  });
});

describe('cursor/legacy-cursorrules fixes', () => {
  const RULE = 'cursor/legacy-cursorrules';

  it('offers AGENTS.md as an alternative when the directory has none', () => {
    const fix = only(scan({ '.cursorrules': 'Use pnpm.\n' }).findings, RULE).fix;
    expect(fix?.title).toBe(
      'Move .cursorrules to .cursor/rules/cursorrules.mdc with "alwaysApply: true"',
    );
    expect(fix?.notes).toEqual([
      'Cline reads .cursorrules but not .cursor/rules, so it stops loading these instructions.',
      'Devin Local reads .cursor/rules, so it starts loading these instructions.',
    ]);
    expect(fix?.alternatives).toEqual([
      {
        id: 'cursor/legacy-cursorrules#agents-md',
        class: 'review',
        title: 'Rename .cursorrules to AGENTS.md',
        changes: [{ kind: 'rename', from: '.cursorrules', to: 'AGENTS.md' }],
        notes: [
          'Cursor and Cline keep reading these instructions as AGENTS.md, and Codex, GitHub Copilot and Devin Local start reading them.',
        ],
      },
    ]);
  });

  it.each([['AGENTS.md'], ['agents.md']])('leaves merging into %s to the user', (name) => {
    const finding = only(scan({ '.cursorrules': 'x\n', [name]: '# A\n' }).findings, RULE);
    expect(finding.fix?.alternatives).toBeUndefined();
    expect(finding.guidance).toBe(
      'to use AGENTS.md instead, which more agents read, merge .cursorrules into AGENTS.md by hand',
    );
  });

  it('moves a nested .cursorrules next to it and says what changes', () => {
    const fix = only(scan({ 'packages/web/.cursorrules': 'x\n' }).findings, RULE).fix;
    expect(fix?.changes[0]).toEqual({
      kind: 'rename',
      from: 'packages/web/.cursorrules',
      to: 'packages/web/.cursor/rules/cursorrules.mdc',
    });
    expect(fix?.notes?.at(-1)).toBe(
      'Cursor reads this .cursorrules only when packages/web is the workspace folder. Opened at the repository root, Cursor may also apply the new rule to files in packages/web.',
    );
  });

  it('leaves an existing rule with that name in another case to the user', () => {
    const finding = only(
      scan({ '.cursorrules': 'x\n', '.cursor/rules/CursorRules.mdc': 'x' }).findings,
      RULE,
    );
    expect(finding.fix).toBeUndefined();
    expect(finding.guidance).toBe(
      '.cursor/rules/cursorrules.mdc already exists: merge .cursorrules into it by hand',
    );
  });

  it('leaves a file that starts with a "---" block to the user', () => {
    const finding = only(scan({ '.cursorrules': '---\ntitle: rules\n---\nx\n' }).findings, RULE);
    expect(finding.fix).toBeUndefined();
    expect(finding.guidance).toContain('the file starts with a "---" block');
  });

  it('never moves a linked file', () => {
    const finding = only(
      scan({ '.cursorrules': 'x\n' }, { symlinks: { '.cursorrules': 'docs/rules.txt' } }).findings,
      RULE,
    );
    expect(finding.fix).toBeUndefined();
    expect(finding.guidance).toContain('is a symbolic link');
  });

  it('verifies the AGENTS.md alternative too', () => {
    const fix = only(scan({ '.cursorrules': 'Use pnpm.\n' }).findings, RULE).fix;
    const alternative = fix?.alternatives?.[0];
    if (alternative === undefined) throw new Error('no alternative');
    const rule = testRule({
      id: 'test/alternative',
      appliesTo: ['cursor-legacy-rules'],
      check(context, artifact) {
        context.report({ artifact, message: 'x', fix: alternative });
      },
    });
    const run = fixRounds(
      snapshotFrom({ '.cursorrules': 'Use pnpm.\n' }),
      { rules: [...builtinRules, rule] },
      {
        classes: new Set(['review']),
        ruleIds: new Set(['test/alternative']),
        literalSecret: false,
      },
    );
    expect(run.applied).toHaveLength(1);
    expect(filesOf(run.snapshot)).toEqual({ 'AGENTS.md': new TextEncoder().encode('Use pnpm.\n') });
    expect(ofRule(run.after.findings, RULE)).toEqual([]);
  });
});

describe('cursor/rule-never-applied guidance', () => {
  const RULE = 'cursor/rule-never-applied';
  const GUIDANCE =
    'add "globs" with the files the rule is for, a "description" of when to use it, or "alwaysApply: true"; to keep it manual on purpose, add "alwaysApply: false"';

  it.each([
    ['no frontmatter', 'x\n'],
    ['frontmatter without activation fields', '---\nname: x\n---\nx\n'],
  ])('gives a manual step and asks for globs for %s', (_label, text) => {
    const finding = only(scan({ '.cursor/rules/x.mdc': text }).findings, RULE);
    expect(finding.fix).toEqual({
      id: 'cursor/rule-never-applied#globs',
      class: 'review',
      title: 'Add "globs" to .cursor/rules/x.mdc',
      changes: [],
      input: {
        field: 'cursor-globs',
        question: 'Attach this rule to the files that match glob patterns, such as src/**/*.ts?',
        label: '"globs" patterns',
        target: { kind: 'frontmatter', path: '.cursor/rules/x.mdc', key: 'globs' },
      },
    });
    expect(finding.guidance).toBe(GUIDANCE);
  });

  it('asks nothing for a rule reached through a symlink', () => {
    const linked = scan(
      { '.cursor/rules/x.mdc': 'x\n' },
      { symlinks: { '.cursor/rules/x.mdc': 'shared/x.mdc' } },
    );
    const finding = only(linked.findings, RULE);
    expect(finding.fix).toBeUndefined();
    expect(finding.guidance).toBe(GUIDANCE);
  });
});

describe('fix classes', () => {
  it("match each rule's meta.fix.classes", () => {
    const { findings } = scan({
      '.cursorrules': 'x\n',
      '.cursor/rules/a.md': 'x\n',
      '.cursor/rules/b.md': '---\ndescription: B\n---\nx\n',
      '.cursor/rules/c.md': '---\npaths: c/**\n---\nx\n',
      '.cursor/rules/d.md': '---\nglobs: *.ts\n---\nx\n',
      '.cursor/rules/e.mdc': '---\nalwaysApply: "true"\nglobs: [a]\n---\nx\n',
      '.cursor/rules/f.mdc': '---\napplyTo: b\n---\nx\n',
    });
    const metas = new Map(builtinRules.map((rule) => [rule.meta.id, rule.meta]));
    const seen = new Set<string>();
    for (const finding of findings) {
      if (finding.fix === undefined || !finding.ruleId.startsWith('cursor/')) continue;
      for (const fix of [finding.fix, ...(finding.fix.alternatives ?? [])]) {
        expect(metas.get(finding.ruleId)?.fix?.classes).toContain(fix.class);
        expect(fix.id.startsWith(`${finding.ruleId}#`)).toBe(true);
        seen.add(`${fix.id} ${fix.class}`);
      }
    }
    expect([...seen].sort()).toEqual([
      'cursor/legacy-cursorrules#agents-md review',
      'cursor/legacy-cursorrules#cursor-rule review',
      'cursor/md-file-ignored#always-apply review',
      'cursor/md-file-ignored#ask-globs review',
      'cursor/md-file-ignored#globs review',
      'cursor/md-file-ignored#rename safe',
      'cursor/md-file-ignored#rename-unchecked review',
      'cursor/rule-frontmatter#always-apply-boolean safe',
      'cursor/rule-frontmatter#globs-key review',
      'cursor/rule-frontmatter#globs-string safe',
      'cursor/rule-never-applied#globs review',
    ]);
  });
});
