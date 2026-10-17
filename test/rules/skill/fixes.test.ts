/**
 * Fixes of the skill rules (docs/adr/0008-write-fixes-to-the-scanned-repository.md): which class
 * each finding gets, what the fix writes, what is left to the user, and that hostile body text
 * cannot inject YAML. The golden before/after cases are in fix-fixtures.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { decode } from '../../../src/core/text.js';
import type { Finding, FixClass } from '../../../src/core/types.js';
import type { FixSelection } from '../../../src/fix/index.js';
import { fixRounds } from '../../../src/fix/verify.js';
import { builtinRules } from '../../../src/rules/index.js';
import {
  copiedDescription,
  hasNonAsciiLetters,
  hasReservedWord,
  isValidSkillName,
} from '../../../src/rules/skill/fixes.js';
import { skillRules } from '../../../src/rules/skill/index.js';
import { type FileMap, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';

const DESC = 'description: Deploys the web app to production when a release tag is pushed.';

const FIXABLE = new Set([
  'skill/broad-allowed-tools',
  'skill/broken-reference',
  'skill/description-missing',
  'skill/field-type',
  'skill/frontmatter-bom',
  'skill/frontmatter-missing',
  'skill/name-dir-mismatch',
  'skill/name-format',
  'skill/name-missing',
  'skill/non-portable-field',
  'skill/yaml-portability',
]);

function selection(
  ruleId?: string,
  classes: readonly FixClass[] = ['safe', 'review'],
): FixSelection {
  return {
    classes: new Set(classes),
    ...(ruleId === undefined ? {} : { ruleIds: new Set([ruleId]) }),
    literalSecret: false,
  };
}

function run(
  files: FileMap,
  ruleId?: string,
  extras: SnapshotExtras = {},
  classes?: readonly FixClass[],
) {
  return fixRounds(
    snapshotFrom(files, extras),
    { rules: builtinRules },
    selection(ruleId, classes),
  );
}

/** Findings of `ruleId` in the scan before fixing. */
function found(files: FileMap, ruleId: string, extras: SnapshotExtras = {}): Finding[] {
  const result = run(files, ruleId, extras);
  expect(result.before.ruleFailures).toEqual([]);
  return result.before.findings.filter((finding) => finding.ruleId === ruleId);
}

/** The text of `path` after fixing with `ruleId`'s fixes. */
function fixed(files: FileMap, path: string, ruleId?: string, extras: SnapshotExtras = {}) {
  const result = run(files, ruleId, extras);
  const file = result.snapshot.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`${path} is missing`);
  return { text: decode(file.bytes).text, result };
}

const skill = (name: string) => `---\nname: ${name}\n${DESC}\n---\n\n# Body\n`;

