import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, Fix, Span } from '../../core/types.js';
import { quoteYaml } from '../../fix/index.js';
import { parseFrontmatter } from '../../parse/frontmatter.js';
import type { FrontmatterData, ParseIssue } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { quote } from '../shared/format.js';
import {
  impactsOn,
  loadableSkills,
  resolveImpacts,
  SKILL_PLATFORMS,
  validFrontmatter,
  type ValidFrontmatter,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';
import { checkedYamlEdit, editable, type FixOrGuidance, fixFields, ownerKey } from './fixes.js';

const sameSpan = (a: Span | undefined, b: Span): boolean =>
  a?.offset === b.offset && a.length === b.length;

/** The top-level key whose key or value span is `span`, if any. */
function topLevelKey(data: FrontmatterData, span: Span): string | undefined {
  return data.keys.find(
    (key) => sameSpan(data.keySpan(key), span) || sameSpan(data.valueSpan(key), span),
  );
}

/** How the hardened YAML 1.2 parser reads one plain scalar. */
function yaml12Value(scalar: string): unknown {
  const result = parseFrontmatter(`---\nv: ${scalar}\n---\n`);
  return result.kind === 'valid' ? result.data.values['v'] : undefined;
}

/** Keys whose empty value another rule already reports (name-missing, description-missing). */
const REPORTED_ELSEWHERE: ReadonlySet<string> = new Set(['name', 'description']);

function message(warning: ParseIssue, source: string, key: string | undefined): string | undefined {
  switch (warning.code) {
    case 'yaml11-boolean': {
      const yaml11 = ['y', 'yes', 'on'].includes(source.toLowerCase());
      return `${quote(source)} is text to YAML 1.2 parsers but the boolean ${String(yaml11)} to YAML 1.1 parsers such as PyYAML, which the anthropics/skills packager uses. Quote it, or write \`true\` or \`false\`.`;
    }
    case 'number-coercion': {
      const value = yaml12Value(source);
      const reading = typeof value === 'number' ? `the number ${String(value)}` : 'a number';
      return `${quote(source)} is ${reading} to YAML 1.2 parsers such as js-yaml, which Gemini CLI uses, but text to strictyaml, which the skills-ref validator uses. Quote it to keep the text.`;
    }
    case 'alias':
      return source.startsWith('*')
        ? `${quote(source)} is a YAML alias, and strictyaml, which the skills-ref validator uses, rejects aliases. Write the value out.`
        : 'This value defines a YAML anchor, and strictyaml, which the skills-ref validator uses, rejects anchors. Remove the anchor and write out the values that refer to it.';
    case 'tag':
      return 'This value has an explicit YAML tag, and strictyaml, which the skills-ref validator uses, rejects tags. Remove the tag.';
    case 'null-value': {
      // An empty value is reported at its key, an explicit `~` or `null` at the value.
      const literal = source === '~' || source.toLowerCase() === 'null';
      const name = key ?? (literal ? undefined : source);
      return `${name === undefined ? 'This value' : quote(name)} is empty (null), but strictyaml, which the skills-ref validator uses, reads it as text. Remove the key or give it a value.`;
    }
    default:
      return undefined;
  }
}

const QUOTE_GUIDANCE = 'put the value in double quotes';

/**
 * Writes a plain scalar that parsers read differently in double quotes (`review`), so every
 * parser reads the text YAML 1.2 parsers read today: `yes` stays the text "yes", `1.0` becomes
 * the text "1.0". For a YAML 1.1 boolean that is a top-level value, `-i` also offers `true` or
 * `false`.
 */
function quoteScalar(
  artifact: Artifact,
  frontmatter: ValidFrontmatter,
  warning: ParseIssue,
  source: string,
): FixOrGuidance {
  const guidance =
    warning.code === 'yaml11-boolean'
      ? 'put the value in double quotes, or write true or false'
      : QUOTE_GUIDANCE;
  const first = source.charAt(0);
  const owner = ownerKey(frontmatter.data, warning.span);
  if (
    !editable(artifact) ||
    owner === undefined ||
    source.trim() !== source ||
    source === '' ||
    first === '"' ||
    first === "'" ||
    source.includes('\n') ||
    source.includes('\r')
  ) {
    return { guidance };
  }
  const quoted = checkedYamlEdit(
    artifact,
    frontmatter,
    owner,
    warning.span,
    quoteYaml(source, 'double'),
    () => true,
  );
  if (quoted === undefined) return { guidance };
  const topValue = sameSpan(frontmatter.data.valueSpan(owner), warning.span);
  const yaml11 = ['y', 'yes', 'on'].includes(source.toLowerCase());
  const boolean =
    warning.code === 'yaml11-boolean' && topValue
      ? checkedYamlEdit(
          artifact,
          frontmatter,
          owner,
          warning.span,
          String(yaml11),
          (value) => value === yaml11,
        )
      : undefined;
  const fix: Fix = {
    id: 'skill/yaml-portability#quote',
    class: 'review',
    title: `Put ${quote(source)} in double quotes in ${artifact.path}`,
    changes: [quoted],
    ...(boolean === undefined
      ? {}
      : {
          alternatives: [
            {
              id: 'skill/yaml-portability#boolean',
              class: 'review',
              title: `Write ${quote(source)} as ${String(yaml11)} in ${artifact.path}`,
              changes: [boolean],
            },
          ],
        }),
  };
  return { fix, guidance };
}

/** The fix or manual step for one warning. */
function repairFor(
  artifact: Artifact,
  frontmatter: ValidFrontmatter,
  warning: ParseIssue,
  source: string,
): FixOrGuidance | undefined {
  switch (warning.code) {
    case 'yaml11-boolean':
    case 'number-coercion':
      return quoteScalar(artifact, frontmatter, warning, source);
    case 'alias':
      return {
        guidance: source.startsWith('*')
          ? 'replace the alias with the value it refers to'
          : 'remove the anchor and write out the values that refer to it',
      };
    case 'tag':
      return { guidance: 'remove the tag' };
    case 'null-value':
      return { guidance: 'remove the key or give it a value' };
    default:
      return undefined;
  }
}

export const yamlPortabilityRule = defineRule({
  meta: {
    id: 'skill/yaml-portability',
    title: 'Skill frontmatter uses YAML that parsers read differently',
    rationale: `Agents and validators parse SKILL.md frontmatter with different YAML libraries: Codex uses serde_yaml, Gemini CLI js-yaml, the skills-ref validator strictyaml, and the anthropics/skills packager PyYAML, a YAML 1.1 parser. YAML 1.1 reads unquoted \`yes\`, \`no\`, \`on\` and \`off\` as booleans; YAML 1.2 reads them as text. YAML 1.2 parsers read \`1.0\` as the number 1, while strictyaml keeps the text. strictyaml rejects anchors, aliases and explicit tags, and reads an empty value as text where other parsers read null. These findings are reported only for skills that are installed or uploaded on their own.

Quote values that must stay text, write booleans as \`true\` or \`false\`, avoid anchors, aliases and tags, and remove keys that have no value.`,
    category: 'portability',
    severity: 'warn',
    appliesTo: ['skill'],
    platforms: SKILL_PLATFORMS,
    sources: [
      SKILL_SOURCES.strictYaml,
      SKILL_SOURCES.yaml11Bool,
      SKILL_SOURCES.anthropicsSkillValidator,
      SOURCES.skillsRefValidator,
      SKILL_SOURCES.geminiSkillLoader,
      SKILL_SOURCES.codexSkillParser,
    ],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      summary:
        'Puts a value that YAML 1.1 reads as a boolean, or YAML 1.2 as a number, in double quotes. Anchors, aliases, tags and empty values are left to you.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    const impacts = impactsOn(SKILL_PLATFORMS, 'warn', 'distribution');
    for (const artifact of loadableSkills(context)) {
      const frontmatter = validFrontmatter(context, artifact);
      if (frontmatter === undefined) continue;
      const resolved = resolveImpacts(context, artifact, impacts);
      if (resolved === undefined) continue;
      const { text } = artifact.decoded;
      for (const warning of frontmatter.warnings) {
        const key = topLevelKey(frontmatter.data, warning.span);
        if (warning.code === 'null-value' && key !== undefined && REPORTED_ELSEWHERE.has(key)) {
          continue;
        }
        const source = text.slice(warning.span.offset, warning.span.offset + warning.span.length);
        const messageText = message(warning, source, key);
        if (messageText === undefined) continue;
        context.report({
          artifact,
          message: messageText,
          severity: resolved.severity,
          platforms: resolved.platforms,
          span: warning.span,
          ...fixFields(repairFor(artifact, frontmatter, warning, source) ?? {}),
        });
      }
    }
  },
});
