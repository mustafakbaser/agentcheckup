import { codePointLength } from '../../core/measure.js';
import { RULESET_VERSION } from '../../core/meta.js';
import type { PlatformId } from '../../core/types.js';
import { codexNameTooLong, nameNotText } from '../../platforms/codex-skills.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import {
  describeType,
  formatInteger,
  joinClauses,
  joinNames,
  quote,
  sentence,
} from '../shared/format.js';
import {
  type Impact,
  loadableSkills,
  normalizeName,
  placement,
  resolveImpacts,
  validFrontmatter,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';
import { type FixOrGuidance, fixFields, nameFix } from './fixes.js';

const MAX_NAME_LENGTH = 64;
/** Offending characters listed in a message. */
const MAX_LISTED = 3;

const ALLOWED = /^[a-z0-9-]$/;
const UPPERCASE = /^[\p{Lu}\p{Lt}]$/u;
/** Lowercase or caseless letters and numbers: Python's `isalnum()` accepts them (skills-ref). */
const OTHER_ALNUM = /^[\p{Ll}\p{Lm}\p{Lo}\p{N}]$/u;
/** Characters Claude Code refuses in a name: hidden, direction-changing, blank-like, < and >. */
const CLAUDE_REFUSED = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u2028\u2029<>]|[^\P{Z} ]/u;
const CLAUDE_REFUSED_SPACING = /^ | $| {2}/;
const PRINTABLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;