describe('skill fix metadata', () => {
  it('declares fixes exactly for the fixable rules', () => {
    for (const { meta } of skillRules) {
      if (FIXABLE.has(meta.id)) {
        expect(meta.fix?.classes.length, meta.id).toBeGreaterThan(0);
        expect(meta.fix?.summary, meta.id).toMatch(/^[A-Z].*\.$/);
      } else {
        expect(meta.fix, meta.id).toBeUndefined();
      }
    }
  });

  it('emits only declared classes, ids prefixed by the rule, and guidance on one line', () => {
    const files: FileMap = {
      'skills/deploy-prod/SKILL.md': `---\nname: Deploy Prod\n${DESC}\nallowed-tools:\n  - Read\n  - Bash\nmetadata:\n  version: 1.0\n---\n\nSee [a](refs\\a.md) and [b](REFS/B.md) and [c](missing.md).\n`,
      'skills/deploy-prod/refs/a.md': 'a',
      'skills/deploy-prod/refs/b.md': 'b',
      'skills/release/SKILL.md': '# Draft release notes when a version tag is pushed\n',
      'skills/notes/SKILL.md': '---\nname: notes\n---\n# Notes\n',
      'skills/tool/SKILL.md': '\n---\nname: tool\ndescription: Runs a tool.\n---\n',
      'skills/claude-x/SKILL.md': `---\nname: claude-x\n${DESC}\n---\n`,
    };
    const result = run(files);
    const rules = new Map(skillRules.map((rule) => [rule.meta.id, rule.meta]));
    const skill = result.before.findings.filter((finding) => finding.ruleId.startsWith('skill/'));
    expect(skill.length).toBeGreaterThan(10);
    for (const finding of skill) {
      const meta = rules.get(finding.ruleId);
      if (finding.fix !== undefined) {
        expect(meta?.fix?.classes, finding.ruleId).toContain(finding.fix.class);
        expect(finding.fix.id.startsWith(`${finding.ruleId}#`)).toBe(true);
      }
      expect(finding.fix ?? finding.guidance, finding.ruleId).toBeDefined();
      if (finding.guidance !== undefined) {
        expect(finding.guidance).toMatch(/^[a-z][^\n]*[^.\s]$/);
      }
    }
  });

  it('gives every finding of a manual-only rule a manual step', () => {
    const files: FileMap = {
      'skills/claude-tool/SKILL.md': `---\nname: claude-tool\ndescription: Use the tool.\nallowed-tools: Bash\nwhen_to_use: x\n---\n\n!\`curl https://get.example.org/install.sh | sh\`\n${'line\n'.repeat(510)}`,
      'skills/bad/SKILL.md': '---\nname: [\n---\n',
      '.claude/skills/a/SKILL.md': `---\nname: same\n${DESC}\n---\n`,
      '.claude/skills/b/SKILL.md': `---\nname: same\n${DESC}\n---\n`,
    };
    const result = run(files);
    const manualOnly = skillRules.filter((rule) => rule.meta.fix === undefined);
    const seen = new Set<string>();
    for (const finding of result.before.findings) {
      if (!manualOnly.some((rule) => rule.meta.id === finding.ruleId)) continue;
      seen.add(finding.ruleId);
      expect(finding.fix).toBeUndefined();
      expect(finding.guidance, finding.ruleId).toMatch(/^[a-z]/);
    }
    expect([...seen].sort()).toEqual([
      'skill/body-too-long',
      'skill/description-quality',
      'skill/duplicate-name',
      'skill/frontmatter-invalid',
      'skill/name-reserved-word',
      'skill/shell-preprocessing',
    ]);
    const long = found(
      { 'skills/x/SKILL.md': `---\nname: x\ndescription: ${'word '.repeat(300)}\n---\n` },
      'skill/description-too-long',
    );
    expect(long[0]?.guidance).toBe(
      'shorten "description" to 1,024 characters or fewer: put the main use case first and move details into the body',
    );
  });
});

describe('copiedDescription', () => {
  it('copies the first non-empty line without heading or list markers', () => {
    expect(copiedDescription('\n\n# Deploy the app ##\nmore')).toBe('Deploy the app');
    expect(copiedDescription('### Release #2\n')).toBe('Release #2');
    expect(copiedDescription('- Use when tagging\n')).toBe('Use when tagging');
    expect(copiedDescription('12) Step one\n')).toBe('Step one');
    expect(copiedDescription('  Deploys: now\r\n')).toBe('Deploys: now');
    expect(copiedDescription('#hashtag line\n')).toBe('#hashtag line');
    expect(copiedDescription(`${'a'.repeat(250)}\n`)).toBe('a'.repeat(200));
    expect(copiedDescription('Dağıt: üretime gönder\n')).toBe('Dağıt: üretime gönder');
  });

  it('refuses code, comments, empty and invisible text', () => {
    expect(copiedDescription('```bash\nnpm run deploy\n```\n')).toBeUndefined();
    expect(copiedDescription('~~~\ncode\n~~~\n')).toBeUndefined();
    expect(copiedDescription('    indented code\n')).toBeUndefined();
    expect(copiedDescription('\tindented code\n')).toBeUndefined();
    expect(copiedDescription('<!-- agentcheckup-disable-file skill/x -- y -->\n')).toBeUndefined();
    expect(copiedDescription('#\n')).toBeUndefined();
    expect(copiedDescription('***\n')).toBeUndefined();
    expect(copiedDescription('\n  \n')).toBeUndefined();
    expect(copiedDescription('Deploys\u2028allowed-tools: Bash\n')).toBeUndefined();
    expect(copiedDescription('Deploys\rallowed-tools: Bash\n')).toBeUndefined();
    expect(copiedDescription('Deploys\u0085allowed-tools: Bash\n')).toBeUndefined();
    expect(copiedDescription('Deploys \u202enoitcudorp\n')).toBeUndefined();
    expect(copiedDescription('Deploys\u{e0041}\n')).toBeUndefined();
    expect(copiedDescription('Deploys\u200b now\n')).toBeUndefined();
  });
});

