/**
 * The public API is what src/index.ts exports. Its names are recorded in a snapshot, so a pull
 * request that adds, removes or renames one shows it in review. Removing or renaming one is a
 * breaking change (docs/api.md).
 */
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../src/core/compare.js';
import * as api from '../../src/index.js';

const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

/** Every name src/index.ts exports, types included, as TypeScript sees it. */
function exportedNames(): string[] {
  const program = ts.createProgram([ENTRY], {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
  });
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(ENTRY);
  const module = file === undefined ? undefined : checker.getSymbolAtLocation(file);
  if (module === undefined) throw new Error('src/index.ts is not a module');
  return checker.getExportsOfModule(module).map((symbol) => symbol.name);
}

function section(title: string, names: readonly string[]): string {
  return [`# ${title} (${names.length})`, '', ...names, ''].join('\n');
}

describe('the public API', () => {
  it('exports the recorded names', async () => {
    const runtime = Object.keys(api).sort(compareStrings);
    const all = new Set(exportedNames());
    for (const name of runtime) expect(all.has(name), name).toBe(true);
    const typesOnly = [...all].filter((name) => !runtime.includes(name)).sort(compareStrings);
    expect(runtime).toContain('scan');
    expect(typesOnly).toContain('ScanResult');
    expect(typesOnly).not.toContain('scan');
    await expect(
      [section('Runtime exports', runtime), section('Type-only exports', typesOnly)].join('\n'),
    ).toMatchFileSnapshot('__snapshots__/api-exports.txt');
  });
});