/** `"_"` for visible characters, `U+200B` for the rest. */
function showChar(char: string): string {
  if (char === ' ' || PRINTABLE.test(char)) return `"${char}"`;
  const code = char.codePointAt(0) ?? 0;
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

function listChars(chars: ReadonlySet<string>): string {
  return joinNames([...chars].slice(0, MAX_LISTED).map(showChar));
}

interface Analysis {
  readonly problems: string[];
  readonly consequences: string[];
  readonly impacts: Impact[];
}

/** The Agent Skills spec forbids the name: every validator and claude.ai upload reject it. */
const SPEC_INVALID: Impact = { platform: 'claude-code', severity: 'error', scope: 'distribution' };
/** Only the anthropics/skills packager rejects the name; skills-ref accepts it. */
const PACKAGER_ONLY: Impact = { platform: 'claude-code', severity: 'warn', scope: 'distribution' };

function analyze(
  raw: string,
  reaches: (platform: PlatformId) => boolean,
  distributable: boolean,
): Analysis | undefined {
  const name = normalizeName(raw);
  if (name === '') return undefined;
  const problems: string[] = [];

  const length = codePointLength(name);
  const tooLong = length > MAX_NAME_LENGTH;
  if (tooLong) {
    problems.push(`is ${formatInteger(length)} characters long (the limit is ${MAX_NAME_LENGTH})`);
  }

  const uppercase = new Set<string>();
  const nonAscii = new Set<string>();
  const invalid = new Set<string>();
  for (const char of raw.trim()) {
    if (ALLOWED.test(char)) continue;
    if (UPPERCASE.test(char)) uppercase.add(char);
    else if (OTHER_ALNUM.test(char)) nonAscii.add(char);
    else invalid.add(char);
  }
  if (uppercase.size > 0) problems.push('has uppercase letters');
  if (invalid.size > 0) {
    problems.push(
      `contains ${listChars(invalid)}, which ${invalid.size === 1 ? 'is' : 'are'} not a lowercase letter, digit or hyphen`,
    );
  }
  const badCharacters = uppercase.size > 0 || invalid.size > 0;
  if (nonAscii.size > 0) problems.push(`uses non-ASCII letters or digits (${listChars(nonAscii)})`);

  const starts = name.startsWith('-');
  const ends = name.endsWith('-');
  if (starts || ends) {
    problems.push(
      starts && ends
        ? 'starts and ends with a hyphen'
        : starts
          ? 'starts with a hyphen'
          : 'ends with a hyphen',
    );
  }
  const doubled = name.includes('--');
  if (doubled) problems.push('contains "--"');
  if (problems.length === 0) return undefined;

  const consequences: string[] = [];
  const impacts: Impact[] = [];
  // Codex collapses runs of whitespace before it counts characters (parser.rs).
  if (codexNameTooLong(raw) && reaches('codex')) {
    consequences.push('Codex skips the skill');
    impacts.push({ platform: 'codex', severity: 'error' });
  }
  if (badCharacters && reaches('copilot')) {
    consequences.push('GitHub Copilot in VS Code does not load the skill');
    impacts.push({ platform: 'copilot', severity: 'error' });
  } else if (tooLong && reaches('copilot')) {
    consequences.push(`GitHub Copilot in VS Code allows at most ${MAX_NAME_LENGTH} characters`);
    impacts.push({ platform: 'copilot', severity: 'warn' });
  }
  if (badCharacters && reaches('cursor')) {
    consequences.push('Cursor requires lowercase letters, digits and hyphens');
    impacts.push({ platform: 'cursor', severity: 'warn' });
  }
  if ((CLAUDE_REFUSED.test(raw) || CLAUDE_REFUSED_SPACING.test(raw)) && reaches('claude-code')) {
    consequences.push('Claude Code refuses the name');
    impacts.push({ platform: 'claude-code', severity: 'warn' });
  }
  if (distributable) {
    if (tooLong || badCharacters) {
      consequences.push('the skills-ref validator and claude.ai upload reject the skill');
      impacts.push(SPEC_INVALID);
    } else if (starts || ends || doubled) {
      // The Claude API documents only the length and the character set, not hyphen positions.
      consequences.push(
        'the skills-ref validator and the anthropics/skills packager reject the skill',
      );
      impacts.push(SPEC_INVALID);
    } else if (nonAscii.size > 0) {
      consequences.push(
        'the anthropics/skills packager accepts only a-z, 0-9 and hyphens, so it rejects the skill',
      );
      impacts.push(PACKAGER_ONLY);
    }
  }
  if (consequences.length === 0) return undefined;
  return { problems, consequences, impacts };
}

export const nameFormatRule = defineRule({
  meta: {
    id: 'skill/name-format',
    title: 'Skill name does not follow the Agent Skills naming rules',
    rationale: `The Agent Skills specification allows 1 to 64 lowercase letters, digits and hyphens in \`name\`, with no hyphen at the start or end and no \`--\`. GitHub Copilot in VS Code does not load a skill whose name has other characters, Cursor requires the same characters, and Codex skips a skill whose name is longer than 64 characters. Claude Code refuses a name with hidden, direction-changing or blank-like characters, \`<\` or \`>\`, so typing the name does not invoke the skill.

For a skill that is installed or uploaded on its own, the skills-ref validator and the anthropics/skills packager reject a name that breaks these rules, and claude.ai upload rejects one with other characters or more than 64. skills-ref accepts non-ASCII lowercase letters, but the packager accepts only \`a-z\`, \`0-9\` and \`-\`.

Rename the skill to lowercase ASCII words joined by single hyphens, and rename its directory to match.`,
    category: 'correctness',
    severity: 'error',
    appliesTo: ['skill'],
    platforms: ['claude-code', 'codex', 'cursor', 'copilot'],
    sources: [
      SOURCES.agentSkillsSpec,
      SKILL_SOURCES.vscodeSkills,
      SKILL_SOURCES.codexSkillParser,
      SOURCES.skillsRefValidator,
      SKILL_SOURCES.anthropicsSkillValidator,
      SOURCES.claudeApiSkills,
      SOURCES.cursorSkills,
      SOURCES.claudeSkills,
    ],
    since: RULESET_VERSION,
    fix: {
      classes: ['safe', 'review'],
      summary:
        'Sets `name` to the directory name: safe when that is the name in lowercase with hyphens, review otherwise. A non-ASCII name or an invalid directory name is left to you.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const frontmatter = validFrontmatter(context, artifact);
      if (frontmatter === undefined) continue;
      const { data } = frontmatter;
      const value = data.values['name'];
      const span = data.valueSpan('name');
      let message: string;
      let impacts: readonly Impact[];
      let repair: FixOrGuidance;
      const { reach, distributable } = placement(context, artifact);
      if (nameNotText(value)) {
        const codex = reach.has('codex');
        const clauses = [
          ...(codex ? ['Codex cannot read the frontmatter and skips the skill'] : []),
          ...(distributable ? ['the skills-ref validator rejects it'] : []),
        ];
        if (clauses.length === 0) continue;
        message = `\`name\` is ${describeType(value)}, not text. ${sentence(joinClauses(clauses))}`;
        impacts = [
          ...(codex ? [{ platform: 'codex', severity: 'error' } as const] : []),
          SPEC_INVALID,
        ];
        repair = { guidance: 'write "name" as one line of text, such as the directory name' };
      } else if (typeof value === 'string') {
        const analysis = analyze(value, (platform) => reach.has(platform), distributable);
        if (analysis === undefined) continue;
        message = `Skill name ${quote(value.trim())} ${joinNames(analysis.problems)}. ${sentence(joinClauses(analysis.consequences))}`;
        impacts = analysis.impacts;
        repair = nameFix(context, artifact, frontmatter, 'skill/name-format', value);
      } else {
        // Missing or empty: skill/name-missing. Numbers and booleans read as text everywhere.
        continue;
      }
      const resolved = resolveImpacts(context, artifact, impacts);
      if (resolved === undefined) continue;
      context.report({
        artifact,
        message,
        severity: resolved.severity,
        platforms: resolved.platforms,
        ...(span === undefined ? {} : { span }),
        ...fixFields(repair),
      });
    }
  },
});