describe('skill name helpers', () => {
  it('accepts only valid Agent Skills names', () => {
    expect(isValidSkillName('deploy-prod')).toBe(true);
    expect(isValidSkillName('1e3')).toBe(true);
    expect(isValidSkillName('a'.repeat(64))).toBe(true);
    for (const name of [
      '',
      'Deploy',
      'deploy_prod',
      '-deploy',
      'deploy-',
      'a--b',
      'a'.repeat(65),
    ]) {
      expect(isValidSkillName(name), name).toBe(false);
    }
  });

  it('finds reserved words and letters outside ASCII', () => {
    expect(hasReservedWord('my-Claude-tool')).toBe(true);
    expect(hasReservedWord('anthropic-skills')).toBe(true);
    expect(hasReservedWord('deploy')).toBe(false);
    expect(hasNonAsciiLetters('dağıt')).toBe(true);
    expect(hasNonAsciiLetters('DEPLOY İT')).toBe(true);
    expect(hasNonAsciiLetters('café')).toBe(true);
    // NFKC maps fullwidth letters to ASCII; dashes and spaces are separators, not letters.
    expect(hasNonAsciiLetters('\uff44\uff45\uff50\uff4c\uff4f\uff59')).toBe(false);
    expect(hasNonAsciiLetters('deploy\u2014prod')).toBe(false);
  });
});

