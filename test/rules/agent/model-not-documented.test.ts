import { describe, expect, it } from 'vitest';
import { modelNotDocumentedRule } from '../../../src/rules/agent/model-not-documented.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'agent/model-not-documented';
const rules = [modelNotDocumentedRule];

const subagent = (model: string): string =>
  `---\nname: reviewer\ndescription: Reviews code\nmodel: ${model}\n---\nReview.\n`;

function run(files: Record<string, string>, targets?: Parameters<typeof lint>[1]['targets']) {
  const result = lint(files, { rules, ...(targets === undefined ? {} : { targets }) });
  return {
    found: findings(result, ID).map(({ severity, path, message, range }) => ({
      severity,
      path,
      message,
      line: range.start.line,
    })),
    guidance: result.findings.map((finding) => finding.guidance),
    platforms: result.findings.map((finding) => finding.platforms),
  };
}

describe('agent/model-not-documented', () => {
  it('warns about a value Claude Code does not document', () => {
    const { found, guidance, platforms } = run({
      '.claude/agents/reviewer.md': subagent('Claude Sonnet 4'),
    });
    expect(found).toEqual([
      {
        severity: 'warn',
        path: '.claude/agents/reviewer.md',
        message:
          '"Claude Sonnet 4" is not a model value Claude Code documents. ' +
          'Claude Code takes sonnet, opus, haiku, fable, a full model id such as claude-opus-5-5, or inherit. ' +
          'What it does with it is not documented.',
        line: 4,
      },
    ]);
    expect(guidance).toEqual(['set model to a value Claude Code documents, or remove it']);
    expect(platforms).toEqual([['claude-code']]);
  });

  it('judges a file by the agent whose format it is, through a symlink too', () => {
    // Cursor and Copilot read Claude Code's folder too, where `opus` is right for Claude Code.
    expect(run({ '.claude/agents/reviewer.md': subagent('opus') }).found).toEqual([]);
    const text = '---\nname: fix\ndescription: d\nmodel: Claude Sonnet 4.5\n---\n';
    const linked = findings(
      lint(
        { '.github/agents/fix.agent.md': text, '.claude/agents/fix.agent.md': text },
        { rules, symlinks: { '.claude/agents/fix.agent.md': '.github/agents/fix.agent.md' } },
      ),
      ID,
    );
    // Copilot documents display names; Claude Code, which reads it through the symlink, does not.
    expect(linked.map(({ path, message }) => [path, message.slice(0, 64)])).toEqual([
      [
        '.github/agents/fix.agent.md',
        '"Claude Sonnet 4.5" is not a model value Claude Code documents. ',
      ],
    ]);
  });

  it('checks each agent against its own documented values', () => {
    const { found } = run({
      '.codex/agents/explorer.toml':
        'name = "explorer"\ndescription = "Explores"\ndeveloper_instructions = "Explore."\nmodel = "inherit"\n',
      '.gemini/agents/scout.md':
        '---\nname: scout\ndescription: Scouts\nmodel: Gemini 3 Pro\n---\n',
      '.cursor/agents/writer.md': '---\nname: writer\nmodel: sonnet\n---\n',
      '.github/agents/number.agent.md': '---\ndescription: d\nmodel: 5\n---\n',
    });
    expect(found.map(({ severity, path, line }) => [severity, path, line])).toEqual([
      ['warn', '.codex/agents/explorer.toml', 4],
      ['warn', '.cursor/agents/writer.md', 3],
      ['warn', '.gemini/agents/scout.md', 4],
      ['warn', '.github/agents/number.agent.md', 3],
    ]);
    expect(found[0]?.message).toBe(
      '"inherit" is not a model value Codex documents. ' +
        "Codex takes a model id; leave model out to use the parent session's model. " +
        'What it does with it is not documented.',
    );
  });

  it('reports nothing for documented values, skipped files, shadowed ones or other targets', () => {
    expect(
      run({
        '.claude/agents/a.md': subagent('inherit'),
        '.cursor/agents/d.md': '---\nname: d\nmodel: composer-2[fast=true]\n---\n',
        '.github/agents/e.agent.md': '---\ndescription: d\nmodel: Claude Sonnet 4.5\n---\n',
        '.gemini/agents/f.md': '---\nname: f\ndescription: d\nmodel: gemini-3-flash\n---\n',
        '.devin/agents/g.md': '---\nname: g\nmodel: swe\n---\n',
        '.codex/agents/h.toml':
          'name = "h"\ndescription = "d"\ndeveloper_instructions = "x"\nmodel = "gpt-6.1-sol"\n',
      }).found,
    ).toEqual([]);
    // Values Claude Code documents, which only the agents that read its folder too do not.
    expect(
      run(
        {
          '.claude/agents/b.md': subagent('sonnet[1m]'),
          '.claude/agents/c.md': subagent('us.anthropic.claude-sonnet-4-5-20250929-v1:0').replace(
            'reviewer',
            'c',
          ),
          '.claude/agents/i.md': subagent('opusplan').replace('reviewer', 'i'),
        },
        ['claude-code'],
      ).found,
    ).toEqual([]);
    // Gemini CLI skips a file without a description: no model applies.
    expect(run({ '.gemini/agents/x.md': '---\nname: x\nmodel: Gemini 3\n---\n' }).found).toEqual(
      [],
    );
    // Cursor reads .cursor/agents first, so the Claude Code file's value never reaches it.
    expect(
      run({
        '.claude/agents/reviewer.md': subagent('opus'),
        '.cursor/agents/reviewer.md': '---\nname: reviewer\n---\n',
      }).found,
    ).toEqual([]);
    expect(
      run({ '.claude/agents/reviewer.md': subagent('Claude Sonnet 4') }, ['codex']).found,
    ).toEqual([]);
    expect(
      run({ '.claude/agents/reviewer.md': subagent('opus') }, ['claude-code', 'copilot']).found,
    ).toEqual([]);
  });
});
