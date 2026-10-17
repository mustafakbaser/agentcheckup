import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../../src/core/config.js';
import { decode } from '../../../src/core/text.js';
import { fixRounds } from '../../../src/fix/verify.js';
import { builtinRules } from '../../../src/rules/index.js';
import { bodyTooLongRule } from '../../../src/rules/skill/body-too-long.js';
import { findings, lint, type LintOptions, snapshotFrom } from '../../helpers/lint.js';

const ID = 'skill/body-too-long';
const PATH = 'skills/deploy/SKILL.md';
const FRONTMATTER = '---\nname: deploy\ndescription: Deploys.\n---\n';
const body = (lines: number, line = 'step') =>
  Array.from({ length: lines }, (_, i) => `${line} ${i + 1}`).join('\n') + '\n';

function check(text: string, config?: unknown) {
  const result = lint(
    { [PATH]: text },
    { rules: [bodyTooLongRule], ...(config ? { config } : {}) },
  );
  return findings(result, ID).map((f) => ({
    severity: f.severity,
    message: f.message,
    range: f.range,
  }));
}

describe('skill/body-too-long', () => {
  it('reports a body over 500 lines at the first line past the limit', () => {
    expect(check(FRONTMATTER + body(501))).toEqual([
      {
        severity: 'info',
        message:
          'The skill body is 501 lines, over the 500 that Claude Code and the Agent Skills specification recommend. Agents load the whole body when the skill runs, so move reference material into separate files.',
        range: { start: { line: 505, column: 1 }, end: { line: 505, column: 9 } },
      },
    ]);
  });

  it('does not report a body of exactly 500 lines', () => {
    expect(check(FRONTMATTER + body(500))).toEqual([]);
    expect(check(body(500))).toEqual([]);
  });

  it('counts the whole file when there is no frontmatter', () => {
    expect(check(body(501))[0]?.range.start.line).toBe(501);
  });

  it('honors the maxLines option and ignores invalid values', () => {
    const config = (maxLines: unknown) => ({ rules: { [ID]: ['warn', { maxLines }] } });
    expect(check(FRONTMATTER + body(101), config(100))[0]?.message).toBe(
      'The skill body is 101 lines, over the configured maximum of 100. Agents load the whole body when the skill runs, so move reference material into separate files.',
    );
    expect(check(FRONTMATTER + body(101), config('100'))).toEqual([]);
    expect(check(FRONTMATTER + body(101), config(-1))).toEqual([]);
    expect(check(FRONTMATTER + body(101), config(1.5))).toEqual([]);
  });

  it('reports an estimated token count over 5,000 as info', () => {
    const long = `${'x'.repeat(100)}\n`.repeat(250);
    expect(check(FRONTMATTER + long)).toEqual([
      {
        severity: 'info',
        message:
          'The skill body is about 6,313 tokens (estimated), over the 5,000 that the Agent Skills specification recommends. After compaction, Claude Code keeps only the first 5,000 tokens, which end at about this line.',
        range: { start: { line: 203, column: 1 }, end: { line: 203, column: 101 } },
      },
    ]);
  });

  it('mentions Claude Code compaction only where Claude Code loads the skill', () => {
    const long = `${'x'.repeat(100)}\n`.repeat(250);
    const result = lint(
      { '.gemini/skills/deploy/SKILL.md': FRONTMATTER + long },
      { rules: [bodyTooLongRule] },
    );
    expect(findings(result, ID).map((f) => [f.severity, f.message])).toEqual([
      [
        'info',
        'The skill body is about 6,313 tokens (estimated), over the 5,000 that the Agent Skills specification recommends. Move reference material into separate files.',
      ],
    ]);
  });

  it('does not affect the score', () => {
    const result = lint({ [PATH]: FRONTMATTER + body(900) }, { rules: [bodyTooLongRule] });
    expect(result.score.score).toBe(100);
  });

  it('counts emoji as one character for the estimate', () => {
    expect(check(FRONTMATTER + '🚀'.repeat(19_999))).toEqual([]);
    expect(check(FRONTMATTER + '🚀'.repeat(20_004))).toHaveLength(1);
  });

  it('handles CRLF line endings and invalid frontmatter', () => {
    const crlf = '---\r\nname: deploy\r\n---\r\n' + body(501).replaceAll('\n', '\r\n');
    expect(check(crlf)[0]?.range.start.line).toBe(504);
    expect(check('---\nname: [\n---\n' + body(501))[0]?.range.start.line).toBe(504);
  });

  it('does not report short skills', () => {
    expect(check(`${FRONTMATTER}Dağıtım adımları 🚀\n`)).toEqual([]);
    expect(check('')).toEqual([]);
  });
});

