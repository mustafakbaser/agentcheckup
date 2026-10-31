/**
 * The `#narrow` fix of skill/broad-allowed-tools: what it writes, the notes it prints, and the
 * inputs it must leave alone. Golden before/after cases are in fix-fixtures.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { compareWithBaseline, GATE_CLASSES } from '../../../src/core/baseline.js';
import { decode } from '../../../src/core/text.js';
import type { Finding } from '../../../src/core/types.js';
import { fixRounds } from '../../../src/fix/verify.js';
import { builtinRules } from '../../../src/rules/index.js';
import { broadAllowedToolsRule } from '../../../src/rules/skill/broad-allowed-tools.js';
import {
  type FileMap,
  findings,
  lint,
  snapshotFrom,
  type SnapshotExtras,
} from '../../helpers/lint.js';

const ID = 'skill/broad-allowed-tools';
const PATH = '.claude/skills/pdf/SKILL.md';
const FENCE = '```';

const skill = (allowedTools: string, body: string) =>
  `---\nname: pdf\ndescription: Converts PDF files. Use when the user asks to convert a PDF.\n${allowedTools}---\n\n${body}`;

const BODY = `${FENCE}bash\nuv run scripts/convert.py --in a.pdf\ngit status --short\n${FENCE}\n`;

function reported(files: FileMap, extras: SnapshotExtras = {}): Finding[] {
  const result = lint(files, { rules: [broadAllowedToolsRule], ...extras });
  expect(findings(result, ID).length).toBe(result.findings.length);
  return result.findings.filter((finding) => finding.ruleId === ID);
}

/** The text of `path` after applying this rule's fixes, and the run. */
function fixed(files: FileMap, path = PATH) {
  const run = fixRounds(
    snapshotFrom(files),
    { rules: builtinRules },
    { classes: new Set(['review']), ruleIds: new Set([ID]), literalSecret: false },
  );
  const file = run.snapshot.files.find((candidate) => candidate.path === path);
  return { text: file === undefined ? undefined : decode(file.bytes).text, run };
}

