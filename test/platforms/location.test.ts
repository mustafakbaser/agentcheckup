import { describe, expect, it } from 'vitest';
import { isBundledSkill, pluginRootOf, skillDirectoryOf } from '../../src/platforms/location.js';
import { snapshotFrom } from '../helpers/lint.js';

const snapshot = snapshotFrom(
  {},
  {
    paths: [
      '.claude-plugin/plugin.json',
      '.codex-plugin/plugin.json',
      '.qoder-plugin/plugin.json',
      'skills/review/SKILL.md',
      'skills/review/assets/sample-skill/SKILL.md',
      'skills/review/references/AGENTS.md',
      'packages/kit/.codex-plugin/plugin.json',
      'packages/kit/.mcp.json',
      'packages/kit/skills/build/SKILL.md',
      'docs/AGENTS.md',
    ],
  },
);

describe('pluginRootOf', () => {
  it('finds the nearest plugin root and the agents it targets', () => {
    expect(pluginRootOf(snapshot, 'packages/kit/.mcp.json')).toEqual({
      root: 'packages/kit',
      markers: ['.codex-plugin'],
      platforms: ['codex'],
    });
    expect(pluginRootOf(snapshot, 'skills/review/SKILL.md')).toEqual({
      root: '',
      markers: ['.claude-plugin', '.codex-plugin', '.qoder-plugin'],
      platforms: ['claude-code', 'codex'],
    });
  });

  it('returns undefined outside any plugin', () => {
    const plain = snapshotFrom({}, { paths: ['docs/AGENTS.md'] });
    expect(pluginRootOf(plain, 'docs/AGENTS.md')).toBeUndefined();
  });
});

describe('skills', () => {
  it('finds the skill a file belongs to', () => {
    expect(skillDirectoryOf(snapshot, 'skills/review/references/AGENTS.md')).toBe('skills/review');
    expect(skillDirectoryOf(snapshot, 'skills/review/SKILL.md')).toBe('skills/review');
    expect(skillDirectoryOf(snapshot, 'docs/AGENTS.md')).toBeUndefined();
  });

  it('recognizes a skill bundled inside another skill', () => {
    expect(isBundledSkill(snapshot, 'skills/review/assets/sample-skill/SKILL.md')).toBe(true);
    expect(isBundledSkill(snapshot, 'skills/review/SKILL.md')).toBe(false);
    expect(isBundledSkill(snapshot, 'packages/kit/skills/build/SKILL.md')).toBe(false);
  });
});
