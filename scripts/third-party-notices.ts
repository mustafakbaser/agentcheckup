/**
 * Writes THIRD_PARTY_NOTICES.md for every npm package bundled into dist/.
 *
 * The published package has zero dependencies because tsdown bundles them, which means their
 * license notices must ship with our files. The list is derived from the bundle's source maps,
 * so it always matches what was actually bundled.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

interface PackageInfo {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly directory: string;
}

const LICENSE_FILES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENSE-MIT',
  'LICENSE-MIT.txt',
  'LICENCE',
  'license',
  'license.md',
  'license.txt',
];

function packageDirectoryOf(source: string): string | undefined {
  const marker = 'node_modules/';
  const index = source.lastIndexOf(marker);
  if (index === -1) return undefined;
  const rest = source.slice(index + marker.length);
  const parts = rest.split('/');
  const nameParts = parts[0]?.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
  return source.slice(0, index + marker.length) + nameParts.join('/');
}

async function readPackage(directory: string): Promise<PackageInfo> {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    license?: string;
  };
  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license ?? 'UNKNOWN',
    directory,
  };
}

async function licenseText(directory: string): Promise<string | undefined> {
  for (const file of LICENSE_FILES) {
    const text = await readFile(join(directory, file), 'utf8').catch(() => undefined);
    if (text !== undefined) return text.trim();
  }
  return undefined;
}

const directories = new Set<string>();
for (const entry of await readdir(dist)) {
  if (!entry.endsWith('.js.map')) continue;
  const map = JSON.parse(await readFile(join(dist, entry), 'utf8')) as { sources: string[] };
  for (const source of map.sources) {
    const directory = packageDirectoryOf(source);
    if (directory !== undefined) directories.add(join(dist, directory));
  }
}

const packages = (await Promise.all([...directories].map(readPackage))).sort((a, b) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
);

const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD']);
const sections: string[] = [];
for (const pkg of packages) {
  if (!ALLOWED.has(pkg.license)) {
    throw new Error(
      `${pkg.name}@${pkg.version} has license "${pkg.license}", which is not allowed.`,
    );
  }
  const text = await licenseText(pkg.directory);
  if (text === undefined) throw new Error(`No license file found for ${pkg.name}@${pkg.version}.`);
  sections.push(`## ${pkg.name}@${pkg.version} (${pkg.license})\n\n\`\`\`text\n${text}\n\`\`\``);
}

await writeFile(
  join(root, 'THIRD_PARTY_NOTICES.md'),
  `# Third-party notices\n\nagentcheckup bundles the following packages. Their licenses follow.\n\n${sections.join('\n\n')}\n`,
  'utf8',
);
process.stdout.write(`THIRD_PARTY_NOTICES.md: ${packages.length} bundled packages\n`);
