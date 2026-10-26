import { describe, expect, it } from 'vitest';
import { subagentModelIgnoredRule } from '../../../src/rules/agent/subagent-model-ignored.js';
import { findings, lint } from '../../helpers/lint.js';

const ID = 'agent/subagent-model-ignored';
const rules = [subagentModelIgnoredRule];

const subagent = (name: string, model?: string): string =>
  `---\nname: ${name}\ndescription: d\n${model === undefined ? '' : `model: ${model}\n`}---\nBody.\n`;

const settings = (env: Record<string, string>): string => `${JSON.stringify({ env }, null, 2)}\n`;

describe('agent/subagent-model-ignored', () => {
  it('warns on each subagent model Claude Code ignores, and points at the switch', () => {
    const result = lint(
      {
        '.claude/agents/a.md': subagent('a', 'opus'),
        '.claude/agents/b.md': subagent('b', 'inherit'),
        '.claude/settings.json': settings({
          CLAUDE_CODE_SUBAGENT_MODEL: 'haiku',
          CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
        }),
      },
      { rules },
    );
    expect(findings(result, ID)).toEqual([
      {
        ruleId: ID,
        severity: 'warn',
        path: '.claude/agents/a.md',
        message:
          'Claude Code ignores this model, "opus": ".claude/settings.json" turns on CLAUDE_CODE_SUBAGENT_MODEL_FORCE, so the subagent runs on CLAUDE_CODE_SUBAGENT_MODEL, "haiku".',
        range: { start: { line: 4, column: 1 }, end: { line: 4, column: 12 } },
      },
      expect.objectContaining({ path: '.claude/agents/b.md' }),
    ]);
    const [first] = result.findings;
    expect(first?.related).toEqual([
      {
        path: '.claude/settings.json',
        message: 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on here.',
        range: { start: { line: 4, column: 1 }, end: { line: 4, column: 44 } },
      },
    ]);
    expect(first?.guidance).toBe(
      'remove model, or turn CLAUDE_CODE_SUBAGENT_MODEL_FORCE off if subagents should keep their own models',
    );
  });

  it('reports a subagent that .claude/agents reaches through a symlink, at its real file', () => {
    const text = subagent('a', 'opus');
    const result = lint(
      {
        '.github/agents/a.md': text,
        '.claude/agents/a.md': text,
        '.claude/settings.json': settings({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }),
      },
      { rules, symlinks: { '.claude/agents/a.md': '.github/agents/a.md' } },
    );
    expect(findings(result, ID).map((finding) => finding.path)).toEqual(['.github/agents/a.md']);
  });

  it("names the main conversation's model when only the switch is set", () => {
    const result = lint(
      {
        '.claude/agents/a.md': subagent('a', 'opus'),
        '.claude/settings.local.json': settings({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'true' }),
        '.claude/settings.json': `${JSON.stringify({ model: 'sonnet' })}\n`,
      },
      { rules },
    );
    expect(findings(result, ID).map((finding) => finding.message)).toEqual([
      'Claude Code ignores this model, "opus": ".claude/settings.local.json" turns on CLAUDE_CODE_SUBAGENT_MODEL_FORCE, so the subagent runs on the main conversation\'s model, "sonnet" in ".claude/settings.json".',
    ]);
  });

  it('reports nothing without the switch, without a model, for a skipped file or another target', () => {
    const on = settings({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
    const none = (files: Record<string, string>, targets?: ['codex']) =>
      findings(lint(files, { rules, ...(targets === undefined ? {} : { targets }) }), ID);
    expect(
      none({
        '.claude/agents/a.md': subagent('a', 'opus'),
        '.claude/settings.json': settings({ CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }),
      }),
    ).toEqual([]);
    expect(
      none({
        '.claude/agents/a.md': subagent('a', 'opus'),
        '.claude/settings.json': settings({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '0' }),
      }),
    ).toEqual([]);
    expect(none({ '.claude/agents/a.md': subagent('a'), '.claude/settings.json': on })).toEqual([]);
    expect(
      none({
        '.claude/agents/a.md': '---\ndescription: d\nmodel: opus\n---\n',
        '.claude/settings.json': on,
      }),
    ).toEqual([]);
    // Only the repository root's settings apply to a session started there.
    expect(
      none({
        '.claude/agents/a.md': subagent('a', 'opus'),
        'packages/x/.claude/settings.json': on,
      }),
    ).toEqual([]);
    expect(
      none({ '.claude/agents/a.md': subagent('a', 'opus'), '.claude/settings.json': on }, [
        'codex',
      ]),
    ).toEqual([]);
  });
});
