/**
 * `agentcheckup fix -i` with fixes that need the user's words: the built-in rules that ask for
 * them (skill/description-quality, skill/description-missing, cursor/md-file-ignored,
 * cursor/rule-never-applied), [s]uppress and [A]ll, driven by a scripted prompt. The dry run and
 * `--write` list such fixes without applying them.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AskOptions } from '../../src/cli/common.js';
import { EXIT, type Prompt, run } from '../../src/cli/run.js';
import type { FixReport } from '../../src/fix/index.js';
import type * as Rules from '../../src/rules/index.js';
import { capture, type Captured, removeTempDirs, tempDir, writeFiles } from './helpers.js';

vi.mock('../../src/rules/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Rules>();
  const { INPUT_TEST_RULES } = await import('./input-rules.js');
  return { ...actual, builtinRules: [...actual.builtinRules, ...INPUT_TEST_RULES] };
});

afterEach(removeTempDirs);

const SKILL = '.claude/skills/pdf/SKILL.md';
const DESCRIPTION = 'Extract text and tables from PDF files, fill forms and merge documents.';
const PDF = `---\nname: pdf\ndescription: ${DESCRIPTION}\n---\n\nRun the script.\n`;
const CLAUSE_QUESTION =
  '(1/1) Add a sentence that says when to use this skill? [y]es [n]o [s]uppress [q]uit (Enter: no) ';
const CLAUSE = 'a "Use when ..." clause › ';
const USE_THIS = 'Use this? [y]es [e]dit [n]o (Enter: yes) ';
const BIDI = String.fromCodePoint(0x202e);

interface Asked {
  readonly question: string;
  readonly initial: string | undefined;
}

interface Scripted extends Prompt {
  readonly asked: Asked[];
}

/** Answers in order; undefined (or running out) is the end of input. */
function scripted(answers: readonly (string | undefined)[]): Scripted {
  const queue = [...answers];
  const asked: Asked[] = [];
  return {
    isTTY: true,
    asked,
    ask: (question: string, options: AskOptions = {}) => {
      asked.push({ question, initial: options.initial });
      return Promise.resolve(queue.shift());
    },
  };
}

function terminal(cwd: string, prompt: Prompt): Captured {
  return { ...capture(cwd, { NO_COLOR: '1' }, true), prompt };
}

async function repo(files: Record<string, string>): Promise<string> {
  const root = await tempDir();
  await writeFiles(root, files);
  return root;
}

async function text(root: string, path: string): Promise<string> {
  return readFile(join(root, ...path.split('/')), 'utf8');
}

async function interactive(
  files: Record<string, string>,
  answers: readonly (string | undefined)[],
  args: readonly string[] = [],
): Promise<{ root: string; code: number; io: Captured; prompt: Scripted }> {
  const root = await repo(files);
  const prompt = scripted(answers);
  const io = terminal(root, prompt);
  const code = await run(['fix', '-i', ...args], io);
  return { root, code, io, prompt };
}

