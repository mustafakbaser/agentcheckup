import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, ReportDescriptor, Span } from '../../core/types.js';
import type { FrontmatterData } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { quote } from '../shared/format.js';
import { describeValue, issueDetail, yamlSyntaxError } from '../instructions/yaml.js';
import { SOURCES } from '../sources.js';
import { meantForCopilot, placement } from './location.js';
import { COPILOT_SOURCES } from './sources.js';

const EXCLUDE_AGENT_VALUES: ReadonlySet<string> = new Set(['code-review', 'cloud-agent']);
const OPENING_DELIMITER: Span = { offset: 0, length: 3 };

type Finding = Omit<ReportDescriptor, 'artifact'>;

const NOT_APPLIED =
  'Copilot cloud agent and code review never apply this file, and VS Code uses it only when you attach it to a chat.';

function applyToFindings(data: FrontmatterData): Finding[] {
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
          }
        : { span: OPENING_DELIMITER, message: `The frontmatter has no "applyTo". ${NOT_APPLIED}` },
    ];
  }
  const value = values['applyTo'];
  const span = data.valueSpan('applyTo') ?? data.keySpan('applyTo') ?? OPENING_DELIMITER;
  if (value === null) {
    return [
      {
        span,
        message: '"applyTo" has no value, so it matches no files.',
      },
    ];
  }
  if (typeof value === 'string') {
    return value.trim() === ''
      ? [{ span, message: '"applyTo" is empty, so it matches no files.' }]
      : [];
  }
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) {
    return [
      {
        span,
        severity: 'info',
        message:
          '"applyTo" is a YAML list. GitHub documents "applyTo" only as one string of comma-separated patterns, such as "**/*.ts,**/*.tsx".',
      },
    ];
  }
  return [
    {
      span,
      message: `"applyTo" is ${describeValue(value)}, not a string of comma-separated glob patterns.`,
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
    },
  ];
}

function findingsFor(
  context: Parameters<typeof meantForCopilot>[0],
  artifact: Artifact,
): Finding[] {
  const frontmatter = context.frontmatter(artifact);
  switch (frontmatter.kind) {
    case 'absent':
      return [{ message: `This file has no frontmatter, so it has no "applyTo". ${NOT_APPLIED}` }];
    case 'unclosed':
      return [
        {
          span: frontmatter.openSpan,
          message: `The frontmatter has no closing "---" line, so GitHub Copilot cannot read "applyTo" from it. ${NOT_APPLIED}`,
        },
      ];
    case 'unsupported':
      return [
        {
          span: frontmatter.span,
          message:
            'The frontmatter is not YAML between "---" lines, so GitHub Copilot cannot read "applyTo" from it.',
        },
      ];
    case 'invalid': {
      const error = yamlSyntaxError(frontmatter.errors, { tolerateCommonMistakes: true });
      if (error === undefined) return [];
      return [
        {
          span: error.span,
          message: `The frontmatter is not valid YAML (${issueDetail(error)}), so GitHub Copilot cannot read "applyTo" from it.`,
        },
      ];
    }
    case 'valid':
      return [...applyToFindings(frontmatter.data), ...excludeAgentFindings(frontmatter.data)];
  }
}

export const applyToRule = defineRule({
  meta: {
    id: 'copilot/apply-to',
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
