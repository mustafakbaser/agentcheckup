/**
 * The issues job of .github/workflows/source-drift.yml can write issues and installs nothing: it
 * runs scripts/drift/sync-issues.ts with Node.js alone, through scripts/drift/ts-hooks.ts. That
 * holds only while the script and everything it imports use Node.js built-ins.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import module from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../../src/core/compare.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SYNC = join(ROOT, 'scripts', 'drift', 'sync-issues.ts');
const HOOKS = join(ROOT, 'scripts', 'drift', 'ts-hooks.ts');

/** Module specifiers of the imports and re-exports that remain at runtime. */
function runtimeSpecifiers(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  for (const statement of file.statements) {
    let specifier: ts.Expression | undefined;
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword
    ) {
      specifier = statement.moduleSpecifier;
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      specifier = statement.moduleSpecifier;
    }
    if (specifier !== undefined && ts.isStringLiteral(specifier)) specifiers.push(specifier.text);
  }
  return specifiers;
}

/** Every module `entry` loads, as the hook resolves it, and every bare specifier on the way. */
async function importGraph(entry: string): Promise<{ files: string[]; external: string[] }> {
  const files = new Set<string>();
  const external = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeSpecifiers(file, await readFile(file, 'utf8'))) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        external.add(specifier);
        continue;
      }
      const target = resolve(dirname(file), specifier);
      pending.push(existsSync(target) ? target : target.replace(/\.js$/, '.ts'));
    }
  }
  return {
    files: [...files].map((file) => relative(ROOT, file).split(sep).join('/')).sort(compareStrings),
    external: [...external].sort(compareStrings),
  };
}

describe('the issue sync', () => {
  it('imports only Node.js built-ins, so its job needs no install', async () => {
    for (const entry of [SYNC, HOOKS]) {
      const { external } = await importGraph(entry);
      expect(external.filter((specifier) => !module.isBuiltin(specifier))).toEqual([]);
      expect(external.every((specifier) => specifier.startsWith('node:'))).toBe(true);
    }
    const { files } = await importGraph(SYNC);
    expect(files).toContain('scripts/drift/issues.ts');
    expect(files).toContain('src/report/sanitize.ts');
  });

  it('finds a dependency in what it imports', () => {
    const source = [
      "import { a } from 'yaml';",
      "import type { B } from 'mdast';",
      "export { c } from './c.js';",
    ].join('\n');
    expect(runtimeSpecifiers('x.ts', source)).toEqual(['yaml', './c.js']);
  });

  // The hooks need module.registerHooks and type stripping: Node.js 22.18 or later, the version
  // of .node-version that the workflow runs. Older supported versions skip the run.
  const canStripTypes = typeof module.registerHooks === 'function' && process.features.typescript;
  it.skipIf(!canStripTypes)('runs on Node.js alone through the hooks', () => {
    // --import takes a URL: on Windows an absolute path would read as one with the scheme `c:`.
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(HOOKS).href, SYNC], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage: node --import ./scripts/drift/ts-hooks.ts');
  });
});