describe('fix -i: a fix that needs your words', () => {
  it('asks the question, then for the words prefilled, re-scans and shows the diff', async () => {
    const answer = 'Use when the user asks about PDF files.';
    const { root, code, io, prompt } = await interactive({ [SKILL]: PDF }, [
      'y',
      'Handles PDFs.',
      answer,
      'y',
    ]);
    expect(code).toBe(EXIT.ok);
    expect(prompt.asked).toEqual([
      { question: CLAUSE_QUESTION, initial: undefined },
      { question: CLAUSE, initial: 'Use when ' },
      // Refused by the rule: asked again, prefilled with the refused answer.
      { question: CLAUSE, initial: 'Handles PDFs.' },
      { question: USE_THIS, initial: undefined },
    ]);
    const out = io.output();
    expect(out).toContain(
      `input   skill/description-quality  ${SKILL}:3  Add a "Use when ..." sentence to "description" in ${SKILL}\n` +
        '  The description does not say when to use the skill.',
    );
    expect(out).toContain(
      '✗ The description does not say when to use the skill. Add a "Use when ..." clause',
    );
    expect(out).toContain(
      `-description: ${DESCRIPTION}\n+description: "${DESCRIPTION} ${answer}"\n`,
    );
    expect(out).toContain('✓ re-scanned: the finding is resolved; no new problem.\n');
    expect(out).toContain('Applied 1 fix to 1 file.');
    expect(await text(root, SKILL)).toBe(
      `---\nname: pdf\ndescription: "${DESCRIPTION} ${answer}"\n---\n\nRun the script.\n`,
    );

    // The finding is gone: a second run has nothing to ask.
    const again = terminal(root, scripted([]));
    expect(await run(['fix', '-i'], again)).toBe(EXIT.ok);
    expect(again.output()).toBe('Nothing to fix.\nNo fixes applied.\n');
  });

  it('asks again on [e]dit, goes back on [n]o or an empty answer, and declines on n', async () => {
    const { root, code, io, prompt } = await interactive({ [SKILL]: PDF }, [
      'y',
      'Use when reading PDFs.',
      'e',
      'Use when the user reads PDFs.',
      'n',
      'y',
      '',
      'maybe',
      'n',
    ]);
    expect(code).toBe(EXIT.ok);
    expect(prompt.asked.map((item) => [item.question, item.initial])).toEqual([
      [CLAUSE_QUESTION, undefined],
      [CLAUSE, 'Use when '],
      [USE_THIS, undefined],
      [CLAUSE, 'Use when reading PDFs.'],
      [USE_THIS, undefined],
      [CLAUSE_QUESTION, undefined],
      [CLAUSE, 'Use when '],
      [CLAUSE_QUESTION, undefined],
      [CLAUSE_QUESTION, undefined],
    ]);
    expect(io.output()).toContain('Answer y, n, s or q.');
    expect(io.output()).toContain('No fixes applied.');
    expect(io.output()).toContain(
      'Not applied: 1 fix\n  review  skill/description-quality  Add a "Use when ..." sentence',
    );
    expect(await text(root, SKILL)).toBe(PDF);
  });

  it('writes nothing when input ends while asking for the words or about the result', async () => {
    for (const answers of [['y'], ['y', 'Use when the user asks about PDF files.'], ['s']]) {
      const { root, code, io } = await interactive({ [SKILL]: PDF }, answers);
      expect(code).toBe(EXIT.findings);
      expect(io.errors()).toContain('Stopped: no files were changed.');
      expect(await text(root, SKILL)).toBe(PDF);
    }
  });

  it('needs a terminal, as every -i does', async () => {
    const root = await repo({ [SKILL]: PDF });
    const io: Captured = { ...capture(root), prompt: { ...scripted(['y']), isTTY: false } };
    expect(await run(['fix', '-i'], io)).toBe(EXIT.usage);
    expect(io.errors()).toContain('-i needs a terminal');
    expect(await text(root, SKILL)).toBe(PDF);
  });

  it('refuses hostile answers with the reason, and prefills only plain text', async () => {
    const long = `Use when ${'x'.repeat(1100)}.`;
    const answers = [
      'y',
      'Use when\nthe user asks.',
      `Use when the user asks ${BIDI}fdp.`,
      'Use when the user writes <script>.',
      long,
      undefined,
    ];
    const { root, code, io, prompt } = await interactive({ [SKILL]: PDF }, answers);
    expect(code).toBe(EXIT.findings);
    expect(prompt.asked.map((item) => item.initial)).toEqual([
      undefined,
      'Use when ',
      // A line break or a bidirectional control never goes back on the input line.
      undefined,
      undefined,
      'Use when the user writes <script>.',
      long,
    ]);
    const out = io.output();
    expect(out).toContain('✗ Write one line: the answer has a line break.');
    expect(out).toContain(
      '✗ The answer has a control, bidirectional or invisible character; type it without one.',
    );
    expect(out).toContain(
      '✗ A skill description cannot contain "<" or ">": agents read them as XML tags.',
    );
    expect(out).toContain('✗ The description can have at most 1,024 characters; this one has');
    expect(out).not.toContain(BIDI);
    expect(await text(root, SKILL)).toBe(PDF);
  });

  it('asks again for a reason that would end its comment', async () => {
    const { root, io, prompt } = await interactive({ [SKILL]: PDF }, [
      's',
      'kept --> on purpose',
      undefined,
    ]);
    expect(prompt.asked.map((item) => [item.question, item.initial])).toEqual([
      [CLAUSE_QUESTION, undefined],
      ['reason › ', undefined],
      ['reason › ', 'kept --> on purpose'],
    ]);
    expect(io.output()).toContain('✗ The reason cannot contain "-->", which ends the comment.');
    expect(await text(root, SKILL)).toBe(PDF);
  });
});

