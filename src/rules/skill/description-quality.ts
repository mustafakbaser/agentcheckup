import { RULESET_VERSION } from '../../core/meta.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { plural } from '../shared/format.js';
import {
  impactsOn,
  loadableSkills,
  resolveImpacts,
  SKILL_PLATFORMS,
  validFrontmatter,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

const MIN_WORDS = 8;
/** Share of letters that must be ASCII before English heuristics apply. */
const MIN_ASCII_SHARE = 0.9;

const LETTER = /\p{L}/u;
const ASCII_LETTER = /[a-z]/i;
const WORD = /[a-z']+/gi;

/** Function words that are common in English and rare as words in other languages. */
const ENGLISH_MARKERS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'with',
  'when',
  'whenever',
  'this',
  'that',
  'your',
  'you',
  'from',
  'into',
  'which',
  'what',
  'use',
  'uses',
  'using',
  'should',
]);

/** Phrases that tell an agent when to use the skill. */
const TRIGGER_WORD =
  /\b(?:when|whenever|if|while|before|after|during|unless|trigger(?:s|ed)?|invoke[ds]?)\b/i;
const FOR_GERUND = /\bfor [a-z]+ing\b/i;
const USE_FOR = /\b(?:use|used|useful) (?:for|to|on|with|in)\b/i;
const APPLIES = /\b(?:applies|applicable|relevant) (?:to|for|when)\b/i;
const REQUESTS = /\brequests? (?:to|for|about|that|involving)\b/i;

/** True when the text is mostly ASCII letters and contains English function words. */
function isEnglishProse(text: string): boolean {
  let letters = 0;
  let ascii = 0;
  for (const char of text) {
    if (!LETTER.test(char)) continue;
    letters++;
    if (ASCII_LETTER.test(char)) ascii++;
  }
  if (letters === 0 || ascii / letters < MIN_ASCII_SHARE) return false;
  for (const match of text.matchAll(WORD)) {
    if (ENGLISH_MARKERS.has(match[0].toLowerCase())) return true;
  }
  return false;
}

function hasTrigger(text: string): boolean {
  return [TRIGGER_WORD, FOR_GERUND, USE_FOR, APPLIES, REQUESTS].some((pattern) =>
    pattern.test(text),
  );
}

export const descriptionQualityRule = defineRule({
  meta: {
    id: 'skill/description-quality',
    title: 'Skill description is too short or does not say when to use it',
    rationale: `Agents decide whether to load a skill by matching the request against its \`name\` and \`description\`. The Claude skill authoring guide and the Agent Skills specification ask for a description that says what the skill does and when to use it, with the keywords a request would contain. A description of a few words, or one without a "Use when ..." clause, gives the agent little to match.

This check reads English only and skips descriptions in other languages. Findings are advice and do not affect the score.

Say what the skill does, then add a "Use when ..." clause with the situations and keywords that should trigger it.`,
    category: 'clarity',
    severity: 'info',
    appliesTo: ['skill'],
    platforms: SKILL_PLATFORMS,
    sources: [
      SKILL_SOURCES.claudeSkillBestPractices,
      SOURCES.agentSkillsSpec,
      SOURCES.codexSkills,
      SOURCES.claudeSkills,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const frontmatter = validFrontmatter(context, artifact);
      if (frontmatter === undefined) continue;
      const value = frontmatter.data.values['description'];
      if (typeof value !== 'string') continue;
      const text = value.trim();
      if (text === '' || !isEnglishProse(text)) continue;

      const words = text.split(/\s+/u).length;
      let message: string | undefined;
      if (words < MIN_WORDS) {
        message = `The description has only ${plural(words, 'word')}, too few for agents to match requests against. Say what the skill does and when to use it.`;
      } else if (!hasTrigger(text)) {
        message =
          'The description does not say when to use the skill. Add a "Use when ..." clause with the situations and keywords that should trigger it.';
      }
      if (message === undefined) continue;
      const resolved = resolveImpacts(context, artifact, impactsOn(SKILL_PLATFORMS, 'info'));
      if (resolved === undefined) continue;
      const span = frontmatter.data.valueSpan('description');
      context.report({
        artifact,
        message,
        severity: resolved.severity,
        platforms: resolved.platforms,
        ...(span === undefined ? {} : { span }),
        guidance:
          'rewrite "description" to say what the skill does, then add "Use when ..." with the words a request for it would contain',
      });
    }
  },
});
