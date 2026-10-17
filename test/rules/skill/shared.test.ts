import { describe, expect, it } from 'vitest';
import type { Artifact, PlatformId } from '../../../src/core/types.js';
import { joinClauses, platformsDo, plural, quote } from '../../../src/rules/shared/format.js';
import { claudeCodeRepair, codexRepair, rustTrim } from '../../../src/rules/skill/repair.js';
import {
  audience,
  inPayloadFolder,
  placement,
  readersAt,
  skillLocation,
  skillReach,
} from '../../../src/rules/skill/shared.js';
import { snapshotFrom } from '../../helpers/lint.js';

const artifact = (path: string, aliases: string[] = [], caseMismatch = false) =>
  ({
    path,
    realPath: path,
    aliases,
    ...(caseMismatch ? { caseMismatch: { expected: path } } : {}),
  }) as unknown as Artifact;

const scope = (paths: string[] = []) => ({
  snapshot: snapshotFrom({}, { paths }),
  targets: new Set<PlatformId>(),
});

const sorted = (set: ReadonlySet<PlatformId>) => [...set].sort();

describe('skillLocation', () => {
  it('finds the innermost skills root and who reads the path', () => {
    expect(skillLocation('.claude/skills/deploy/SKILL.md')).toEqual({
      root: '.claude/skills',
      relative: 'deploy/SKILL.md',
      platforms: new Set(['claude-code', 'cursor', 'copilot', 'windsurf', 'cline']),
    });
    expect(skillLocation('apps/web/.agents/skills/deploy/SKILL.md')?.root).toBe(
      'apps/web/.agents/skills',
    );
    expect(skillLocation('.claude/skills/x/.cursor/skills/y/SKILL.md')?.root).toBe(
      '.claude/skills/x/.cursor/skills',
    );
  });

  it('applies each platform search depth', () => {
    expect(
      sorted(skillLocation('.agents/skills/team/deploy/SKILL.md')?.platforms ?? new Set()),
    ).toEqual(['codex', 'cursor']);
    expect(sorted(skillLocation('.agents/skills/SKILL.md')?.platforms ?? new Set())).toEqual([
      'cline',
      'codex',
      'cursor',
      'gemini',
    ]);
    expect(sorted(skillLocation('.gemini/skills/deploy/SKILL.md')?.platforms ?? new Set())).toEqual(
      ['gemini'],
    );
    expect(sorted(skillLocation('.github/skills/deploy/SKILL.md')?.platforms ?? new Set())).toEqual(
      ['copilot', 'windsurf'],
    );
    // Devin Local reads `<name>/SKILL.md` in its own roots and any depth in the imported ones.
    expect(sorted(skillLocation('.github/skills/a/b/SKILL.md')?.platforms ?? new Set())).toEqual([
      'windsurf',
    ]);
    expect(sorted(skillLocation('.devin/skills/deploy/SKILL.md')?.platforms ?? new Set())).toEqual([
      'windsurf',
    ]);
    expect(skillLocation('.windsurf/skills/a/b/SKILL.md')?.platforms.size).toBe(0);
    expect(sorted(skillLocation('.codex/skills/a/b/SKILL.md')?.platforms ?? new Set())).toEqual([
      'codex',
      'cursor',
    ]);
    // Cline reads a SKILL.md in the root and in each folder of it.
    expect(sorted(skillLocation('.cline/skills/deploy/SKILL.md')?.platforms ?? new Set())).toEqual([
      'cline',
    ]);
    expect(sorted(skillLocation('.clinerules/skills/SKILL.md')?.platforms ?? new Set())).toEqual([
      'cline',
    ]);
    expect(skillLocation('.cline/skills/a/b/SKILL.md')?.platforms.size).toBe(0);
  });

  it('drops Codex for a skill.md with the wrong case', () => {
    expect(
      sorted(skillLocation('.agents/skills/x/skill.md', true)?.platforms ?? new Set()),
    ).toEqual(['cline', 'copilot', 'cursor', 'gemini', 'windsurf']);
  });

  it('ignores paths outside a skills root and look-alike directories', () => {
    expect(skillLocation('skills/deploy/SKILL.md')).toBeUndefined();
    expect(skillLocation('x.claude/skills/deploy/SKILL.md')).toBeUndefined();
    expect(skillLocation('.Claude/skills/deploy/SKILL.md')).toBeUndefined();
  });
});

