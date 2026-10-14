import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix, joinRelative, normalizeRelative, pathStatus } from '../../core/paths.js';
import type { Snapshot } from '../../core/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { quotePath } from '../shared/format.js';
import {
  impactsOn,
  isDistributable,
  loadableSkills,
  resolveImpacts,
  SKILL_PLATFORMS,
  skillDirectory,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

const SCHEME = /^[a-z][a-z\d+.-]*:/i;
/** Templates, placeholders and globs: `${CLAUDE_SKILL_DIR}`, `<file>`, `*.md`. */
const NOT_A_PATH = /[$*<>{}]/;

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The local path a link points to, decoded, without query or fragment. Undefined for links
 * that are not relative file paths: web and mail links, fragments, absolute and home paths,
 * templates and placeholders.
 */
export function relativeLinkPath(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === '' || trimmed.startsWith('#') || SCHEME.test(trimmed)) return undefined;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || trimmed.startsWith('~')) {
    return undefined;
  }
  const end = trimmed.search(/[?#]/);
  const raw = end === -1 ? trimmed : trimmed.slice(0, end);
  if (raw === '') return undefined;
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (NOT_A_PATH.test(path) || hasControlCharacter(path)) return undefined;
  // Placeholders in examples: `[link](url)`, `[file](path/to/file.md)`. A file reference has an
  // extension or a directory part.
  if (!/[./\\]/.test(path) || path.startsWith('path/to/') || path.includes('/path/to/')) {
    return undefined;
  }
  return path;
}

/**
 * True when `path` lies in a skill directory other than `own`: a link from one skill of a
 * collection to another works wherever both skills are installed side by side.
 */
function inOtherSkill(snapshot: Snapshot, path: string, own: string): boolean {
  for (let directory = path; ; directory = dirnamePosix(directory)) {
    const manifest = directory === '' ? 'SKILL.md' : `${directory}/SKILL.md`;
    if (directory !== own && snapshot.paths.has(manifest)) return true;
    if (directory === '') return false;
  }
}

/** Lower-cased path -> path as listed, built on first use. */
function caseIndex(snapshot: Snapshot): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const entry of snapshot.paths) {
    const path = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const key = path.toLowerCase();
    if (!index.has(key)) index.set(key, path);
  }
  return index;
}

export const brokenReferenceRule = defineRule({
  meta: {
    id: 'skill/broken-reference',
    title: 'Skill links to a missing file or outside its directory',
    rationale: `SKILL.md links to supporting files with paths relative to the skill directory, as the Agent Skills specification asks. A link to a missing file leads the agent nowhere. A path that differs from the file only in letter case works on macOS and Windows but not on Linux, and backslashes do not separate directories on Linux or macOS. Skills are installed and uploaded one directory at a time, so a link that leaves the skill directory, such as \`../shared/style.md\`, breaks when the skill is installed on its own.

Not reported: links into another skill of the same collection, and, for a skill used in this repository, paths that exist relative to the repository root. In a symlinked SKILL.md, a link that resolves from the real file's directory counts as found.

Fix the path, or move the file into the skill directory.`,
    category: 'correctness',
    severity: 'error',
    appliesTo: ['skill'],
    platforms: SKILL_PLATFORMS,
    sources: [
      SOURCES.agentSkillsSpec,
      SOURCES.claudeSkills,
      SKILL_SOURCES.vscodeSkills,
      SKILL_SOURCES.claudeSkillBestPractices,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    let index: ReadonlyMap<string, string> | undefined;
    for (const artifact of loadableSkills(context)) {
      const directory = skillDirectory(artifact.path);
      for (const link of context.markdown(artifact).links) {
        const path = relativeLinkPath(link.url);
        if (path === undefined) continue;
        const resolved = joinRelative(directory, path);
        const inside =
          resolved !== undefined &&
          (directory === '' || resolved === directory || resolved.startsWith(`${directory}/`));
        let status = resolved === undefined ? 'unknown' : pathStatus(context.snapshot, resolved);
        // A SKILL.md reached through a symlink may be written relative to its real location,
        // which is where an agent that resolves the link looks.
        const fromReal =
          artifact.realPath === artifact.path
            ? undefined
            : joinRelative(skillDirectory(artifact.realPath), path);
        if (
          status === 'missing' &&
          fromReal !== undefined &&
          pathStatus(context.snapshot, fromReal) === 'exists'
        ) {
          status = 'exists';
        }

        let message: string | undefined;
        let missing = false;
        // Agents run from the repository root, so a root-relative path that exists there works
        // for a skill used in place. Only a skill installed elsewhere loses it.
        const fromRoot = directory === '' ? undefined : normalizeRelative(path);
        const rootRelative =
          status === 'missing' &&
          fromRoot !== undefined &&
          fromRoot !== '' &&
          pathStatus(context.snapshot, fromRoot) === 'exists';
        if (rootRelative) {
          if (!isDistributable(context, artifact)) continue;
          const advice = resolveImpacts(
            context,
            artifact,
            impactsOn(SKILL_PLATFORMS, 'info', 'distribution'),
          );
          if (advice === undefined) continue;
          context.report({
            artifact,
            message: `Linked file ${quotePath(path)} exists only relative to the repository root, not to the skill directory. The link breaks when the skill is installed or uploaded on its own.`,
            severity: advice.severity,
            platforms: advice.platforms,
            span: link.span,
          });
          continue;
        }
        if (status === 'missing' && resolved !== undefined) {
          missing = true;
          const forward = path.includes('\\')
            ? joinRelative(directory, path.replaceAll('\\', '/'))
            : undefined;
          index ??= caseIndex(context.snapshot);
          const sameLetters =
            index.get(resolved.toLowerCase()) ??
            (fromReal === undefined ? undefined : index.get(fromReal.toLowerCase()));
          if (forward !== undefined && pathStatus(context.snapshot, forward) === 'exists') {
            message = `Linked file ${quotePath(path)} uses backslashes, so agents on Linux and macOS find no file. Write ${quotePath(path.replaceAll('\\', '/'))}.`;
          } else if (sameLetters !== undefined) {
            message = `Linked file ${quotePath(path)} does not exist; ${quotePath(sameLetters)} differs only in letter case. The link works on macOS and Windows but not on Linux.`;
          } else {
            message = `Linked file ${quotePath(path)} does not exist${inside ? '' : ' (the path leaves the skill directory)'}, so an agent that follows the link finds nothing.`;
          }
        } else if (
          !inside &&
          !(resolved !== undefined && inOtherSkill(context.snapshot, resolved, directory))
        ) {
          message = `Link ${quotePath(path)} leaves the skill directory, so it breaks when the skill is installed or uploaded on its own.`;
        }
        if (message === undefined) continue;

        const resolvedImpacts = resolveImpacts(
          context,
          artifact,
          missing
            ? impactsOn(SKILL_PLATFORMS, 'error')
            : impactsOn(SKILL_PLATFORMS, 'warn', 'distribution'),
        );
        if (resolvedImpacts === undefined) continue;
        context.report({
          artifact,
          message,
          severity: resolvedImpacts.severity,
          platforms: resolvedImpacts.platforms,
          span: link.span,
        });
      }
    }
  },
});
