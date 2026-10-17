/**
 * The agentcheckup skill as it is in the repository (skills/agentcheckup), which is what the
 * package ships and release-please bumps.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGED_SKILL, SKILL_FILES } from '../../src/cli/skill.js';
import { parseFrontmatter } from '../../src/parse/frontmatter.js';

/** The repository root, which is also the package root. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** skills/agentcheckup in the repository. */
export const SKILL_DIR = join(REPO_ROOT, ...PACKAGED_SKILL.split('/'));

/** The version in package.json, which release-please bumps. */
export async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

/** Each file of the skill, by its path in the skill directory, as bytes. */
export async function skillBytes(): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const path of SKILL_FILES) {
    files.set(path, new Uint8Array(await readFile(join(SKILL_DIR, ...path.split('/')))));
  }
  return files;
}

export async function skillText(path = 'SKILL.md'): Promise<string> {
  return readFile(join(SKILL_DIR, ...path.split('/')), 'utf8');
}

/** Every file below `directory`, as POSIX paths relative to it, sorted. */
export async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/** The frontmatter values of SKILL.md text; throws when it is not valid. */
export function frontmatterOf(text: string): Readonly<Record<string, unknown>> {
  const parsed = parseFrontmatter(text);
  if (parsed.kind !== 'valid') throw new Error(`SKILL.md frontmatter is ${parsed.kind}`);
  return parsed.data.values;
}

/** The text after the frontmatter. */
export function bodyOf(text: string): string {
  const end = text.indexOf('\n---\n', 4);
  if (!text.startsWith('---\n') || end === -1) throw new Error('SKILL.md has no frontmatter');
  return text.slice(end + '\n---\n'.length);
}