describe('skillReach', () => {
  it('unions the reach of every symlinked path', () => {
    expect(
      sorted(
        skillReach(scope(), artifact('.gemini/skills/x/SKILL.md', ['.claude/skills/x/SKILL.md'])),
      ),
    ).toEqual(['claude-code', 'cline', 'copilot', 'cursor', 'gemini', 'windsurf']);
  });

  it('treats a skill outside every root as reachable by all platforms', () => {
    expect(skillReach(scope(), artifact('plugins/p/skills/x/SKILL.md')).size).toBe(5);
    // The skills directory adds Devin Local and Cline, which the skill rules do not judge outside one.
    expect(
      skillReach(scope(), artifact('.claude/skills/x/SKILL.md', ['skills/x/SKILL.md'])).size,
    ).toBe(7);
  });
});

describe('placement', () => {
  it('gives plugin skills the plugin agents and no upload checks', () => {
    const plugin = scope([
      'p/.claude-plugin/plugin.json',
      'p/.codex-plugin/plugin.json',
      'q/.kimi-plugin/plugin.json',
    ]);
    expect(placement(plugin, artifact('p/skills/x/SKILL.md'))).toEqual({
      reach: new Set(['claude-code', 'codex']),
      distributable: false,
      claudeProject: false,
    });
    expect(placement(plugin, artifact('q/skills/x/SKILL.md')).reach.size).toBe(0);
  });

  it('treats skills of plugins declared only in a marketplace as plugin skills', () => {
    const market = scope(['.claude-plugin/marketplace.json']);
    expect(placement(market, artifact('plugins/dev/skills/agent-development/SKILL.md'))).toEqual({
      reach: new Set(['claude-code']),
      distributable: false,
      claudeProject: false,
    });
    // A top-level skills directory of a marketplace repository stays distributable.
    expect(placement(market, artifact('skills/pdf/SKILL.md')).distributable).toBe(true);
    // Unknown marketplace kinds mark a plugin without adding a reader.
    const other = scope(['.kimi-plugin/marketplace.json']);
    expect(placement(other, artifact('plugins/a/skills/b/SKILL.md')).reach.size).toBe(0);
  });

  it('prefers the skills directory over an enclosing plugin', () => {
    const plugin = scope(['.claude-plugin/plugin.json']);
    expect(placement(plugin, artifact('.claude/skills/x/SKILL.md'))).toEqual({
      reach: new Set(['claude-code', 'cursor', 'copilot', 'windsurf', 'cline']),
      distributable: false,
      claudeProject: true,
    });
  });

  it('treats a skill whose real file is in a collection as distributable', () => {
    const linked = {
      ...artifact('.claude/skills/x/SKILL.md'),
      realPath: 'skills/x/SKILL.md',
    } as unknown as Artifact;
    expect(placement(scope(), linked).distributable).toBe(true);
    expect(placement(scope(), artifact('skills/x/SKILL.md')).distributable).toBe(true);
  });
});

describe('inPayloadFolder', () => {
  it('matches template, example, sample, fixture and assets folders, not file names', () => {
    for (const path of [
      'template/SKILL.md',
      'a/Templates/b/SKILL.md',
      'a/assets/b/SKILL.md',
      'x/samples/s/SKILL.md',
      'x/testdata/s/SKILL.md',
      'x/scaffold/s/SKILL.md',
    ]) {
      expect(inPayloadFolder(path)).toBe(true);
    }
    for (const path of ['skills/deploy/SKILL.md', '.claude/skills/x/SKILL.md', 'template.md']) {
      expect(inPayloadFolder(path)).toBe(false);
    }
  });
});

