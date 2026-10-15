import { describe, expect, it } from 'vitest';
import { instructionsRules } from '../../../src/rules/instructions/index.js';
import { findings, type FileMap, lint } from '../../helpers/lint.js';

/** Every instruction rule must finish quickly and without throwing on hostile input. */
function timed(files: FileMap): { ms: number; count: number } {
  const start = performance.now();
  // A Git checkout, so Codex chains AGENTS.md files.
  const result = lint(files, { rules: instructionsRules, paths: ['.git/HEAD'] });
  const count = findings(result).length;
  return { ms: performance.now() - start, count };
}

describe('instruction rules on hostile input', () => {
  it('handle a file with tens of thousands of imports', () => {
    const imports = Array.from({ length: 20_000 }, (_, i) => `@docs/f${String(i)}.md`).join(' ');
    const { ms, count } = timed({ 'CLAUDE.md': imports, 'GEMINI.md': imports, 'AGENTS.md': 'x' });
    expect(count).toBeGreaterThan(0);
    expect(ms).toBeLessThan(15_000);
  });

  it('handle many files that all import each other', () => {
    const files: Record<string, string> = {};
    const names = Array.from({ length: 150 }, (_, i) => `p${String(i)}/AGENTS.md`);
    const everything = names.map((name) => `@../${name}`).join('\n');
    for (const name of names) files[name] = everything;
    files['CLAUDE.md'] = names.map((name) => `@${name}`).join('\n');
    const { ms } = timed(files);
    expect(ms).toBeLessThan(15_000);
  });

  it('handle deep chains of AGENTS.md files', () => {
    const files: Record<string, string> = {};
    let directory = '';
    for (let depth = 0; depth < 30; depth++) {
      files[`${directory}AGENTS.md`] = 'x'.repeat(2_000);
      directory += `d${String(depth)}/`;
    }
    const { ms, count } = timed(files);
    expect(count).toBeGreaterThan(0);
    expect(ms).toBeLessThan(15_000);
  });

  it('handle pathological text without regular-expression blowups', () => {
    const text = `${'*_[`<'.repeat(20_000)}\n${'. '.repeat(50_000)}\n${'['.repeat(50_000)}`;
    const { ms } = timed({
      'AGENTS.md': text,
      'CLAUDE.md': text,
      '.claude/rules/x.md': `---\npaths: "${'['.repeat(30_000)}"\n---\n${text}`,
      '.claude/agents/a.md': `\n\n---\nname: ${'-'.repeat(10_000)}\n---\n`,
      '.windsurfrules': text,
    });
    expect(ms).toBeLessThan(15_000);
  });
});
