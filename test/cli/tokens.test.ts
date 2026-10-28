import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKENS_HELP } from '../../src/cli/help.js';
import { EXIT, run } from '../../src/cli/run.js';
import { validateBaseline } from '../../src/core/baseline-input.js';
import type { TokenSummary } from '../../src/report/tokens-view.js';
import { capture, removeTempDirs, tempDir, writeFiles } from './helpers.js';

afterEach(removeTempDirs);

const schema: unknown = JSON.parse(
  readFileSync(new URL('../../schemas/report.schema.json', import.meta.url), 'utf8'),
);
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);

/** A monorepo with Claude Code instructions, a skill, two subagents and a package of its own. */
const FILES: Readonly<Record<string, string>> = {
  'CLAUDE.md': '# Project\nUse pnpm. Run the tests before every commit.\n',
  'AGENTS.md': '# Agents\nFollow the style guide.\n',
  '.claude/skills/api/SKILL.md':
    '---\nname: api\ndescription: API conventions.\n---\nAll endpoints return JSON.\n',
  '.claude/agents/reviewer.md':
    '---\nname: reviewer\ndescription: Reviews code.\nmodel: sonnet\nskills: [api]\n---\nYou review code for bugs.\n',
  '.claude/agents/helper.md': '---\nname: helper\ndescription: Helps.\n---\nHelp.\n',
  '.claude/settings.json': '{\n  "model": "opus"\n}\n',
  'packages/api/CLAUDE.md': '# API\nValidate every input with zod before you use it.\n',
};

async function repository(files: Readonly<Record<string, string>> = FILES): Promise<string> {
  const root = await tempDir();
  await writeFiles(root, files);
  return root;
}

describe('agentcheckup tokens', () => {
  it("sums up each agent's context, then the largest subagent calls with their models", async () => {
    const root = await repository();
    const io = capture(root);
    expect(await run(['tokens', '--agent', 'claude-code,codex'], io)).toBe(EXIT.ok);
    const lines = io.output().split('\n');
    expect(lines[0]).toBe('Context cost by agent · ./  ≈tokens');
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}Claude Code +\d+ +\d+ +\d+ +2$/));
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}Codex +\d+ +0 +0 +0$/));
    // The reviewer's own model; the helper inherits the session's, which the settings set.
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^ +\d+ {2}Claude Code {2}reviewer {2}sonnet {2}.*\.claude\/agents\/reviewer\.md$/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^ +\d+ {2}Claude Code {2}helper {4}opus \(session\) {2}\.claude\/agents\/helper\.md$/,
      ),
    );
    expect(io.output()).toContain('≈tokens = characters ÷ 4\n');
    expect(io.output()).not.toContain('Start directories');
    expect(io.errors()).toBe('');
  });

  it('ranks the start directories below the root with --by-directory', async () => {
    const root = await repository();
    const io = capture(root);
    expect(await run(['tokens', '--agent', 'claude-code', '--by-directory'], io)).toBe(EXIT.ok);
    expect(io.output()).toMatch(
      /Start directories by context at start {2}≈tokens\n {16}Claude\n {2}\.\/ +\d+\n {2}packages\/api +\d+\n/,
    );
  });

  it('writes the report with the summary as JSON, valid as a report and as a baseline', async () => {
    const root = await repository();
    const parent = join(root, '..');
    const name = basename(root);
    const io = capture(parent);
    expect(
      await run(['tokens', name, '--agent', 'claude-code', '--by-directory', '-f', 'json'], io),
    ).toBe(EXIT.ok);
    const report = JSON.parse(io.output()) as { readonly tokens: TokenSummary };
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(validateBaseline(JSON.parse(io.output())).ok).toBe(true);
    // Paths relative to the current directory, as in every JSON report, and the models still found.
    expect(report.tokens.agents.map((row) => [row.agent, row.cwd])).toEqual([
      ['claude-code', name],
    ]);
    expect(report.tokens.calls.map((call) => [call.path, call.model])).toEqual([
      [`${name}/.claude/agents/reviewer.md`, { value: 'sonnet', source: 'definition' }],
      [`${name}/.claude/agents/helper.md`, { value: 'opus', source: 'session' }],
    ]);
    expect(report.tokens.directories?.map((row) => row.cwd)).toEqual([`${name}/packages/api`]);
    expect(report.tokens.directoriesNotPlanned).toBe(0);
  });

  it('shows how context at start and each subagent call moved since a baseline', async () => {
    const root = await repository();
    const base = join(root, '..', `${basename(root)}-base.json`);
    expect(
      await run(['tokens', '--agent', 'claude-code', '-f', 'json', '-o', base], capture(root)),
    ).toBe(EXIT.ok);
    await writeFile(
      join(root, 'CLAUDE.md'),
      `${FILES['CLAUDE.md'] ?? ''}${'More rules. '.repeat(40)}\n`,
    );

    const io = capture(root);
    expect(await run(['tokens', '--agent', 'claude-code', '--baseline', base], io)).toBe(EXIT.ok);
    // A CLAUDE.md edit moves every Claude Code subagent call: the session's files go with it.
    expect(io.output()).toMatch(
      /Claude Code ≈\d+ → ≈\d+ tokens \(\+\d+\), subagent calls helper ≈\d+ → ≈\d+ \(\+\d+\), reviewer ≈\d+ → ≈\d+ \(\+\d+\)\n/,
    );
    const markdown = capture(root);
    expect(
      await run(
        ['tokens', '-f', 'markdown', '--agent', 'claude-code', '--baseline', base],
        markdown,
      ),
    ).toBe(EXIT.ok);
    expect(markdown.output()).toContain('**Subagent calls**, each in a context window of its own');
    expect(markdown.output()).toContain('## Context cost by agent · ./');

    // A gate trips on what it gates, as with context; token changes alone do not.
    const gated = capture(root);
    expect(
      await run(
        ['tokens', '--agent', 'claude-code', '--baseline', base, '--gate', 'security'],
        gated,
      ),
    ).toBe(EXIT.ok);
  });

  it('rejects flags of other commands and --by-directory with --cwd', async () => {
    for (const args of [
      ['tokens', '--matrix'],
      ['tokens', '--fail-on', 'warn'],
      ['tokens', '--by-directory', '--cwd', 'packages'],
      ['context', '--by-directory'],
      ['agents', '--by-directory'],
      ['--by-directory'],
    ]) {
      const io = capture();
      expect(await run(args, io), args.join(' ')).toBe(EXIT.usage);
    }
    const io = capture();
    expect(await run(['tokens', '--by-directory', '--cwd', 'x'], io)).toBe(EXIT.usage);
    expect(io.errors()).toContain('cannot be combined with --cwd');
    expect(io.errors()).toContain('Run "agentcheckup tokens --help" for usage.');
  });

  it('prints its help', async () => {
    const help = capture();
    expect(await run(['tokens', '--help'], help)).toBe(EXIT.ok);
    expect(help.output()).toBe(TOKENS_HELP);
  });

  it('plans a session started in another directory with --cwd', async () => {
    const root = await repository();
    const io = capture(root);
    expect(await run(['tokens', '--agent', 'claude-code', '--cwd', 'packages/api'], io)).toBe(
      EXIT.ok,
    );
    expect(io.output().split('\n')[0]).toBe('Context cost by agent · packages/api  ≈tokens');
  });
});
