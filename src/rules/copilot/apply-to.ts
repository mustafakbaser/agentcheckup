import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, ReportDescriptor, Span } from '../../core/types.js';
import type { FrontmatterData, FrontmatterResult } from '../../parse/types.js';
import { yamlReplaceValue } from '../../fix/edits.js';
import { isLinked, joinPatterns, linkedGuidance } from '../cursor/fixes.js';
import { defineRule } from '../define.js';
import { quote } from '../shared/format.js';
import { describeValue, issueDetail, yamlSyntaxError } from '../instructions/yaml.js';
import { SOURCES } from '../sources.js';
import { meantForCopilot, placement } from './location.js';
import { COPILOT_SOURCES } from './sources.js';

const ID = 'copilot/apply-to';
const EXCLUDE_AGENT_VALUES: ReadonlySet<string> = new Set(['code-review', 'cloud-agent']);
const OPENING_DELIMITER: Span = { offset: 0, length: 3 };
/** GitHub's documentation separates patterns with a bare comma: `"**\/*.ts,**\/*.tsx"`. */
const PATTERN_SEPARATOR = ',';
const APPLY_TO_EXAMPLE = 'applyTo: "**/*.ts"';
const ADD_APPLY_TO = `add "applyTo" with the files these instructions are for, such as ${APPLY_TO_EXAMPLE}`;

type Finding = Omit<ReportDescriptor, 'artifact'>;
type ValidFrontmatter = Extract<FrontmatterResult, { kind: 'valid' }>;
type Parse = Parameters<typeof meantForCopilot>[0];

/** Joins an `applyTo` YAML list into one comma-separated string. */
function listFix(
  artifact: Artifact,
  frontmatter: ValidFrontmatter,
): Pick<ReportDescriptor, 'fix' | 'guidance'> {
  if (isLinked(artifact)) return { guidance: linkedGuidance(artifact, 'join the patterns') };
  const joined = joinPatterns(frontmatter.data.values['applyTo'], PATTERN_SEPARATOR);
  const change =
    joined === undefined
      ? undefined
      : yamlReplaceValue(artifact, frontmatter, 'applyTo', joined, { style: 'double' });
  if (change === undefined) {
    return {
      guidance:
        'write the patterns as one comma-separated string by hand, such as applyTo: "**/*.ts,**/*.tsx"; expand a pattern with a comma, such as "src/{a,b}/**", into one pattern per alternative',
    };
  }
  return {
    fix: {
      id: `${ID}#string`,
      class: 'safe',
      title: `Write "applyTo" as one comma-separated string in ${artifact.path}`,
      changes: [change],
    },
  };
}

const NOT_APPLIED =
  'Copilot cloud agent and code review never apply this file, and VS Code uses it only when you attach it to a chat.';

function applyToFindings(artifact: Artifact, frontmatter: ValidFrontmatter): Finding[] {
  const { data } = frontmatter;
  const { values } = data;
  if (!Object.hasOwn(values, 'applyTo')) {
    const description = values['description'];
    const described = typeof description === 'string' && description.trim() !== '';
    // VS Code documents description-only files as loaded on demand, so that is a choice, not an
    // accident; only the GitHub.com side is worth a note.
    return [
      described
        ? {
            span: OPENING_DELIMITER,
            severity: 'info',
            message:
              'The frontmatter has a "description" but no "applyTo", so VS Code loads this file only when the description matches the task, and Copilot cloud agent and code review never apply it.',
            guidance: `if Copilot cloud agent and code review should use it too, ${ADD_APPLY_TO}`,
          }
        : {
            span: OPENING_DELIMITER,
            message: `The frontmatter has no "applyTo". ${NOT_APPLIED}`,
            guidance: ADD_APPLY_TO,
          },
    ];
  }
  const value = values['applyTo'];
  const span = data.valueSpan('applyTo') ?? data.keySpan('applyTo') ?? OPENING_DELIMITER;
  if (value === null) {
    return [
      {
        span,
        message: '"applyTo" has no value, so it matches no files.',
        guidance: `set "applyTo" to the files these instructions are for, such as ${APPLY_TO_EXAMPLE}`,
      },
    ];
  }
  if (typeof value === 'string') {
    return value.trim() === ''
      ? [
          {
            span,
            message: '"applyTo" is empty, so it matches no files.',
            guidance: `set "applyTo" to the files these instructions are for, such as ${APPLY_TO_EXAMPLE}`,
          },
        ]
      : [];
  }
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) {
    return [
      {
        span,
        severity: 'info',
        message:
          '"applyTo" is a YAML list. GitHub documents "applyTo" only as one string of comma-separated patterns, such as "**/*.ts,**/*.tsx".',
        ...listFix(artifact, frontmatter),
      },
    ];
  }
  return [
    {
      span,
      message: `"applyTo" is ${describeValue(value)}, not a string of comma-separated glob patterns.`,
      guidance: `write "applyTo" as one quoted string of comma-separated patterns, such as ${APPLY_TO_EXAMPLE}`,
    },
  ];
}

