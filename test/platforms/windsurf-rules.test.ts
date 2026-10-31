import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/engine.js';
import { parseFrontmatter } from '../../src/parse/frontmatter.js';
import {
  devinReadConfigFor,
  devinReadConfigFrom,
  devinSourceOf,
  WINDSURF_MODE_TRIGGER,
  WINDSURF_WORKSPACE_RULE_MAX_CHARS,
  windsurfActivation,
  windsurfRuleLength,
} from '../../src/platforms/windsurf-rules.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';

const activation = (text: string) => windsurfActivation(parseFrontmatter(text));
const json = (value: unknown): string => JSON.stringify(value, null, 2);

describe('windsurfActivation', () => {
  it.each([
    ['always_on', 'startup'],
    ['glob', 'on-path'],
    ['model_decision', 'model-selected'],
    ['manual', 'manual'],
  ] as const)('reads trigger: %s', (trigger, loadTrigger) => {
    const result = activation(`---\ntrigger: ${trigger}\n---\nBody\n`);
    expect(result.mode).toBe(trigger);
    expect(result.documented).toBe(true);
    expect(WINDSURF_MODE_TRIGGER[result.mode]).toBe(loadTrigger);
  });

  it('reads globs and the description', () => {
    expect(
      activation('---\ntrigger: glob\nglobs: "src/**/*.ts, test/**"\ndescription: TS\n---\n'),
    ).toEqual({
      mode: 'glob',
      globs: ['src/**/*.ts', 'test/**'],
      described: true,
      documented: true,
    });
    expect(activation('---\ntrigger: glob\nglobs: [a, b]\n---\n')).toMatchObject({
      globs: ['a', 'b'],
      documented: false,
    });
  });

  it('marks agent, missing and unknown triggers as undocumented', () => {
    expect(activation('---\ntrigger: agent\n---\n')).toMatchObject({
      mode: 'agent',
      documented: false,
    });
    for (const text of [
      'Body only.\n',
      '---\ndescription: x\n---\n',
      '---\ntrigger: always\n---\n',
    ]) {
      expect(activation(text)).toMatchObject({ mode: 'unknown', documented: false });
    }
    expect(WINDSURF_MODE_TRIGGER.unknown).toBe('unknown');
  });
});

describe('windsurfRuleLength', () => {
  it('counts characters after the frontmatter, a CRLF and a surrogate pair as one each', () => {
    expect(windsurfRuleLength('ab\r\n😀', 0, 10)).toEqual({ chars: 4, overflow: -1 });
    expect(windsurfRuleLength('---\nx\n---\nabc', 10, 2)).toEqual({ chars: 3, overflow: 12 });
    const text = 'x'.repeat(WINDSURF_WORKSPACE_RULE_MAX_CHARS);
    expect(windsurfRuleLength(text, 0, WINDSURF_WORKSPACE_RULE_MAX_CHARS).overflow).toBe(-1);
    expect(windsurfRuleLength(`${text}y`, 0, WINDSURF_WORKSPACE_RULE_MAX_CHARS).overflow).toBe(
      WINDSURF_WORKSPACE_RULE_MAX_CHARS,
    );
  });
});

describe('read_config_from', () => {
  const view = (files: FileMap) => analyze(snapshotFrom(files), {});

  it('turns every source on by default', () => {
    const config = devinReadConfigFrom(view({}), '');
    expect(Object.values(config.enabled).every(Boolean)).toBe(true);
    expect(config.config).toBeUndefined();
  });

  it('reads booleans from .devin/config.json and leaves other values at the default', () => {
    const config = devinReadConfigFrom(
      view({
        '.devin/config.json': json({
          read_config_from: { cursor: false, claude: 'no', zed: true },
        }),
      }),
      '',
    );
    expect(config.enabled).toMatchObject({ cursor: false, claude: true, zed: true });
    expect(config.origin).toMatchObject({
      cursor: 'repository',
      claude: 'default',
      zed: 'repository',
    });
    expect(config.config).toBe('.devin/config.json');
  });

  it('uses the nearest configuration at or above a directory', () => {
    const files = {
      '.devin/config.json': json({ read_config_from: { cursor: false } }),
      'apps/web/.devin/config.json': json({ read_config_from: { claude: false } }),
    };
    expect(devinReadConfigFor(view(files), 'apps/web/src').enabled).toMatchObject({
      cursor: true,
      claude: false,
    });
    expect(devinReadConfigFor(view(files), 'apps').enabled.cursor).toBe(false);
  });

  it('names the source that controls each file', () => {
    const source = (kind: Parameters<typeof devinSourceOf>[0]['kind'], path: string) =>
      devinSourceOf({ kind, path });
    expect(source('agents-md', 'AGENTS.md')).toBe('agents_standard');
    expect(source('windsurf-legacy-rules', '.windsurfrules')).toBe('agents_standard');
    expect(source('cursor-rule-md', '.cursor/rules/a.md')).toBe('cursor');
    expect(source('cursor-mcp', '.cursor/mcp.json')).toBe('cursor');
    expect(source('claude-md', 'CLAUDE.md')).toBe('claude');
    expect(source('mcp-json', '.mcp.json')).toBe('claude');
    expect(source('claude-settings', '.claude/settings.json')).toBe('claude');
    expect(source('claude-settings', '.claude/settings.local.json')).toBe('claude');
    expect(source('windsurf-rule', '.windsurf/rules/a.md')).toBe('windsurf');
    expect(source('skill', '.windsurf/skills/x/SKILL.md')).toBe('windsurf');
    expect(source('skill', '.claude/skills/x/SKILL.md')).toBe('claude');
    expect(source('skill', '.github/skills/x/SKILL.md')).toBe('copilot');
    // Devin's own files, and files no source names.
    expect(source('windsurf-rule', '.devin/rules/a.md')).toBeUndefined();
    expect(source('skill', '.agents/skills/x/SKILL.md')).toBeUndefined();
    expect(source('devin-hooks', '.devin/hooks.v1.json')).toBeUndefined();
  });
});
