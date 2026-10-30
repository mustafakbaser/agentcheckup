import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENTS_HELP } from '../../src/cli/help.js';
import { EXIT, run } from '../../src/cli/run.js';
import { validateBaseline } from '../../src/core/baseline-input.js';
import { capture, removeTempDirs, tempDir, writeFiles } from './helpers.js';

afterEach(removeTempDirs);

const subagent = (name: string, model?: string): string =>
  `---\nname: ${name}\ndescription: ${name} things\n${model === undefined ? '' : `model: ${model}\n`}---\nDo ${name} things.\n`;

/** A repository with definitions for Claude Code (also read by Cursor and Copilot) and Codex. */
const FILES: Readonly<Record<string, string>> = {
  'AGENTS.md': '# Agents\n',
  '.claude/agents/reviewer.md': subagent('reviewer', 'opus'),
  '.claude/agents/helper.md': subagent('helper'),
  '.claude/settings.json': '{\n  "env": { "CLAUDE_CODE_SUBAGENT_MODEL": "haiku" }\n}\n',
  '.codex/agents/explorer.toml':
    'name = "explorer"\ndescription = "Explores"\ndeveloper_instructions = "Explore."\nmodel = "gpt-6.1-sol"\n',
  '.gemini/agents/broken.md': '---\nname: broken\n---\n',
};

async function repository(files: Readonly<Record<string, string>> = FILES): Promise<string> {
  const root = await tempDir();
  await writeFiles(root, files);
  return root;
}

interface Report {
  readonly pathBase?: string;
  readonly agents: {
    readonly definitions: readonly { readonly id: string; readonly file: string }[];
    readonly settings: readonly { readonly id: string }[];
  };
}