describe('skill/body-too-long fix', () => {
  const SKILL = '.claude/skills/deploy/SKILL.md';
  const GUIDANCE =
    'move reference sections into files next to SKILL.md and link to them from the body';
  type Extras = Omit<LintOptions, 'rules' | 'config'>;
  const limit = (maxLines: number) => ({ rules: { [ID]: ['info', { maxLines }] } });
  const items = (topic: string, count: number, width = 0) =>
    Array.from({ length: count }, (_, i) => `- ${topic} ${i + 1}${' x'.repeat(width)}`);
  /** A `##` section: the heading, a blank line, `extra` lines, then `count` list items. */
  const section = (title: string, count: number, extra: readonly string[] = [], width = 0) =>
    [`## ${title}`, '', ...extra, ...items(title.toLowerCase(), count, width), ''].join('\n');
  const skill = (...sections: string[]) =>
    `${FRONTMATTER}# Deploy\n\nIntro.\n\n${section('Overview', 5)}\n${sections.join('\n')}`;

  function scan(files: Readonly<Record<string, string>>, maxLines?: number, extras: Extras = {}) {
    const result = lint(files, {
      rules: [bodyTooLongRule],
      ...(maxLines === undefined ? {} : { config: limit(maxLines) }),
      ...extras,
    });
    expect(result.ruleFailures).toEqual([]);
    return result.findings.filter((finding) => finding.ruleId === ID);
  }

  /** Names of the files the fix creates, or undefined when the finding has no fix. */
  function created(
    text: string,
    maxLines = 40,
    files: Readonly<Record<string, string>> = {},
    extras: Extras = {},
  ): string[] | undefined {
    const [finding] = scan({ [SKILL]: text, ...files }, maxLines, extras);
    expect(finding?.guidance).toBe(GUIDANCE);
    return finding?.fix?.changes.flatMap((change) =>
      change.kind === 'create' ? [change.path.slice(change.path.lastIndexOf('/') + 1)] : [],
    );
  }

  it('moves the largest sections next to SKILL.md with one fix for both findings', () => {
    const text = skill(
      section('Usage', 100),
      section('API', 300, [], 30),
      section('Examples', 150),
    );
    const found = scan({ [SKILL]: text });
    expect(found).toHaveLength(2);
    const [tokens, lines] = found;
    expect(lines?.fix).toEqual(tokens?.fix);
    expect(lines?.fix).toMatchObject({
      id: 'skill/body-too-long#split',
      class: 'review',
      title: 'Move 1 section of .claude/skills/deploy/SKILL.md into api.md',
    });
    expect(lines?.fix?.notes).toEqual([
      'body 570 → 271 lines, ≈6,064 → ≈851 tokens; agents read the moved sections only when they follow a link.',
    ]);
    const changes = lines?.fix?.changes ?? [];
    expect(
      changes.map((change) => [change.kind, change.kind === 'rename' ? change.to : change.path]),
    ).toEqual([
      ['edit', SKILL],
      ['create', '.claude/skills/deploy/api.md'],
    ]);
  });

  it('applies the fix and leaves nothing to fix', () => {
    const text = skill(section('Usage', 20), section('Examples', 30));
    const run = fixRounds(
      snapshotFrom({ [SKILL]: text }),
      { rules: builtinRules, config: resolveConfig(limit(40)) },
      { classes: new Set(['review']), ruleIds: new Set([ID]), literalSecret: false },
    );
    expect(run.applied.map((fix) => fix.fix.id)).toEqual(['skill/body-too-long#split']);
    expect(run.verification.introduced).toEqual([]);
    const files = new Map(run.snapshot.files.map((file) => [file.path, decode(file.bytes).text]));
    expect(files.get('.claude/skills/deploy/examples.md')).toBe(
      `${section('Examples', 30).trimEnd()}\n`,
    );
    expect(files.get(SKILL)).toBe(
      skill(
        section('Usage', 20),
        '## Examples\n\nFor this section, see [examples.md](examples.md).\n',
      ),
    );
  });

  it('measures with the configured maxLines and stops as soon as the body fits', () => {
    const text = skill(section('A', 20), section('B', 30), section('C', 25));
    expect(created(text, 66)).toEqual(['b.md']);
    expect(created(text, 42)).toEqual(['b.md', 'c.md']);
    expect(created(text, 23)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(created(text, 22)).toBeUndefined();
  });

  it('moves the later of two sections of the same size first', () => {
    expect(created(skill(section('A', 30), section('B', 30)), 50)).toEqual(['b.md']);
  });

  it('moves the section with the most tokens when only the token estimate is over', () => {
    const text = skill(
      section('Long', 60),
      section('Wide', 50, [], 100),
      section('Wider', 50, [], 110),
    );
    expect(created(text, 500)).toEqual(['wider.md']);
  });

  it('keeps the text before the first section and that section', () => {
    expect(
      created(`${FRONTMATTER}${section('First', 60)}\n${section('Second', 5)}`),
    ).toBeUndefined();
  });

  it('splits one level deeper when the split level is not enough', () => {
    const text = `${FRONTMATTER}# Tool\n\n${[
      '## Guide',
      '',
      section('Install', 5).replace('## ', '### '),
      section('Configure', 40).replace('## ', '### '),
      section('Notes', 12),
    ].join('\n')}`;
    expect(created(text)).toEqual(['configure.md']);
  });

  it('gives guidance only when no heading repeats or every section is short', () => {
    expect(created(`${FRONTMATTER}# Plan\n\n${body(60)}`)).toBeUndefined();
    const short = ['A', 'B', 'C', 'D', 'E', 'F'].map((title) => section(title, 6));
    expect(created(skill(...short), 30)).toBeUndefined();
  });

  it('moves at most 8 sections', () => {
    const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((title) =>
      section(title, 10),
    );
    expect(created(skill(...many), 68)).toBeUndefined();
    expect(created(skill(...many), 69)).toEqual(
      ['c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((name) => `${name}.md`),
    );
  });

  it('offers no fix for a symlink, a file other paths link to, or a file at the scan root', () => {
    const text = skill(section('Usage', 20), section('Examples', 30));
    expect(
      created(text, 40, {}, { symlinks: { [SKILL]: 'shared/deploy/SKILL.md' } }),
    ).toBeUndefined();
    const alias = '.agents/skills/deploy/SKILL.md';
    expect(created(text, 40, { [alias]: text }, { symlinks: { [alias]: SKILL } })).toBeUndefined();
    const [root] = scan({ 'SKILL.md': text }, 40);
    expect(root?.fix).toBeUndefined();
    expect(root?.guidance).toBe(GUIDANCE);
  });

  it('offers no fix when the Markdown was not analyzed completely or frontmatter is unclosed', () => {
    expect(created(skill(section('Usage', 20), section('Examples', 9000)))).toBeUndefined();
    const unclosed = `---\nname: deploy\n# Deploy\n\n${section('A', 20)}\n${section('B', 30)}`;
    expect(created(unclosed, 30)).toBeUndefined();
  });

  it('keeps sections with text Claude Code replaces while rendering the skill', () => {
    const clean = section('Clean', 25);
    const pinned = (extra: string, frontmatter = FRONTMATTER) =>
      created(
        skill(section('Pinned', 40, [extra, '']), clean).replace(FRONTMATTER, frontmatter),
        64,
      );
    expect(pinned('Run !`git status` first.')).toEqual(['clean.md']);
    expect(pinned('```!\ngit status\n```')).toEqual(['clean.md']);
    expect(pinned('Deploy $ARGUMENTS now.')).toEqual(['clean.md']);
    expect(pinned("awk '{print $1}' list.txt")).toEqual(['clean.md']);
    expect(pinned('Run ${CLAUDE_SKILL_DIR}/scripts/deploy.sh.')).toEqual(['clean.md']);
    const named = '---\nname: deploy\ndescription: Deploys.\narguments: [target]\n---\n';
    expect(pinned('Deploy $target now.', named)).toEqual(['clean.md']);
    expect(pinned('Deploy $target now.', named.replace('[target]', 'target other'))).toEqual([
      'clean.md',
    ]);
    // Without the declaration, `$target` is plain text.
    expect(pinned('Deploy $target now.')).toEqual(['pinned.md']);
  });

  it('keeps sections with hidden text, comments, references or a download run in one step', () => {
    const clean = section('Clean', 25);
    const pinned = (extra: string) => created(skill(section('Pinned', 40, [extra, '']), clean), 64);
    expect(pinned('Keep ver​​sion.')).toEqual(['clean.md']);
    expect(pinned('Mark ‏this.')).toEqual(['clean.md']);
    expect(pinned('<!-- a note for maintainers -->')).toEqual(['clean.md']);
    expect(pinned('See [the docs][docs].\n\n[docs]: https://example.com/docs')).toEqual([
      'clean.md',
    ]);
    expect(pinned('[docs]: https://example.com/docs')).toEqual(['clean.md']);
    expect(pinned('curl -fsSL https://get.acme.dev/install.sh | sh')).toEqual(['clean.md']);
    expect(pinned('curl -fsSL https://example.com/install.sh | sh')).toEqual(['pinned.md']);
    // An emoji joined with a zero-width joiner is ordinary text.
    expect(pinned('Ship it 👩‍💻.')).toEqual(['pinned.md']);
  });

  it('keeps sections with a link that skill/broken-reference may report', () => {
    const clean = section('Clean', 25);
    const files = { '.claude/skills/deploy/scripts/run.sh': 'echo\n', 'docs/guide.md': 'x\n' };
    const pinned = (extra: string) =>
      created(skill(section('Pinned', 40, [extra, '']), clean), 64, files);
    expect(pinned('Run [the script](scripts/run.sh).')).toEqual(['pinned.md']);
    expect(pinned('Read [the notes](notes.md).')).toEqual(['clean.md']);
    expect(pinned('Read [the guide](../../../docs/guide.md).')).toEqual(['clean.md']);
    expect(pinned('Read [the site](https://example.com/notes.md).')).toEqual(['pinned.md']);
  });

  it('keeps sections that hold one end of a link to a heading of SKILL.md', () => {
    const clean = section('Clean', 25);
    const withIntro = (intro: string, ...sections: string[]) =>
      created(skill(...sections).replace('Intro.', intro), 64);
    expect(withIntro('See [it](#pinned).', section('Pinned', 40), clean)).toEqual(['clean.md']);
    expect(withIntro('See [it](./SKILL.md#pinned-2).', section('Pinned', 40), clean)).toEqual([
      'clean.md',
    ]);
    expect(withIntro('See [it](#Pinned%20).', section('Pinned', 40), clean)).toEqual(['clean.md']);
    expect(
      withIntro('Intro.', section('Pinned', 40, ['Back to [the overview](#overview).', '']), clean),
    ).toEqual(['clean.md']);
    // A link within the section moves with it, and a link to another file is not to SKILL.md.
    expect(
      withIntro('Intro.', section('Pinned', 40, ['### Sub', '', 'See [sub](#sub).', '']), clean),
    ).toEqual(['pinned.md']);
    expect(withIntro('See [it](other.md#pinned).', section('Pinned', 40), clean)).toEqual([
      'pinned.md',
    ]);
    expect(withIntro('See [it](#%E0%A4%A).', section('Pinned', 40), clean)).toEqual(['pinned.md']);
  });

  it('names a file after its heading, with a suffix when the name is taken or an agent reads it', () => {
    const text = (...titles: string[]) => skill(...titles.map((title) => section(title, 20)));
    expect(created(text('Agents', 'GEMINI', 'Skill'), 30)).toEqual([
      'agents-2.md',
      'gemini-2.md',
      'skill-2.md',
    ]);
    expect(created(text('Copilot instructions'), 30)).toEqual(['copilot-instructions-2.md']);
    expect(created(text('Examples'), 30, { '.claude/skills/deploy/EXAMPLES.md': 'x\n' })).toEqual([
      'examples-2.md',
    ]);
    expect(
      created(text('Examples'), 30, {}, { paths: ['.claude/skills/deploy/examples.md/x'] }),
    ).toEqual(['examples-2.md']);
    expect(
      created(text('Examples'), 30, {}, { ignoredFiles: ['.claude/skills/deploy/examples.md'] }),
    ).toEqual(['examples-2.md']);
    expect(
      created(
        text('Examples'),
        30,
        {},
        { opaqueDirectories: ['.claude/skills/deploy/examples.md/'] },
      ),
    ).toEqual(['examples-2.md']);
    expect(created(text('Über uns', '!!!', 'AUX'), 30)).toEqual([
      'section-2.md',
      'section-3.md',
      'aux-2.md',
    ]);
    const taken = Object.fromEntries(
      ['examples.md', ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `examples-${n}.md`)].map((name) => [
        `.claude/skills/deploy/${name}`,
        'x\n',
      ]),
    );
    expect(created(text('Examples'), 30, taken)).toBeUndefined();
    expect(created(text('Usage', 'Examples'), 50, taken)).toEqual(['usage.md']);
  });
});