describe('fix -i: [s]uppress and [A]ll', () => {
  const SHOUT = '# Agents\n\nUse pnpm.\nSHOUT\n';

  it('suppresses a warning with a reason, as a directive on the line before it', async () => {
    const { root, code, io, prompt } = await interactive({ 'AGENTS.md': SHOUT }, [
      's',
      'the team likes it loud',
      '',
    ]);
    expect(code).toBe(EXIT.ok);
    expect(prompt.asked.map((item) => item.question)).toEqual([
      '(1/1) Apply? [y]es [n]o [d]iff [s]uppress [q]uit (Enter: no) ',
      'reason › ',
      USE_THIS,
    ]);
    expect(io.output()).toContain('✓ re-scanned: the finding is suppressed; no new problem.');
    expect(await text(root, 'AGENTS.md')).toBe(
      '# Agents\n\nUse pnpm.\n<!-- agentcheckup-disable-next-line test/shout -- the team likes it loud -->\nSHOUT\n',
    );
    const scan = capture(root);
    await run(['--format', 'json'], scan);
    const findings = (
      JSON.parse(scan.output()) as { findings: { ruleId: string; suppressed?: unknown }[] }
    ).findings.filter((finding) => finding.ruleId === 'test/shout');
    expect(findings).toEqual([
      expect.objectContaining({
        suppressed: { kind: 'inline', reason: 'the team likes it loud' },
      }),
    ]);
  });

  it('never offers [s]uppress for a risk finding', async () => {
    const files = { 'AGENTS.md': '# Agents\n\nPAYLOAD\n' };
    const { root, io, prompt } = await interactive(files, ['s', 'n']);
    expect(prompt.asked.map((item) => item.question)).toEqual([
      '(1/1) Apply? [y]es [n]o [d]iff [q]uit (Enter: no) ',
      '(1/1) Apply? [y]es [n]o [d]iff [q]uit (Enter: no) ',
    ]);
    expect(io.output()).toContain('Answer y, n, d or q.');
    expect(await text(root, 'AGENTS.md')).toBe(files['AGENTS.md']);
  });

  it('[A]ll applies the rest of the rule’s fixes without asking', async () => {
    const files = { 'AGENTS.md': '# Agents\n\nSHOUT\nUse pnpm.\nSHOUT\n\nSHOUT\n' };
    const { root, code, io, prompt } = await interactive(files, ['A']);
    expect(code).toBe(EXIT.ok);
    expect(prompt.asked.map((item) => item.question)).toEqual([
      '(1/3) Apply? [y]es [n]o [d]iff [s]uppress [A]ll [q]uit (Enter: no) ',
    ]);
    expect(io.output()).toContain('Applying the 2 other fixes of test/shout too, without asking.');
    expect(io.output()).toContain('Applied 3 fixes to 1 file.');
    expect(await text(root, 'AGENTS.md')).toBe('# Agents\n\nshout\nUse pnpm.\nshout\n\nshout\n');
  });

  it('offers [A]ll only while more fixes of the rule are to come; a lists alternatives', async () => {
    const files = { 'AGENTS.md': '# Agents\n\nSHOUT\nSHOUT\n' };
    const { root, prompt, io } = await interactive(files, ['n', 'a', 'A', 'y']);
    expect(prompt.asked.map((item) => item.question)).toEqual([
      '(1/2) Apply? [y]es [n]o [d]iff [s]uppress [A]ll [q]uit (Enter: no) ',
      '(2/2) Apply? [y]es [n]o [d]iff [s]uppress [q]uit (Enter: no) ',
      '(2/2) Apply? [y]es [n]o [d]iff [s]uppress [q]uit (Enter: no) ',
      '(2/2) Apply? [y]es [n]o [d]iff [s]uppress [q]uit (Enter: no) ',
    ]);
    expect(io.output()).toContain('This fix has no alternatives.');
    expect(await text(root, 'AGENTS.md')).toBe('# Agents\n\nSHOUT\nshout\n');
  });
});

