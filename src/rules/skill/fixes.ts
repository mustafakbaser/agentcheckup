/**
 * Fixes shared by the skill rules (docs/adr/0008-write-fixes-to-the-scanned-repository.md).
 *
 * Ground rules for every skill fix:
 * - A file reached through a symlink is never edited, and a skill whose SKILL.md has symlink
 *   aliases never gets a new `name`: each alias directory may need a different one.
 * - Names come from {@link skillSlug} or the directory name, and are written only when they are
 *   valid Agent Skills names without a reserved word. A name with non-ASCII letters, a directory
 *   rename, or a SKILL.md at a plugin root or the scan root is left to the user.
 * - Text copied from the body goes through {@link safeCopiedText} and is written double-quoted;
 *   the rules never write prose of their own.
 * - Frontmatter edits use the builders in src/fix/edits.ts, which parse their own result again.
 */
import type { Artifact, Fix } from '../../core/types.js';
import {
  MAX_SKILL_NAME_LENGTH,
  safeCopiedText,
  skillSlug,
  yamlSetScalar,
} from '../../fix/index.js';
import { pluginRootOf } from '../../platforms/location.js';
import { quote } from '../shared/format.js';
import type { SkillScope, ValidFrontmatter } from './shared.js';
import { normalizeName, reached, skillDirectory, skillDirectoryName } from './shared.js';

// ---------------------------------------------------------------------------------------------
// What a fix may touch
// ---------------------------------------------------------------------------------------------

/** True when a fix may edit the skill's file: it was not reached through a symlink. */
export function editable(artifact: Artifact): boolean {
  return artifact.file.symlinkTarget === undefined && artifact.realPath === artifact.path;
}

/**
 * True when a fix may give the skill a name: its file is editable and no symlink alias puts it
 * in another directory, whose name the new name would have to match too.
 */
export function nameable(artifact: Artifact): boolean {
  return editable(artifact) && artifact.aliases.length === 0;
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/** Words the Claude API and claude.ai upload reject in a skill name. */
export const RESERVED_NAME_WORDS = ['anthropic', 'claude'] as const;

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LETTER_DIGIT_OR_MARK = /^[\p{L}\p{M}\p{N}]$/u;

/** True for a name every agent and validator accepts: 1 to 64 of `a-z`, `0-9` and single `-`. */
export function isValidSkillName(name: string): boolean {
  return name.length <= MAX_SKILL_NAME_LENGTH && SKILL_NAME.test(name);
}

/** True when the name contains a word the Claude API and claude.ai upload reject. */
export function hasReservedWord(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_NAME_WORDS.some((word) => lower.includes(word));
}

/**
 * True when the NFKC form of `name` has letters, digits or combining marks outside ASCII, which
 * {@link skillSlug} would drop: only the author can choose their ASCII form.
 */
export function hasNonAsciiLetters(name: string): boolean {
  for (const char of normalizeName(name).toLowerCase()) {
    if ((char.codePointAt(0) ?? 0) > 0x7f && LETTER_DIGIT_OR_MARK.test(char)) return true;
  }
  return false;
}

/** True when SKILL.md sits at a plugin root, whose `name` deliberately differs from the folder. */
export function atPluginRoot(scope: SkillScope, artifact: Artifact): boolean {
  return pluginRootOf(scope.snapshot, artifact.path)?.root === skillDirectory(artifact.path);
}

/** The note every name fix prints: Claude Code's `/name` command changes with the name. */
function slashCommandNote(
  scope: SkillScope,
  artifact: Artifact,
  before: string,
  after: string,
): string[] {
  if (reached(scope, artifact, ['claude-code']).length === 0) return [];
  return [
    `Claude Code's command for this skill changes from ${quote(`/${before}`)} to ${quote(`/${after}`)}.`,
  ];
}

/** A fix, or a manual step, for a finding. */
export interface FixOrGuidance {
  readonly fix?: Fix;
  readonly guidance?: string;
}

/** `fix` and `guidance` for a report descriptor, leaving out what is undefined. */
export function fixFields(found: FixOrGuidance): FixOrGuidance {
  return {
    ...(found.fix === undefined ? {} : { fix: found.fix }),
    ...(found.guidance === undefined ? {} : { guidance: found.guidance }),
  };
}

const MANUAL_RENAME =
  'rename the skill with lowercase ASCII letters, digits and hyphens, and rename its directory to match';

/**
 * Sets `name` so that it follows the naming rules and matches the skill directory, for
 * skill/name-format and skill/name-dir-mismatch:
 * - `safe` (`#slug`) when {@link skillSlug} of the name is the directory name;
 * - `review` (`#directory`) when the directory has a valid name that the slug is not;
 * - a manual step for a name with non-ASCII letters, a reserved word, a symlink alias, an
 *   invalid directory name (directories are never renamed), or a SKILL.md at a plugin root or
 *   the scan root.
 */
export function nameFix(
  scope: SkillScope,
  artifact: Artifact,
  frontmatter: ValidFrontmatter,
  ruleId: string,
  raw: string,
): FixOrGuidance {
  const slug = skillSlug(raw);
  const suggestion = isValidSkillName(slug) && !hasReservedWord(slug) ? slug : undefined;
  const directory = skillDirectoryName(artifact.path);
  if (hasNonAsciiLetters(raw)) return { guidance: MANUAL_RENAME };
  if (!nameable(artifact)) {
    return {
      guidance:
        'choose a name that matches the directory of the skill and of every symlink to it, and rename directories as needed',
    };
  }
  if (directory === undefined || atPluginRoot(scope, artifact)) {
    return suggestion === undefined
      ? { guidance: MANUAL_RENAME }
      : { guidance: `set "name" to ${quote(suggestion)}` };
  }
  if (!isValidSkillName(directory)) {
    return suggestion === undefined
      ? { guidance: MANUAL_RENAME }
      : { guidance: `rename the directory to ${quote(suggestion)} and set "name" to match` };
  }
  if (hasReservedWord(directory)) {
    return {
      guidance: 'choose a name without "anthropic" or "claude", and rename the directory to match',
    };
  }
  const exact = slug === directory;
  const change = yamlSetScalar(artifact, frontmatter, 'name', directory);
  if (change === undefined) return { guidance: `set "name" to ${quote(directory)}` };
  return {
    fix: {
      id: `${ruleId}#${exact ? 'slug' : 'directory'}`,
      class: exact ? 'safe' : 'review',
      title: `Set "name" to ${quote(directory)} in ${artifact.path}`,
      changes: [change],
      notes: slashCommandNote(scope, artifact, raw.trim(), directory),
    },
  };
}

/**
 * The directory name when a skill may take it as its `name`: the skill is nameable, sits in a
 * directory with a valid name without a reserved word. Undefined otherwise.
 */
export function directoryAsName(artifact: Artifact): string | undefined {
  if (!nameable(artifact)) return undefined;
  const directory = skillDirectoryName(artifact.path);
  if (directory === undefined || !isValidSkillName(directory) || hasReservedWord(directory)) {
    return undefined;
  }
  return directory;
}

// ---------------------------------------------------------------------------------------------
// Descriptions copied from the body
// ---------------------------------------------------------------------------------------------

/** An ATX heading marker: 1 to 6 `#` before a space, a tab or the end of the line. */
const HEADING = /^#{1,6}(?=[\t ]|$)/;
const BULLET = /^[*+-](?=[\t ])/;
const ORDERED = /^\d{1,9}[.)](?=[\t ])/;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/** `text` without leading spaces and tabs. */
function trimStartBlank(text: string): string {
  let start = 0;
  while (start < text.length && (text.charAt(start) === ' ' || text.charAt(start) === '\t')) {
    start++;
  }
  return text.slice(start);
}