function excludeAgentFindings(data: FrontmatterData): Finding[] {
  if (!Object.hasOwn(data.values, 'excludeAgent')) return [];
  const value = data.values['excludeAgent'];
  if (typeof value === 'string' && EXCLUDE_AGENT_VALUES.has(value)) return [];
  const span = data.valueSpan('excludeAgent') ?? data.keySpan('excludeAgent') ?? OPENING_DELIMITER;
  if (value === 'coding-agent') {
    return [
      {
        span,
        severity: 'info',
        message:
          '"coding-agent" is the "excludeAgent" value from GitHub\'s November 2025 announcement. The current documentation lists only "code-review" and "cloud-agent".',
      },
    ];
  }
  return [
    {
      span,
      message: `"excludeAgent" is ${typeof value === 'string' ? quote(value) : describeValue(value)}, not one of the documented values "code-review" and "cloud-agent".`,
      guidance: 'set "excludeAgent" to "code-review" or "cloud-agent", or remove it',
    },
  ];
}

function findingsFor(context: Parse, artifact: Artifact): Finding[] {
  const frontmatter = context.frontmatter(artifact);
  switch (frontmatter.kind) {
    case 'absent':
      return [
        {
          message: `This file has no frontmatter, so it has no "applyTo". ${NOT_APPLIED}`,
          guidance: `start the file with a frontmatter block between "---" lines that sets "applyTo", such as ${APPLY_TO_EXAMPLE}`,
        },
      ];
    case 'unclosed':
      return [
        {
          span: frontmatter.openSpan,
          message: `The frontmatter has no closing "---" line, so GitHub Copilot cannot read "applyTo" from it. ${NOT_APPLIED}`,
          guidance: 'add a "---" line where the frontmatter ends',
        },
      ];
    case 'unsupported':
      return [
        {
          span: frontmatter.span,
          message:
            'The frontmatter is not YAML between "---" lines, so GitHub Copilot cannot read "applyTo" from it.',
          guidance: `write the frontmatter as YAML between "---" lines, such as ${APPLY_TO_EXAMPLE}`,
        },
      ];
    case 'invalid': {
      const error = yamlSyntaxError(frontmatter.errors, { tolerateCommonMistakes: true });
      if (error === undefined) return [];
      return [
        {
          span: error.span,
          message: `The frontmatter is not valid YAML (${issueDetail(error)}), so GitHub Copilot cannot read "applyTo" from it.`,
          guidance: `correct the YAML; quote patterns that start with "*", such as ${APPLY_TO_EXAMPLE}`,
        },
      ];
    }
    case 'valid':
      return [...applyToFindings(artifact, frontmatter), ...excludeAgentFindings(frontmatter.data)];
  }
}

export const applyToRule = defineRule({
  meta: {
    id: ID,
    title: 'Path-specific GitHub Copilot instructions have no valid applyTo',
    rationale: [
      'A `*.instructions.md` file applies to the files that its `applyTo` frontmatter matches (comma-separated glob patterns). On GitHub.com, only Copilot cloud agent and Copilot code review use these files, and only through `applyTo`. VS Code also loads a file on demand when its `description` matches the task; with neither field, you attach the file to a chat by hand.',
      'A file with a `description` but no `applyTo` is a documented VS Code choice, so it is information only. So are an `applyTo` YAML list, which is not documented, and `excludeAgent: "coding-agent"`, a value from GitHub\'s November 2025 announcement that the current documentation no longer lists. The documented `excludeAgent` values are `"code-review"` and `"cloud-agent"`.',
      'Add `applyTo` with the patterns the instructions are for, such as `applyTo: "**/*.ts"`.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'warn',
    appliesTo: ['copilot-path-instructions'],
    platforms: ['copilot'],
    sources: [
      SOURCES.copilotRepoInstructions,
      COPILOT_SOURCES.vscodeInstructions,
      COPILOT_SOURCES.excludeAgentChangelog,
    ],
    since: RULESET_VERSION,
    fix: {
      classes: ['safe'],
      summary: 'Joins an "applyTo" YAML list into one comma-separated string.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const where = placement(context.snapshot, artifact.path, 'instructions');
      if (where.kind === 'elsewhere' && !meantForCopilot(context, artifact)) continue;
      for (const finding of findingsFor(context, artifact))
        context.report({ artifact, ...finding });
    }
  },
});
