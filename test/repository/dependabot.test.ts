/**
 * .github/dependabot.yml keeps the packages bundled into dist/ in their own group, so a bump of
 * code users run is not filed with the build tools (docs/maintainers/releasing.md).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { compareStrings } from '../../src/core/compare.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The package a bare module specifier names: `yaml`, `@scope/name`, `jsonc-parser/x` -> `jsonc-parser`. */
function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('node:')) return undefined;
  const parts = specifier.split('/');
  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
}

/** Packages that code in `source` imports or re-exports at runtime; type-only imports do not count. */
function runtimeImports(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const names: string[] = [];
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
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    const name = packageName(specifier.text);
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** Every package the code in src/ imports at runtime, which tsdown bundles. */
async function bundledPackages(): Promise<string[]> {
  const names = new Set<string>();
  const entries = await readdir(join(ROOT, 'src'), { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const path = join(entry.parentPath, entry.name);
    for (const name of runtimeImports(path, await readFile(path, 'utf8'))) names.add(name);
  }
  return [...names].sort(compareStrings);
}

interface Group {
  readonly patterns?: string[];
  readonly 'dependency-type'?: string;
}

async function npmGroups(): Promise<[string, Group][]> {
  const config = parse(await readFile(join(ROOT, '.github', 'dependabot.yml'), 'utf8')) as {
    updates: { 'package-ecosystem': string; groups?: Record<string, Group> }[];
  };
  const npm = config.updates.find((update) => update['package-ecosystem'] === 'npm');
  return Object.entries(npm?.groups ?? {});
}

describe('Dependabot groups', () => {
  it('lists every bundled package in the bundled group, which comes first', async () => {
    const bundled = await bundledPackages();
    const groups = await npmGroups();
    expect(groups.map(([name]) => name)).toEqual(['bundled', 'development']);
    expect([...(groups[0]?.[1].patterns ?? [])].sort(compareStrings)).toEqual(bundled);
  });

  it('finds the bundled packages, and only those', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const bundled = await bundledPackages();
    expect(bundled).toContain('yaml');
    expect(bundled).not.toContain('vitest');
    expect(manifest.dependencies).toBeUndefined();
    for (const name of bundled) expect(Object.keys(manifest.devDependencies)).toContain(name);
  });

  it('counts runtime imports and re-exports, not type-only ones', () => {
    const source = [
      "import { parse } from 'yaml';",
      "import type { Root } from 'mdast';",
      "import { type Options } from 'picomatch';",
      "export { x } from '@scope/pkg/sub';",
      "export type { Y } from 'typed-only';",
      "import { readFile } from 'node:fs/promises';",
      "import { local } from './local.js';",
    ].join('\n');
    expect(runtimeImports('x.ts', source)).toEqual(['yaml', 'picomatch', '@scope/pkg']);
  });
});
