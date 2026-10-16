import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix, joinRelative, normalizeRelative, pathStatus } from '../../core/paths.js';
import type { Artifact, FileChange, Fix, Snapshot, Span } from '../../core/types.js';
import { replaceSpan } from '../../fix/index.js';
import type { MarkdownLink } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { quotePath } from '../shared/format.js';
import { editable, type FixOrGuidance, fixFields } from './fixes.js';
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

/** A listed path, and how many listed paths share its lower-cased form. */
interface CaseEntry {
  readonly path: string;
  count: number;
}

/** Lower-cased path -> the first path as listed, built on first use. */
function caseIndex(snapshot: Snapshot): ReadonlyMap<string, CaseEntry> {
  const index = new Map<string, CaseEntry>();
  for (const entry of snapshot.paths) {
    const path = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const key = path.toLowerCase();
    const found = index.get(key);
    if (found === undefined) index.set(key, { path, count: 1 });
    else found.count++;
  }
  return index;
}

const QUERY_OR_FRAGMENT = /[?#]/;
/** Characters a backslash escapes in Markdown (CommonMark: ASCII punctuation). */
const ASCII_PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const BACKSLASH = '\\';

/**
 * Where the link's destination is written: the one place in the link's source where its URL
 * appears verbatim right after `](` (a link or image) or `]:` (a definition), optionally in
 * angle brackets, followed by the end of the destination. Undefined when the destination is
 * written with escapes or entities, so the URL does not appear there as it is.
 */
function destinationSpan(text: string, link: MarkdownLink): Span | undefined {
  const { url } = link;
  if (url === '') return undefined;
  const source = text.slice(link.span.offset, link.span.offset + link.span.length);
  let found: number | undefined;
  for (let at = source.indexOf(url); at !== -1; at = source.indexOf(url, at + 1)) {
    let before = source.slice(0, at).trimEnd();
    let after = source.slice(at + url.length);
    if (before.endsWith('<')) {
      if (!after.startsWith('>')) continue;
      before = before.slice(0, -1).trimEnd();
      after = after.slice(1);
    }
    const next = after.charAt(0);
    const blank = next !== '' && next.trim() === '';
    const delimited =
      link.kind === 'definition'
        ? before.endsWith(']:') && (after === '' || blank)
        : before.endsWith('](') && (next === ')' || blank);
    if (!delimited) continue;
    if (found !== undefined) return undefined;
    found = at;
  }
  return found === undefined ? undefined : { offset: link.span.offset + found, length: url.length };
}

/**
 * Replaces the path part of the link's destination (before any query or fragment) with
 * `rewrite(path)`. Undefined when the destination cannot be located, holds percent-escapes, or
 * holds a backslash before punctuation, which Markdown reads as an escape.
 */
function rewriteLink(
  artifact: Artifact,
  link: MarkdownLink,
  rewrite: (path: string) => string | undefined,
): FileChange | undefined {
  const span = destinationSpan(artifact.decoded.text, link);
  if (span === undefined) return undefined;
  const { url } = link;
  const end = url.search(QUERY_OR_FRAGMENT);
  const head = end === -1 ? url : url.slice(0, end);
  if (head.includes('%')) return undefined;
  for (let i = 0; i + 1 < head.length; i++) {
    if (head.charAt(i) === BACKSLASH && ASCII_PUNCTUATION.includes(head.charAt(i + 1))) {
      return undefined;
    }
  }
  const replaced = rewrite(head);
  if (replaced === undefined || replaced === head) return undefined;
  return replaceSpan(artifact, span, `${replaced}${url.slice(head.length)}`);
}

/** Writes the link with `/` instead of backslashes (`safe`). */
function slashesFix(artifact: Artifact, link: MarkdownLink, path: string): FixOrGuidance {
  const guidance = `change the link to ${quotePath(path.replaceAll(BACKSLASH, '/'))}`;
  if (!editable(artifact)) return { guidance };
  const change = rewriteLink(artifact, link, (head) => head.replaceAll(BACKSLASH, '/'));
  if (change === undefined) return { guidance };
  const fix: Fix = {
    id: 'skill/broken-reference#slashes',
    class: 'safe',
    title: `Replace the backslashes in the link ${quotePath(path)} with "/"`,
    changes: [change],
  };
  return { fix, guidance };
}

/**
 * Writes the link in the letter case of the one file it matches case-insensitively (`review`),
 * when the link is a plain path below the skill directory.
 */
function caseFix(
  artifact: Artifact,
  link: MarkdownLink,
  path: string,
  directory: string,
  match: CaseEntry,
): FixOrGuidance {
  const prefix = directory === '' ? '' : `${directory}/`;
  const relative = match.path.startsWith(prefix) ? match.path.slice(prefix.length) : undefined;
  const guidance =
    relative === undefined
      ? `change the link or rename the file so that they match ${quotePath(match.path)} letter for letter`
      : `change the link to ${quotePath(relative)}`;
  if (!editable(artifact) || relative === undefined || match.count !== 1) return { guidance };
  const change = rewriteLink(artifact, link, (head) => {
    if (head !== path) return undefined;
    const dot = head.startsWith('./') ? './' : '';
    const written = head.slice(dot.length);
    const fits =
      written.length === relative.length && written.toLowerCase() === relative.toLowerCase();
    return fits ? `${dot}${relative}` : undefined;
  });
  if (change === undefined) return { guidance };
  const fix: Fix = {
    id: 'skill/broken-reference#case',
    class: 'review',
    title: `Change the link ${quotePath(path)} to ${quotePath(relative)}`,
    changes: [change],
  };
  return { fix, guidance };
}

const MOVE_INTO_SKILL =
  'move the file into the skill directory and link to it relative to SKILL.md';

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
    fix: {
      classes: ['safe', 'review'],
      summary:
        'Replaces backslashes in a link with `/` (safe), or writes the link in the letter case of the only file it matches (review). Other broken links are left to you.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    let index: ReadonlyMap<string, CaseEntry> | undefined;
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
        let repair: FixOrGuidance | undefined;
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
            guidance: `copy ${quotePath(fromRoot)} into the skill directory and link to it relative to SKILL.md`,
          });
          continue;
        }
        if (status === 'missing' && resolved !== undefined) {
          missing = true;
          const forward = path.includes('\\')
            ? joinRelative(directory, path.replaceAll('\\', '/'))
            : undefined;
          index ??= caseIndex(context.snapshot);
          const own = index.get(resolved.toLowerCase());
          const match =
            own ?? (fromReal === undefined ? undefined : index.get(fromReal.toLowerCase()));
          if (forward !== undefined && pathStatus(context.snapshot, forward) === 'exists') {
            message = `Linked file ${quotePath(path)} uses backslashes, so agents on Linux and macOS find no file. Write ${quotePath(path.replaceAll('\\', '/'))}.`;
            const forwardInside =
              directory === '' || forward === directory || forward.startsWith(`${directory}/`);
            repair = forwardInside
              ? slashesFix(artifact, link, path)
              : { guidance: `change the link to ${quotePath(path.replaceAll(BACKSLASH, '/'))}` };
          } else if (match !== undefined) {
            message = `Linked file ${quotePath(path)} does not exist; ${quotePath(match.path)} differs only in letter case. The link works on macOS and Windows but not on Linux.`;
            repair =
              own === undefined
                ? {
                    guidance: `change the link to match ${quotePath(match.path)} letter for letter`,
                  }
                : caseFix(artifact, link, path, directory, own);
          } else {
            message = `Linked file ${quotePath(path)} does not exist${inside ? '' : ' (the path leaves the skill directory)'}, so an agent that follows the link finds nothing.`;
            repair = {
              guidance: inside
                ? `create ${quotePath(resolved)} or correct the link`
                : MOVE_INTO_SKILL,
            };
          }
        } else if (
          !inside &&
          !(resolved !== undefined && inOtherSkill(context.snapshot, resolved, directory))
        ) {
          message = `Link ${quotePath(path)} leaves the skill directory, so it breaks when the skill is installed or uploaded on its own.`;
          repair = { guidance: MOVE_INTO_SKILL };
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
          ...(repair === undefined ? {} : fixFields(repair)),
        });
      }
    }
  },
});
