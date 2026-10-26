import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/engine.js';
import { pathAs, readingsOf } from '../../src/platforms/readings.js';
import { snapshotFrom } from '../helpers/lint.js';

const artifactAt = (
  files: Record<string, string>,
  symlinks: Record<string, string>,
  path: string,
) => {
  const artifact = analyze(snapshotFrom(files, { symlinks }), {}).index.get(path);
  if (artifact === undefined) throw new Error(`no artifact at ${path}`);
  return artifact;
};

describe('readingsOf', () => {
  it('gives the own kind first, then one reading per other kind its aliases have', () => {
    const text = '---\nname: x\ndescription: d\n---\n';
    const artifact = artifactAt(
      {
        '.github/agents/x.agent.md': text,
        '.claude/agents/x.agent.md': text,
        '.claude/agents/y.agent.md': text,
        'docs/x.md': text,
      },
      {
        '.claude/agents/x.agent.md': '.github/agents/x.agent.md',
        '.claude/agents/y.agent.md': '.github/agents/x.agent.md',
        // Not a kind agentcheckup reads: no reading.
        'docs/x.md': '.github/agents/x.agent.md',
      },
      '.github/agents/x.agent.md',
    );
    expect(readingsOf(artifact)).toEqual([
      { kind: 'copilot-agent', path: '.github/agents/x.agent.md' },
      { kind: 'claude-agent', path: '.claude/agents/x.agent.md' },
    ]);
    expect(pathAs(artifact, 'claude-agent')).toBe('.claude/agents/x.agent.md');
    expect(pathAs(artifact, 'skill')).toBeUndefined();
  });

  it('gives an artifact without aliases its own reading only', () => {
    const artifact = artifactAt({ 'AGENTS.md': '# A\n' }, {}, 'AGENTS.md');
    expect(readingsOf(artifact)).toEqual([{ kind: 'agents-md', path: 'AGENTS.md' }]);
  });
});