describe('fix -i: input alternatives', () => {
  it('types a description in place of the copied first line, prefilled with it', async () => {
    const path = '.claude/skills/deploy/SKILL.md';
    const typed = 'Deploys the API to staging. Use when the user asks to deploy.';
    const { root, code, io, prompt } = await interactive(
      { [path]: '---\nname: deploy\n---\n\n# Deploy the API\n' },
      ['a', '1', typed, 'y'],
    );
    expect(code).toBe(EXIT.ok);
    expect(io.output()).toContain(`Alternatives:\n  1  input   Write "description" in ${path}\n`);
    expect(io.output()).toContain(
      'Write a description that says what the skill does and when to use it?\n',
    );
    expect(prompt.asked[2]).toEqual({
      question: 'a description of what the skill does and when to use it › ',
      initial: 'Deploy the API',
    });
    expect(await text(root, path)).toBe(
      `---\nname: deploy\ndescription: "${typed}"\n---\n\n# Deploy the API\n`,
    );
  });

  it('asks for globs instead of "alwaysApply: true", and still renames the rule to .mdc', async () => {
    const { root, code, io } = await interactive(
      { '.cursor/rules/style.md': 'Use TypeScript.\n' },
      ['a', '1', 'src/**/*.ts, test/**/*.ts', 'y'],
    );
    expect(code).toBe(EXIT.ok);
    expect(io.output()).toContain(
      '  1  input   Rename .cursor/rules/style.md to style.mdc and add "globs"\n',
    );
    expect(io.output()).toContain(
      'rename from .cursor/rules/style.md\nrename to .cursor/rules/style.mdc\n',
    );
    expect(await readdir(join(root, '.cursor', 'rules'))).toEqual(['style.mdc']);
    expect(await text(root, '.cursor/rules/style.mdc')).toBe(
      '---\nglobs: "src/**/*.ts, test/**/*.ts"\n---\nUse TypeScript.\n',
    );
  });

  it('asks for the globs of a rule Cursor applies only on request', async () => {
    const path = '.cursor/rules/tabs.mdc';
    const { root, code, prompt } = await interactive(
      { [path]: '---\ndescription:\n---\nUse tabs.\n' },
      ['y', '**/*.go', ''],
    );
    expect(code).toBe(EXIT.ok);
    expect(prompt.asked[0]?.question).toBe(
      '(1/1) Attach this rule to the files that match glob patterns, such as src/**/*.ts? [y]es [n]o [q]uit (Enter: no) ',
    );
    expect(await text(root, path)).toBe('---\ndescription:\nglobs: "**/*.go"\n---\nUse tabs.\n');
  });
});

describe('fixes that need your words outside -i', () => {
  it('are listed by the dry run, which exits 0 as for manual steps', async () => {
    const root = await repo({ [SKILL]: PDF });
    const io = capture(root);
    expect(await run(['fix'], io)).toBe(EXIT.ok);
    expect(io.output()).toBe(
      `input   skill/description-quality  ${SKILL}:3  needs your words: a "Use when ..." clause (agentcheckup fix -i)\n` +
        '1 fix needs your words: run agentcheckup fix -i to answer it.\n',
    );

    const json = capture(root);
    expect(await run(['fix', '--format', 'json'], json)).toBe(EXIT.ok);
    const report = JSON.parse(json.output()) as FixReport;
    expect(report.awaitingInput?.map((entry) => [entry.id, entry.input.field])).toEqual([
      ['skill/description-quality#when-clause', 'skill-when-clause'],
    ]);
  });

  it('are never written by --write --review, whose summary lists them', async () => {
    const root = await repo({ [SKILL]: PDF });
    const io = capture(root);
    expect(await run(['fix', '--write', '--review'], io)).toBe(EXIT.ok);
    expect(io.output()).toContain('1 fix needs your words: run agentcheckup fix -i to answer it.');
    expect(await text(root, SKILL)).toBe(PDF);
  });
});