describe('audience', () => {
  it('is the plugin agents for a plugin skill without aliases', () => {
    const plugin = scope(['p/.claude-plugin/plugin.json']);
    expect(audience(plugin, artifact('p/skills/x/SKILL.md'))).toEqual(new Set(['claude-code']));
  });

  it('adds the readers of every alias in an agent skills directory', () => {
    const plugin = scope(['p/.claude-plugin/plugin.json']);
    const exposed = artifact('p/skills/x/SKILL.md', [
      '.codex/skills/x/SKILL.md',
      '.gemini/skills/x/SKILL.md',
      'mirror/x/SKILL.md',
    ]);
    expect(sorted(audience(plugin, exposed))).toEqual(['claude-code', 'codex', 'cursor', 'gemini']);
    const viaAlias = {
      ...artifact('.agents/skills/x/SKILL.md'),
      realPath: 'p/skills/x/SKILL.md',
    } as unknown as Artifact;
    expect(sorted(audience(plugin, viaAlias))).toEqual(
      sorted(new Set(['claude-code', ...readersAt(plugin.snapshot, '.agents/skills/x/SKILL.md')])),
    );
  });

  it('ignores the plugin for an agent file exposed as SKILL.md', () => {
    const plugin = scope(['.codex-plugin/plugin.json']);
    const exposed = {
      ...artifact('.gemini/skills/x/SKILL.md'),
      realPath: 'commands/x.md',
    } as unknown as Artifact;
    expect(audience(plugin, exposed)).toEqual(new Set(['gemini']));
  });

  it('is the reach for a skill outside every plugin', () => {
    expect(
      audience(scope(), artifact('.agents/skills/x/SKILL.md', ['.claude/skills/x/SKILL.md'])),
    ).toEqual(
      new Set(['claude-code', 'codex', 'cursor', 'copilot', 'gemini', 'windsurf', 'cline']),
    );
  });
});

describe('format helpers', () => {
  it('formats lists, clauses and plurals', () => {
    expect(joinClauses([])).toBe('');
    expect(joinClauses(['a'])).toBe('a');
    expect(joinClauses(['a', 'b', 'c'])).toBe('a, b, and c');
    expect(platformsDo([], ['skips', 'skip'], 'x')).toBeUndefined();
    expect(plural(1, 'line')).toBe('1 line');
    expect(plural(1200, 'line')).toBe('1,200 lines');
    expect(quote('a\tb\nc')).toBe('"a b c"');
  });
});

describe('repair replays', () => {
  it('trims like Rust, keeping U+FEFF', () => {
    expect(rustTrim(' \u00a0---\u3000')).toBe('---');
    expect(rustTrim('\ufeff---')).toBe('\ufeff---');
  });

  it('leaves Claude Code quoting to unquoted values and keeps valid flow lists', () => {
    expect(claudeCodeRepair('a: [x, y]\nb: "q: r"\nc: d: e')).toBe(
      'a: [x, y]\nb: "q: r"\nc: "d: e"',
    );
    expect(claudeCodeRepair('a: [x: y\n')).toBe('a: "[x: y"\n');
    expect(claudeCodeRepair('a: C:\\x "y": z')).toBe('a: "C:\\\\x \\"y\\": z"');
    expect(claudeCodeRepair('\t\tk: v')).toBe('    k: v');
  });

  it('follows the Codex repair rules', () => {
    expect(codexRepair('a: b')).toBeUndefined();
    expect(codexRepair("a: it's: here # note")).toBe("a: 'it''s: here' # note");
    expect(codexRepair('a: @x')).toBe("a: '@x'");
    expect(codexRepair('a: [ok]')).toBeUndefined();
    expect(codexRepair('a:x: y')).toBeUndefined();
    expect(codexRepair(': x: y')).toBeUndefined();
    expect(codexRepair('a: >\n  b: c\nd: e: f\r\n')).toBe("a: >\n  b: c\nd: 'e: f'");
    expect(codexRepair('a:\nb: "c: d"\nnone')).toBeUndefined();
  });
});