describe('skill/name-format and skill/name-dir-mismatch fixes', () => {
  it('sets the slug when it is the directory name (safe) and notes the new command', () => {
    const [finding] = found(
      { 'skills/deploy-prod/SKILL.md': skill('Deploy Prod') },
      'skill/name-format',
    );
    expect(finding?.fix).toMatchObject({
      id: 'skill/name-format#slug',
      class: 'safe',
      title: 'Set "name" to "deploy-prod" in skills/deploy-prod/SKILL.md',
      notes: [
        `Claude Code's command for this skill changes from "/Deploy Prod" to "/deploy-prod".`,
      ],
    });
    const { text, result } = fixed(
      { 'skills/deploy-prod/SKILL.md': skill('Deploy Prod') },
      'skills/deploy-prod/SKILL.md',
    );
    expect(text).toBe(skill('deploy-prod'));
    // Both rules write the same edit; they merge.
    expect(result.applied.map((applied) => applied.fix.id).sort()).toEqual([
      'skill/name-dir-mismatch#slug',
      'skill/name-format#slug',
    ]);
    expect(result.verification.introduced).toEqual([]);
  });

  it('applies the slug fix with --write and leaves the directory name to review', () => {
    const files = { 'skills/release/SKILL.md': skill('Ship It') };
    const safeOnly = run(files, undefined, {}, ['safe']);
    expect(safeOnly.applied).toEqual([]);
    const [finding] = found(files, 'skill/name-format');
    expect(finding?.fix).toMatchObject({ id: 'skill/name-format#directory', class: 'review' });
    expect(fixed(files, 'skills/release/SKILL.md').text).toBe(skill('release'));
  });

  it('quotes YAML-ambiguous slugs and keeps the quote style', () => {
    expect(fixed({ 'skills/on/SKILL.md': skill('On') }, 'skills/on/SKILL.md').text).toBe(
      skill('"on"'),
    );
    expect(fixed({ 'skills/null/SKILL.md': skill('"Null"') }, 'skills/null/SKILL.md').text).toBe(
      skill('"null"'),
    );
    expect(fixed({ 'skills/1e3/SKILL.md': skill("'1E3'") }, 'skills/1e3/SKILL.md').text).toBe(
      skill("'1e3'"),
    );
    expect(fixed({ 'skills/yes/SKILL.md': skill('YES') }, 'skills/yes/SKILL.md').text).toBe(
      skill('"yes"'),
    );
  });

  it('fixes a name whose NFKC form is ASCII, and hidden characters', () => {
    const fullwidth = String.fromCodePoint(0xff24, 0xff45, 0xff50, 0xff4c, 0xff4f, 0xff59);
    expect(
      fixed({ 'skills/deploy/SKILL.md': skill(fullwidth) }, 'skills/deploy/SKILL.md').text,
    ).toBe(skill('deploy'));
    expect(
      fixed({ 'skills/deploy/SKILL.md': skill('"deploy\\u200B"') }, 'skills/deploy/SKILL.md').text,
    ).toBe(skill('"deploy"'));
  });

  it('leaves non-ASCII names, reserved words and invalid directories to the user', () => {
    const cases: [FileMap, string][] = [
      [
        { 'skills/dagit/SKILL.md': skill('dağıt') },
        'rename the skill with lowercase ASCII letters, digits and hyphens, and rename its directory to match',
      ],
      [
        { 'skills/claude-helper/SKILL.md': skill('Claude Helper') },
        'choose a name without "anthropic" or "claude", and rename the directory to match',
      ],
      [
        { 'skills/Deploy_Prod/SKILL.md': skill('Deploy_Prod') },
        'rename the directory to "deploy-prod" and set "name" to match',
      ],
      [{ 'SKILL.md': skill('Deploy Prod') }, 'set "name" to "deploy-prod"'],
      [
        {
          'plugins/dev/SKILL.md': skill('Dev Tools'),
          'plugins/dev/.cursor-plugin/plugin.json': '{"name": "dev"}',
        },
        'set "name" to "dev-tools"',
      ],
    ];
    for (const [files, guidance] of cases) {
      const result = run(files);
      const findings = result.before.findings.filter(
        (finding) => finding.ruleId === 'skill/name-format',
      );
      expect(findings, guidance).toHaveLength(1);
      expect(findings[0]?.fix).toBeUndefined();
      expect(findings[0]?.guidance).toBe(guidance);
      expect(result.files).toEqual([]);
    }
  });

  it('never renames a skill reached through a symlink or with symlink aliases', () => {
    const aliased = run(
      {
        '.agents/skills/deploy-prod/SKILL.md': skill('Deploy Prod'),
        '.github/skills/deploy/SKILL.md': skill('Deploy Prod'),
      },
      undefined,
      { symlinks: { '.github/skills/deploy/SKILL.md': '.agents/skills/deploy-prod/SKILL.md' } },
    );
    const names = aliased.before.findings.filter((finding) =>
      finding.ruleId.startsWith('skill/name'),
    );
    expect(names.length).toBeGreaterThan(1);
    for (const finding of names) expect(finding.fix).toBeUndefined();
    expect(aliased.files).toEqual([]);

    const linked = run({ '.claude/skills/deploy-prod/SKILL.md': skill('Deploy Prod') }, undefined, {
      symlinks: { '.claude/skills/deploy-prod/SKILL.md': 'shared/deploy/SKILL.md' },
    });
    for (const finding of linked.before.findings) expect(finding.fix).toBeUndefined();
  });

  it('never fixes a suppressed finding', () => {
    const files = {
      'skills/deploy-prod/SKILL.md': `---\n# agentcheckup-disable-file skill/name-format, skill/name-dir-mismatch -- display name\nname: Deploy Prod\n${DESC}\n---\n`,
    };
    const result = run(files);
    expect(result.before.findings.some((finding) => finding.suppressed !== undefined)).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.files).toEqual([]);
  });

  it('leaves a name that is not text to the user', () => {
    const [finding] = found(
      { 'skills/deploy/SKILL.md': `---\nname: [deploy]\n${DESC}\n---\n` },
      'skill/name-format',
    );
    expect(finding?.fix).toBeUndefined();
    expect(finding?.guidance).toBe('write "name" as one line of text, such as the directory name');
  });
});

describe('skill/name-missing fix', () => {
  it('adds the directory name first', () => {
    expect(
      fixed({ 'skills/deploy/SKILL.md': `---\n${DESC}\n---\n` }, 'skills/deploy/SKILL.md').text,
    ).toBe(`---\nname: deploy\n${DESC}\n---\n`);
    expect(
      fixed(
        { 'skills/deploy/SKILL.md': `---\nname: "  "\n${DESC}\n---\n` },
        'skills/deploy/SKILL.md',
      ).text,
    ).toBe(`---\nname: "deploy"\n${DESC}\n---\n`);
  });

  it('does not invent a name for an invalid or reserved directory', () => {
    for (const path of ['skills/Deploy_Prod/SKILL.md', 'skills/claude-tools/SKILL.md']) {
      const [finding] = found({ [path]: `---\n${DESC}\n---\n` }, 'skill/name-missing');
      expect(finding?.fix, path).toBeUndefined();
      expect(finding?.guidance).toBe(
        'add a "name" of lowercase letters, digits and hyphens, and rename the directory to match',
      );
    }
  });
});