/** `text` without a heading's closing sequence: trailing `#` after a space or a tab. */
function withoutClosingHashes(text: string): string {
  const trimmed = text.trimEnd();
  let end = trimmed.length;
  while (end > 0 && trimmed.charAt(end - 1) === '#') end--;
  if (end === trimmed.length) return trimmed;
  if (end === 0) return '';
  const before = trimmed.charAt(end - 1);
  return before === ' ' || before === '\t' ? trimmed.slice(0, end) : trimmed;
}

/**
 * The description to copy from a body: its first non-empty line, the text Claude Code uses when
 * `description` is omitted, without a heading or list marker, cut to 200 characters. Undefined
 * when that line is a code fence, indented code or an HTML comment, has no letter or digit, or
 * holds a control, bidirectional, tag or other invisible character ({@link safeCopiedText}).
 */
export function copiedDescription(body: string): string | undefined {
  let line: string | undefined;
  for (const candidate of body.split('\n')) {
    const content = candidate.endsWith('\r') ? candidate.slice(0, -1) : candidate;
    if (content.trim() !== '') {
      line = content;
      break;
    }
  }
  if (line === undefined) return undefined;
  if (line.startsWith('\t') || line.startsWith('    ')) return undefined;
  let text = trimStartBlank(line);
  if (text.startsWith('```') || text.startsWith('~~~') || text.startsWith('<!--')) {
    return undefined;
  }
  const heading = HEADING.exec(text)?.[0];
  if (heading !== undefined) {
    text = withoutClosingHashes(text.slice(heading.length));
  } else {
    const marker = BULLET.exec(text)?.[0] ?? ORDERED.exec(text)?.[0];
    if (marker !== undefined) text = text.slice(marker.length);
  }
  const copied = safeCopiedText(text);
  return copied !== undefined && ALPHANUMERIC.test(copied) ? copied : undefined;
}

/** The note of a fix that copies a description from the body. */
export const COPIED_NOTE =
  'Copied from the first line of the body; reword it to say what the skill does and when to use it.';