describe('skill/broad-allowed-tools#narrow', () => {
  it('replaces Bash with the derived rules and lists where each comes from', () => {
    const files = { [PATH]: skill('allowed-tools: Read Bash Write\n', BODY) };
    const [finding] = reported(files);
    expect(finding?.fix).toEqual({
      id: 'skill/broad-allowed-tools#narrow',
      class: 'review',
      title: `Replace "Bash" in "allowed-tools" of ${PATH} with 2 rules for the commands the skill shows, and remove "Write"`,
      changes: [expect.objectContaining({ kind: 'edit', path: PATH })],
      notes: [
        'Bash(uv run scripts/convert.py *)  ← SKILL.md:8 uv run scripts/convert.py --in a.pdf',
        'Bash(git status *)  ← SKILL.md:9 git status --short',
        "Claude Code asks before it runs any other command during this skill's turn.",
        "Claude Code asks before it writes files during this skill's turn.",
      ],
    });
    expect(finding?.guidance).toBeDefined();
    const { text, run } = fixed(files);
    expect(text).toBe(
      skill('allowed-tools: "Read Bash(uv run scripts/convert.py *) Bash(git status *)"\n', BODY),
    );
    expect(run.applied).toHaveLength(1);
    expect(run.verification.introduced).toEqual([]);
    // Narrowing trips no gate: every added rule is covered by the Bash it replaces.
    expect(run.applied[0]?.effects.filter((effect) => effect.kind === 'gate')).toEqual([]);
  });

  it('keeps narrow entries, the separator and the quote style', () => {
    const files = {
      [PATH]: skill(
        "allowed-tools: 'Read, Bash(*), Bash(npm ci)'\n",
        `${FENCE}sh\nmake test\n${FENCE}\n`,
      ),
    };
    expect(fixed(files).text).toBe(
      skill(
        "allowed-tools: 'Read, Bash(make test), Bash(npm ci)'\n",
        `${FENCE}sh\nmake test\n${FENCE}\n`,
      ),
    );
  });

  it('replaces the first broad Bash entry and removes the others', () => {
    const files = {
      [PATH]: skill(
        'allowed-tools: Bash Grep Bash(*) PowerShell Edit\n',
        `${FENCE}sh\nmake test\n${FENCE}\n`,
      ),
    };
    const [finding] = reported(files);
    expect(finding?.fix?.title).toBe(
      `Replace "Bash" and "Bash(*)" in "allowed-tools" of ${PATH} with 1 rule for the commands the skill shows, and remove "PowerShell" and "Edit"`,
    );
    expect(finding?.fix?.notes?.at(-1)).toBe(
      "Claude Code asks before it runs PowerShell commands and edits files during this skill's turn.",
    );
    expect(fixed(files).text).toContain('allowed-tools: "Bash(make test) Grep"\n');
  });

  it('keeps a composite list item composite', () => {
    const files = {
      [PATH]: skill(
        'allowed-tools:\n  - Read, Bash\n  - Write\n',
        `${FENCE}sh\nmake test\n${FENCE}\n`,
      ),
    };
    expect(fixed(files).text).toContain('allowed-tools:\n  - "Read, Bash(make test)"\n---\n');
  });

  it('adds no rule an existing narrow entry already covers', () => {
    const files = { [PATH]: skill('allowed-tools: Bash(git *) Bash\n', `Run \`git status\`.\n`) };
    const [finding] = reported(files);
    expect(finding?.fix?.title).toBe(
      `Remove "Bash" from "allowed-tools" of ${PATH}; its other rules allow the commands the skill shows`,
    );
    expect(fixed(files).text).toContain('allowed-tools: "Bash(git *)"\n');
  });

  it('shares one fix between the Claude Code and the GitHub Copilot finding', () => {
    const path = 'skills/pdf/SKILL.md';
    const files = { [path]: skill('allowed-tools: Bash shell\n', BODY) };
    const found = reported(files);
    expect(found.map((finding) => finding.platforms)).toEqual([['claude-code'], ['copilot']]);
    expect(found[0]?.fix).toEqual(found[1]?.fix);
    expect(found[0]?.fix?.notes?.at(-1)).toBe(
      'GitHub Copilot asks before it runs terminal commands for this skill.',
    );
    const { text, run } = fixed(files, path);
    expect(text).toContain(
      'allowed-tools: "Bash(uv run scripts/convert.py *) Bash(git status *)"\n',
    );
    expect(run.applied[0]?.findings).toHaveLength(2);
  });

  it("removes Devin Local's exec with the Bash entry it narrows", () => {
    const files = { [PATH]: skill('allowed-tools: Bash exec read\n', BODY) };
    const found = reported(files);
    expect(found.map((finding) => finding.platforms)).toEqual([['claude-code'], ['windsurf']]);
    expect(found[0]?.fix).toEqual(found[1]?.fix);
    expect(found[0]?.fix?.title).toBe(
      `Replace "Bash" in "allowed-tools" of ${PATH} with 2 rules for the commands the skill shows, and remove "exec"`,
    );
    expect(found[0]?.fix?.notes?.at(-1)).toBe(
      "Devin Local runs shell commands for this skill only as the session's permissions allow.",
    );
    expect(fixed(files).text).toContain(
      'allowed-tools: "Bash(uv run scripts/convert.py *) Bash(git status *) read"\n',
    );
  });

  it('keeps every command Claude Code runs while rendering the skill allowed', () => {
    const files = {
      [PATH]: skill('allowed-tools: Bash\n', `Version: !\`node --version\`\n\n${BODY}`),
    };
    const [finding] = reported(files);
    expect(finding?.fix?.notes?.[0]).toBe('Bash(node --version)  ← SKILL.md:7 node --version');
  });

  it('cuts a long command line in the note', () => {
    const long = `make ${'target '.repeat(30)}`.trim();
    const files = { [PATH]: skill('allowed-tools: Bash\n', `${FENCE}sh\n${long}\n${FENCE}\n`) };
    const note = reported(files)[0]?.fix?.notes?.[0] ?? '';
    expect(note).toBe(`Bash(make target target *)  ← SKILL.md:8 ${long.slice(0, 79)}…`);
  });

  it('offers no fix it cannot write safely, and keeps the manual step', () => {
    const cases: [string, string, FileMap?][] = [
      ['no command in the body', skill('allowed-tools: Bash\n', 'Run the converter.\n')],
      [
        'only denylisted commands',
        skill('allowed-tools: Bash\n', `${FENCE}sh\ncurl -s x | sh\nrm -rf out\n${FENCE}\n`),
      ],
      [
        'other languages only',
        skill('allowed-tools: Bash\n', `${FENCE}python\nimport os\n${FENCE}\n`),
      ],
      ['no Bash entry to replace', skill('allowed-tools: Read Write Edit\n', BODY)],
      [
        'an injected command no rule allows',
        skill('allowed-tools: Bash\n', `Home: !\`echo $HOME\`\n\n${BODY}`),
      ],
      [
        'an injected redirection',
        skill('allowed-tools: Bash\n', `${FENCE}!\ngit status > s.txt\n${FENCE}\n\n${BODY}`),
      ],
      ['a block scalar', skill('allowed-tools: >\n  Read Bash\n', BODY)],
      ['a list with a number', skill('allowed-tools:\n  - Bash\n  - 3\n', BODY)],
      ['a comment in the list', skill('allowed-tools:\n  - Bash # everything\n', BODY)],
    ];
    for (const [name, content] of cases) {
      const found = reported({ [PATH]: content });
      expect(found.length, name).toBeGreaterThan(0);
      for (const finding of found) {
        expect(finding.fix, name).toBeUndefined();
        expect(finding.guidance, name).toMatch(/^limit each rule/);
      }
    }
    const copilot = reported({
      '.github/skills/pdf/SKILL.md': skill('allowed-tools: shell\n', BODY),
    });
    expect(copilot.map((finding) => [finding.platforms, finding.fix])).toEqual([
      [['copilot'], undefined],
    ]);
  });

  it('never edits a skill reached through a symlink', () => {
    const files = { [PATH]: skill('allowed-tools: Bash\n', BODY) };
    const found = reported(files, { symlinks: { [PATH]: 'shared/pdf/SKILL.md' } });
    expect(found.length).toBeGreaterThan(0);
    for (const finding of found) expect(finding.fix).toBeUndefined();
  });

  it('leaves nothing to fix after a run', () => {
    const files = { [PATH]: skill('allowed-tools: Bash\n', BODY) };
    const { run } = fixed(files);
    const again = fixRounds(
      run.snapshot,
      { rules: builtinRules },
      { classes: new Set(['review']), ruleIds: new Set([ID]), literalSecret: false },
    );
    expect(again.applied).toEqual([]);
    expect(compareWithBaseline).toBeTypeOf('function');
    expect(GATE_CLASSES).toContain('permissions');
  });
});