describe('skill/frontmatter-bom fix', () => {
  const bom = (text: string) =>
    new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);

  it('re-encodes without the mark', () => {
    const result = run(
      { 'skills/deploy/SKILL.md': bom(skill('deploy')) },
      'skill/frontmatter-bom',
      {},
      ['safe'],
    );
    expect(result.applied.map((applied) => applied.fix.id)).toEqual([
      'skill/frontmatter-bom#remove-bom',
    ]);
    expect([...(result.snapshot.files[0]?.bytes.slice(0, 3) ?? [])]).toEqual([0x2d, 0x2d, 0x2d]);
  });

  it('does not edit a file reached through a symlink', () => {
    const [finding] = found(
      { '.claude/skills/deploy/SKILL.md': bom(skill('deploy')) },
      'skill/frontmatter-bom',
      { symlinks: { '.claude/skills/deploy/SKILL.md': 'shared/deploy/SKILL.md' } },
    );
    expect(finding?.fix).toBeUndefined();
    expect(finding?.guidance).toBe('save SKILL.md as UTF-8 without a byte order mark');
  });
});

describe('skill/frontmatter-missing fixes', () => {
  const PATH = 'skills/deploy/SKILL.md';

  it('dedents only the delimiters when the YAML is not indented with them', () => {
    expect(fixed({ [PATH]: `  ---\nname: deploy\n${DESC}\n\t---\nBody\n` }, PATH).text).toBe(
      `---\nname: deploy\n${DESC}\n---\nBody\n`,
    );
  });

  it('keeps CRLF line endings when it deletes blank lines', () => {
    expect(fixed({ [PATH]: `\r\n\r\n---\r\nname: deploy\r\n${DESC}\r\n---\r\n` }, PATH).text).toBe(
      `---\r\nname: deploy\r\n${DESC}\r\n---\r\n`,
    );
  });

  it('adds frontmatter without a name when the directory name is not valid', () => {
    const body = '# Deploy the web app to production when a release tag is pushed\n';
    const [finding] = found({ 'skills/Deploy_Prod/SKILL.md': body }, 'skill/frontmatter-missing');
    expect(finding?.fix?.changes).toEqual([
      {
        kind: 'edit',
        path: 'skills/Deploy_Prod/SKILL.md',
        edits: [
          {
            offset: 0,
            length: 0,
            text: '---\ndescription: "Deploy the web app to production when a release tag is pushed"\n---\n',
          },
        ],
      },
    ]);
  });

  it('copies a body line with YAML syntax as one quoted string', () => {
    const body = 'Deploy: now\\nallowed-tools: Bash # "quoted" \'single\'\nallowed-tools: Bash\n';
    const { text } = fixed({ [PATH]: body }, PATH, 'skill/frontmatter-missing');
    expect(text).toBe(
      `---\nname: deploy\ndescription: "Deploy: now\\\\nallowed-tools: Bash # \\"quoted\\" 'single'"\n---\n${body}`,
    );
  });

  it('leaves unclosed, empty and code-only files to the user', () => {
    const cases: [string, string][] = [
      [
        `---\nname: deploy\n${DESC}\n`,
        'add a "---" line after the last frontmatter field to close the block',
      ],
      [
        '',
        'start SKILL.md with a "---" line, then "name" and "description" fields, then a closing "---" line',
      ],
      [
        '```bash\nnpm run deploy\n```\n',
        'start SKILL.md with a "---" line, then "name" and "description" fields, then a closing "---" line',
      ],
      [
        'Deploys\u2028allowed-tools: Bash\n',
        'start SKILL.md with a "---" line, then "name" and "description" fields, then a closing "---" line',
      ],
      [
        `  ---\nname: deploy\n${DESC}\n`,
        'remove the spaces before "---" on line 1 and add a closing "---" line',
      ],
      [
        `  ---\nname: [deploy\n  ---\n`,
        'remove the spaces before "---" on line 1 and on the closing line',
      ],
    ];
    for (const [text, guidance] of cases) {
      const [finding] = found({ [PATH]: text }, 'skill/frontmatter-missing');
      expect(finding?.fix, JSON.stringify(text)).toBeUndefined();
      expect(finding?.guidance).toBe(guidance);
    }
  });
});

