/**
 * How Gemini CLI reads a SKILL.md, from packages/core/src/skills/skillLoader.ts
 * (SOURCES.geminiSkillLoaderSource) as the skill rules model it: the frontmatter must start on
 * line 1, and a skill without string `name` and `description` values is skipped; YAML that does
 * not parse, or values that are not text, are read again line by line. The skill rules use
 * {@link geminiSkipReasons} to say what Gemini CLI does with a skill, and the Gemini CLI load plan
 * uses {@link geminiSkillVerdict}, built on it, to say whether Gemini CLI lists the skill, so both
 * always agree.
 *
 * The rules' model predates the loader at google-gemini/gemini-cli ed96fae, which also accepts a
 * byte order mark before the opening `---` and closes the block only at a line that is `---` and
 * optional spaces. The plan marks the claims that differ as unverified.
 */
import { lineText } from '../core/text.js';
import type { DecodedText } from '../core/types.js';
import type { FrontmatterResult } from '../parse/types.js';
import { bomHidesFrontmatter, frontmatterYaml, invalidCause } from './codex-skills.js';

/**
 * Why Gemini CLI skips a skill, in the order it reads the file:
 * - `no-frontmatter`: no block that starts on line 1 and is closed (skill/frontmatter-missing).
 * - `unsupported`: the block opens with `+++` or `---js` (skill/frontmatter-invalid).
 * - `bom`: a byte order mark comes before the opening `---` (skill/frontmatter-bom).
 * - `not-a-mapping`: the YAML is a list or a scalar (skill/frontmatter-invalid).
 * - `no-description`, `no-name`: the YAML has no `description` or `name` key
 *   (skill/description-missing, skill/name-missing).
 */
export type GeminiSkipReason =
  'no-frontmatter' | 'unsupported' | 'bom' | 'not-a-mapping' | 'no-description' | 'no-name';

/**
 * True when a line after line 1 starts with `---`, where Gemini CLI's frontmatter pattern ends an
 * unclosed block (`\n---` without an end-of-line check).
 */
export function geminiClosesFrontmatter(decoded: DecodedText): boolean {
  for (let line = 2; line <= decoded.lineStarts.length; line++) {
    if (lineText(decoded, line).startsWith('---')) return true;
  }
  return false;
}

/**
 * Every reason Gemini CLI has to skip the skill, in reading order; empty when it lists the skill
 * as far as the rules can tell. A rule names Gemini CLI as skipping the skill when its reason is
 * in the list, so a skill with two problems is reported by both rules.
 */
