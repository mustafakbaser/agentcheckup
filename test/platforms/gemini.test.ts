import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/core/engine.js';
import { geminiContextFileNames } from '../../src/platforms/gemini.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';

const json = (value: unknown): string => JSON.stringify(value, null, 2);
const names = (files: FileMap, cwd = '') =>
  geminiContextFileNames(analyze(snapshotFrom(files), {}), cwd);

describe('geminiContextFileNames', () => {
  it('reads GEMINI.md without settings, and without context.fileName', () => {
    expect(names({})).toEqual({ names: ['GEMINI.md'], origin: 'default' });
    expect(names({ '.gemini/settings.json': json({ mcpServers: {} }) })).toEqual({
      names: ['GEMINI.md'],
      origin: 'default',
      settings: '.gemini/settings.json',
    });
  });

  it('adds the names of context.fileName in front of GEMINI.md', () => {
    expect(
      names({ '.gemini/settings.json': json({ context: { fileName: 'AGENTS.md' } }) }),
    ).toEqual({
      names: ['AGENTS.md', 'GEMINI.md'],
      origin: 'repository',
      settings: '.gemini/settings.json',
    });
    expect(
      names({
        '.gemini/settings.json': json({
          context: { fileName: [' ./CONTEXT.md ', 'GEMINI.md', '', 3, 'CONTEXT.md', '../x.md'] },
        }),
      }).names,
    ).toEqual(['CONTEXT.md', 'GEMINI.md']);
  });

  it('keeps the default for an empty name, an empty list and settings that do not parse', () => {
    const settings = (value: unknown) => names({ '.gemini/settings.json': json(value) });
    expect(settings({ context: { fileName: '' } }).origin).toBe('default');
    expect(settings({ context: { fileName: [] } })).toMatchObject({
      names: ['GEMINI.md'],
      origin: 'repository',
    });
    expect(names({ '.gemini/settings.json': '{ "context": ' }).origin).toBe('default');
  });

  it('ignores the legacy top-level contextFileName', () => {
    expect(
      names({ '.gemini/settings.json': json({ contextFileName: 'AGENTS.md' }) }).names,
    ).toEqual(['GEMINI.md']);
  });

  it('reads the settings of the working directory only', () => {
    const files = { 'pkg/.gemini/settings.json': json({ context: { fileName: 'AGENTS.md' } }) };
    expect(names(files).origin).toBe('default');
    expect(names(files, 'pkg').names).toEqual(['AGENTS.md', 'GEMINI.md']);
    expect(names(files, 'pkg/sub').origin).toBe('default');
  });
});