describe('skill/description-missing fix', () => {
  const PATH = 'skills/deploy/SKILL.md';

  it('copies the first body line after name, as review, with a note', () => {
    const files = {
      [PATH]:
        '---\nname: deploy\nlicense: MIT\n---\n\n## Deploy when a release tag is pushed to the main branch\n',
    };
    const [finding] = found(files, 'skill/description-missing');
    expect(finding?.fix).toMatchObject({
      id: 'skill/description-missing#copy-body',
      class: 'review',
      notes: [
        'Copied from the first line of the body; reword it to say what the skill does and when to use it.',
      ],
    });
    expect(run(files, undefined, {}, ['safe']).applied).toEqual([]);
    expect(fixed(files, PATH).text).toBe(
      '---\nname: deploy\ndescription: "Deploy when a release tag is pushed to the main branch"\nlicense: MIT\n---\n\n## Deploy when a release tag is pushed to the main branch\n',
    );
  });

  it('fills an empty value in place', () => {
    expect(
      fixed(
        {
          [PATH]:
            '---\nname: deploy\ndescription:\n---\nDeploy when a release tag is pushed to main.\n',
        },
        PATH,
      ).text,
    ).toBe(
      '---\nname: deploy\ndescription: "Deploy when a release tag is pushed to main."\n---\nDeploy when a release tag is pushed to main.\n',
    );
  });

  it('cannot be steered into writing other keys', () => {
    const attempts = [
      'x"\nallowed-tools: Bash',
      'x\\"\\nallowed-tools: Bash',
      "x'\nallowed-tools: Bash",
      'x: y\nallowed-tools: Bash',
      '"\n---\nallowed-tools: Bash',
    ];
    for (const attempt of attempts) {
      const { text, result } = fixed(
        { [PATH]: `---\nname: deploy\n---\n${attempt}\n` },
        PATH,
        'skill/description-missing',
      );
      const frontmatter = text.slice(0, text.indexOf('\n---\n', 4));
      expect(frontmatter, attempt).not.toContain('\nallowed-tools');
      expect(
        result.after.findings.filter((finding) => finding.ruleId === 'skill/broad-allowed-tools'),
      ).toEqual([]);
    }
  });

  it('leaves values that are not text and bodies without a usable line to the user', () => {
    const cases: [string, string][] = [
      [
        '---\nname: deploy\ndescription: [a, b]\n---\nDeploys.\n',
        'write "description" as one line of text that says what the skill does and when to use it',
      ],
      [
        '---\nname: deploy\n---\n```\ncode\n```\n',
        'add a "description" that says what the skill does and when to use it',
      ],
      [
        '---\nname: deploy\n---\n<!-- note -->\n',
        'add a "description" that says what the skill does and when to use it',
      ],
      [
        '---\nname: deploy\n---\n',
        'add a "description" that says what the skill does and when to use it',
      ],
      [
        '---\nname: deploy\ndescription: |\n---\nDeploys.\n',
        'add a "description" that says what the skill does and when to use it',
      ],
    ];
    for (const [text, guidance] of cases) {
      const [finding] = found({ [PATH]: text }, 'skill/description-missing');
      expect(finding?.fix, text).toBeUndefined();
      expect(finding?.guidance).toBe(guidance);
    }
  });
});