export function geminiSkipReasons(
  result: FrontmatterResult,
  decoded: DecodedText,
): GeminiSkipReason[] {
  switch (result.kind) {
    case 'absent':
      return ['no-frontmatter'];
    case 'unclosed':
      return geminiClosesFrontmatter(decoded) ? [] : ['no-frontmatter'];
    case 'unsupported':
      return ['unsupported'];
    case 'invalid': {
      const reasons: GeminiSkipReason[] = bomHidesFrontmatter(decoded, result) ? ['bom'] : [];
      if (invalidCause(decoded.text, result)?.kind === 'not-a-mapping')
        reasons.push('not-a-mapping');
      return reasons;
    }
    case 'valid': {
      const reasons: GeminiSkipReason[] = bomHidesFrontmatter(decoded, result) ? ['bom'] : [];
      const { keys } = result.data;
      if (!keys.includes('description')) reasons.push('no-description');
      if (!keys.includes('name')) reasons.push('no-name');
      return reasons;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The skill as Gemini CLI lists it
// ---------------------------------------------------------------------------------------------

/**
 * What Gemini CLI does with one SKILL.md:
 * - `listed`, with the name and description it lists. `fields` says where they come from:
 *   `yaml` when the YAML gives both as text; `lines` when Gemini CLI read them line by line;
 *   `unknown` when the block ends where only the rules' older model of the loader ends it.
 * - `skipped`, for the first of {@link geminiSkipReasons}, or `no-fields` when the line-by-line
 *   reading finds no `name:` or no `description:` line, which no rule reports.
 * - `unchecked`: agentcheckup's YAML parser gave up on the frontmatter.
 */
export type GeminiSkillVerdict =
  | {
      readonly kind: 'listed';
      readonly name: string;
      readonly description: string;
      readonly fields: 'yaml' | 'lines' | 'unknown';
    }
  | { readonly kind: 'skipped'; readonly reason: GeminiSkipReason | 'no-fields' }
  | { readonly kind: 'unchecked' };

/** Characters Gemini CLI replaces with `-` in a skill name (`sanitizedName`). */
const UNSAFE_NAME_CHARACTERS = /[":*/<>?\\|]/g;

function listed(
  name: string,
  description: string,
  fields: 'yaml' | 'lines' | 'unknown',
): GeminiSkillVerdict {
  return { kind: 'listed', name: name.replace(UNSAFE_NAME_CHARACTERS, '-'), description, fields };
}

/** Whether Gemini CLI lists the skill, and under which name and description. */
export function geminiSkillVerdict(
  result: FrontmatterResult,
  decoded: DecodedText,
): GeminiSkillVerdict {
  const [reason] = geminiSkipReasons(result, decoded);
  if (reason !== undefined) return { kind: 'skipped', reason };
  switch (result.kind) {
    case 'absent':
    case 'unsupported':
      // geminiSkipReasons always gives a reason for these.
      return { kind: 'skipped', reason: 'no-frontmatter' };
    case 'unclosed':
      return listed('', '', 'unknown');
    case 'invalid':
      if (invalidCause(decoded.text, result)?.kind === 'limit') return { kind: 'unchecked' };
      break;
    case 'valid': {
      const { name, description } = result.data.values;
      if (typeof name === 'string' && typeof description === 'string') {
        return listed(name, description, 'yaml');
      }
      break;
    }
  }
  const fields = geminiLineFields(frontmatterYaml(decoded.text));
  return fields === undefined
    ? { kind: 'skipped', reason: 'no-fields' }
    : listed(fields.name, fields.description, 'lines');
}

// ---------------------------------------------------------------------------------------------
// Reading `name:` and `description:` line by line (`parseSimpleFrontmatter`)
// ---------------------------------------------------------------------------------------------

const NAME_LINE = /^[\t ]*name[\t ]*:/i;
const DESCRIPTION_LINE = /^([\t ]*)description[\t ]*:/i;
const BLOCK_INDICATOR = /^[>|][-+]?$/;
const KNOWN_KEY_LINE = /^[\t ]*(?:name|description)[\t ]*:/i;
const COMMENT_LINE = /^[\t ]*#/;
const KEY_LINE = /^[\t ]*[\w-]+[\t ]*:/;
const LINE_BREAK = /\r?\n/;

function indentation(line: string): number {
  let count = 0;
  while (count < line.length && (line.charAt(count) === ' ' || line.charAt(count) === '\t')) {
    count++;
  }
  return count;
}

function withoutOuterQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value.charAt(0);
  return (first === '"' || first === "'") && value.endsWith(first) ? value.slice(1, -1) : value;
}

/**
 * The `name` and `description` Gemini CLI reads from frontmatter whose YAML does not give them as
 * text: the last `name:` line, and the last `description:` line with the more deeply indented
 * lines that continue it. Undefined when either line is missing, so Gemini CLI skips the skill.
 */
export function geminiLineFields(
  yaml: string,
): { readonly name: string; readonly description: string } | undefined {
  const lines = yaml.split(LINE_BREAK);
  let name: string | undefined;
  let description: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const nameMatch = NAME_LINE.exec(line);
    if (nameMatch !== null) {
      name = withoutOuterQuotes(line.slice(nameMatch[0].length).trim());
      continue;
    }
    const descriptionMatch = DESCRIPTION_LINE.exec(line);
    if (descriptionMatch === null) continue;
    const ownIndent = (descriptionMatch[1] ?? '').length;
    const first = line.slice(descriptionMatch[0].length).trim();
    const parts = BLOCK_INDICATOR.test(first) ? [] : [first];
    while (i + 1 < lines.length) {
      const next = lines[i + 1] ?? '';
      const indent = indentation(next);
      const continues =
        indent < next.length &&
        !KNOWN_KEY_LINE.test(next) &&
        !COMMENT_LINE.test(next) &&
        !(indent <= ownIndent && KEY_LINE.test(next));
      if (!continues) break;
      parts.push(next.trim());
      i++;
    }
    description = withoutOuterQuotes(parts.filter((part) => part !== '').join(' '));
  }
  return name === undefined || description === undefined ? undefined : { name, description };
}