describe('agentcheckup agents', () => {
  it('lists each definition once per agent that reads it, and exits 0', async () => {
    const root = await repository();
    const io = capture(root);
    expect(await run(['agents'], io)).toBe(EXIT.ok);
    const text = io.output();
    expect(text).toContain(
      '10 agent definitions in 4 files (9 loaded, 1 skipped)\n\n.claude/agents/helper.md\n',
    );
    expect(text).toMatch(
      /^ {2}Claude Code {9}helper {4}no model → haiku \(subagent setting, \.claude\/settings\.json\)$/m,
    );
    expect(text).toMatch(/^ {2}Cursor {14}reviewer {2}opus \(not a value Cursor documents\)$/m);
    expect(text).toMatch(/^ {2}Codex {15}explorer {2}gpt-6\.1-sol$/m);
    expect(text).toMatch(/^ {2}Gemini CLI {10}broken {4}skipped: no description$/m);
    expect(text).toContain(
      'Model settings\n  .claude/settings.json:2  env.CLAUDE_CODE_SUBAGENT_MODEL = haiku  Claude Code subagents\n',
    );
    expect(text).toContain('Not visible here:');
    expect(text).not.toContain('Since the baseline');
    expect(io.errors()).toBe('');
  });

  it('lists the agents among the configured targets, or those named with --agent', async () => {
    const root = await repository({
      ...FILES,
      'agentcheckup.config.json': '{ "targets": ["codex"] }',
    });
    const configured = capture(root);
    expect(await run(['agents'], configured)).toBe(EXIT.ok);
    expect(configured.output()).toContain('1 agent definition in 1 file (1 loaded)\n');
    expect(configured.output()).not.toContain('Claude Code');

    const named = capture(root);
    expect(await run(['agents', '--agent', 'gemini'], named)).toBe(EXIT.ok);
    expect(named.output()).toContain('skipped: no description');
    expect(named.output()).not.toContain('Codex');

    // --untrusted ignores the repository's configuration, and its targets with it.
    const untrusted = capture(root);
    expect(await run(['agents', '--untrusted'], untrusted)).toBe(EXIT.ok);
    expect(untrusted.output()).toContain('10 agent definitions');
  });

  it('writes the scan report as JSON, every agent in it, with paths relative to the current directory', async () => {
    const root = await repository();
    await writeFiles(root, {});
    const parent = join(root, '..');
    const name = root.slice(parent.length + 1);
    const io = capture(parent);
    expect(await run(['agents', name, '--agent', 'codex', '-f', 'json'], io)).toBe(EXIT.ok);
    const report = JSON.parse(io.output()) as Report;
    expect(report.pathBase).toBe(name);
    // --agent narrows what is shown and compared, not the report, so it can serve as a baseline.
    expect(report.agents.definitions.map((definition) => definition.id)).toContain(
      `agent:${name}/.codex/agents/explorer.toml@codex`,
    );
    expect(report.agents.definitions).toHaveLength(10);
    expect(report.agents.settings).toHaveLength(1);
    expect(validateBaseline(JSON.parse(io.output())).ok).toBe(true);

    const text = capture(parent);
    expect(await run(['agents', name, '--agent', 'codex'], text)).toBe(EXIT.ok);
    expect(text.output()).toContain(`Paths are relative to ${name}\n`);
    expect(text.output()).toContain('\n.codex/agents/explorer.toml\n');
  });

  it('gates model changes since a baseline on request, for the agents it lists', async () => {
    const root = await repository();
    const base = join(root, '..', `${basename(root)}-base.json`);
    expect(await run(['agents', '-f', 'json', '-o', base], capture(root))).toBe(EXIT.ok);
    await writeFile(join(root, '.claude/agents/reviewer.md'), subagent('reviewer', 'fable'));

    const gated = capture(root);
    expect(
      await run(
        ['agents', '--agent', 'claude-code', '--baseline', base, '--gate', 'models'],
        gated,
      ),
    ).toBe(EXIT.findings);
    expect(gated.output()).toContain(
      '✖ 1 model change needs review\n' +
        '    Agent definition changed: reviewer for Claude Code (model opus → fable) · .claude/agents/reviewer.md:2\n',
    );

    // Not a security class, and not an agent --agent leaves out.
    const security = capture(root);
    expect(await run(['agents', '--baseline', base, '--gate', 'security'], security)).toBe(EXIT.ok);
    expect(security.output()).toContain('No security-relevant changes need review');
    const codex = capture(root);
    expect(
      await run(['agents', '--agent', 'codex', '--baseline', base, '--gate', 'models'], codex),
    ).toBe(EXIT.ok);
    expect(codex.output()).toContain('No model changes need review');

    const markdown = capture(root);
    expect(
      await run(
        ['agents', '-f', 'markdown', '--agent', 'cursor', '--baseline', base, '--gate', 'models'],
        markdown,
      ),
    ).toBe(EXIT.findings);
    expect(markdown.output()).toContain('**Needs review: 1 model change**');
    expect(markdown.output()).toContain('## Agent definitions');
  });

  it('says when there is nothing to list', async () => {
    const root = await repository({ 'AGENTS.md': '# Agents\n' });
    const io = capture(root);
    expect(await run(['agents'], io)).toBe(EXIT.ok);
    expect(io.output()).toBe('No agent definitions or model settings in this report.\n');
  });

  it('writes the list to --output', async () => {
    const root = await repository();
    const file = join(root, 'agent-list.md');
    const io = capture(root);
    expect(await run(['agents', '-f', 'markdown', '-o', 'agent-list.md'], io)).toBe(EXIT.ok);
    expect(io.output()).toBe('');
    expect(await readFile(file, 'utf8')).toContain('| File | Agent | Name | Model | Status |');
  });

  it('prints its help, and points to it on a usage error', async () => {
    const help = capture();
    expect(await run(['agents', '--help'], help)).toBe(EXIT.ok);
    expect(help.output()).toBe(AGENTS_HELP);
    const io = capture();
    expect(await run(['agents', '--cwd', 'x'], io)).toBe(EXIT.usage);
    expect(io.errors()).toContain('Run "agentcheckup agents --help" for usage.');
  });
});