describe('skill/broken-reference fixes', () => {
  const PATH = 'skills/deploy/SKILL.md';
  const files = (body: string, extra: FileMap = {}): FileMap => ({
    [PATH]: `---\nname: deploy\n${DESC}\n---\n${body}\n`,
    'skills/deploy/refs/guide.md': 'g',
    ...extra,
  });

  it('replaces backslashes in angle brackets, keeping the fragment', () => {
    expect(fixed(files('[g](<refs\\guide.md>) and [x](refs\\guide.md#a\\b)'), PATH).text).toBe(
      `---\nname: deploy\n${DESC}\n---\n[g](<refs/guide.md>) and [x](refs/guide.md#a\\b)\n`,
    );
  });

  it('does not edit the label or title when they repeat the path', () => {
    expect(fixed(files('[refs\\guide.md](refs\\guide.md "refs\\guide.md")'), PATH).text).toBe(
      `---\nname: deploy\n${DESC}\n---\n[refs\\guide.md](refs/guide.md "refs\\guide.md")\n`,
    );
  });

  it('leaves destinations written with escapes or percent-encoding to the user', () => {
    for (const body of [
      '[g](refs%5Cguide.md)',
      '[g](refs\\\\guide.md)',
      '[g](refs\\guide&#46;md)',
    ]) {
      const findings = found(files(body), 'skill/broken-reference');
      for (const finding of findings) {
        expect(finding.fix, body).toBeUndefined();
        expect(finding.guidance).toMatch(/^change the link to /);
      }
    }
  });

  it('leaves ambiguous letter case and links outside the skill to the user', () => {
    const [ambiguous] = found(
      files('[g](refs/GUIDE.md)', { 'skills/deploy/refs/Guide.md': 'G' }),
      'skill/broken-reference',
    );
    expect(ambiguous?.fix).toBeUndefined();
    const [missing] = found(files('[g](refs/missing.md)'), 'skill/broken-reference');
    expect(missing?.fix).toBeUndefined();
    expect(missing?.guidance).toBe('create "skills/deploy/refs/missing.md" or correct the link');
    const [outside] = found(
      files('[g](../shared/x.md)', { 'skills/shared/x.md': 'x' }),
      'skill/broken-reference',
    );
    expect(outside?.fix).toBeUndefined();
    expect(outside?.guidance).toBe(
      'move the file into the skill directory and link to it relative to SKILL.md',
    );
  });
});

describe('skill/field-type fix', () => {
  const PATH = 'skills/deploy/SKILL.md';
  const withTools = (tools: string) => ({
    [PATH]: `---\nname: deploy\n${DESC}\nallowed-tools: ${tools}\n---\n`,
  });

  it('joins a flow list', () => {
    expect(fixed(withTools('[Read, Grep]'), PATH).text).toBe(
      `---\nname: deploy\n${DESC}\nallowed-tools: Read Grep\n---\n`,
    );
  });

  it('leaves lists with spaces, comments or other items to the user', () => {
    for (const tools of [
      '\n  - Read\n  - Bash(git status *)',
      '\n  - Read # needed\n  - Grep',
      '[Read, 3]',
    ]) {
      const findings = found(withTools(tools), 'skill/field-type');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.fix, tools).toBeUndefined();
      expect(findings[0]?.guidance).toMatch(/^write "allowed-tools" as one line/);
    }
  });
});

describe('skill/yaml-portability fix', () => {
  const PATH = 'skills/deploy/SKILL.md';

  it('quotes a top-level YAML 1.1 boolean and offers true or false in -i', () => {
    const files = { [PATH]: `---\nname: deploy\n${DESC}\nlicense: off\n---\n` };
    const [finding] = found(files, 'skill/yaml-portability');
    expect(finding?.fix).toMatchObject({
      id: 'skill/yaml-portability#quote',
      class: 'review',
      alternatives: [
        {
          id: 'skill/yaml-portability#boolean',
          class: 'review',
          title: `Write "off" as false in ${PATH}`,
        },
      ],
    });
    expect(fixed(files, PATH).text).toBe(`---\nname: deploy\n${DESC}\nlicense: "off"\n---\n`);
  });

  it('leaves anchors, aliases, tags and empty values to the user', () => {
    const findings = found(
      {
        [PATH]: `---\nname: deploy\n${DESC}\nmetadata:\n  a: &x one\n  b: *x\n  c: !!str two\n  d:\n---\n`,
      },
      'skill/yaml-portability',
    );
    expect(findings.map((finding) => [finding.fix, finding.guidance])).toEqual([
      [undefined, 'remove the anchor and write out the values that refer to it'],
      [undefined, 'replace the alias with the value it refers to'],
      [undefined, 'remove the tag'],
      [undefined, 'remove the key or give it a value'],
    ]);
  });
});
