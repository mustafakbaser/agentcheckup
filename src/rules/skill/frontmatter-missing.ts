import { RULESET_VERSION } from '../../core/meta.js';
import { lineText } from '../../core/text.js';
import type { Artifact, DecodedText, PlatformId, Span } from '../../core/types.js';
import { codexFrontmatterClose, isCodexDelimiter } from '../../platforms/codex-skills.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger, joinClauses, platformsDo, sentence } from '../shared/format.js';
import {
  type Impact,
  impactsOn,
  loadableSkills,
  reached,
  resolveImpacts,
  type SkillScope,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

/** Span of line `line` (1-based), without its line terminator. */
function lineSpan(decoded: DecodedText, line: number): Span {
  const offset = decoded.lineStarts[line - 1] ?? 0;
  return { offset, length: lineText(decoded, line).length };
}

/** First line after `after` (1-based) for which `test` holds, or undefined. */
function findLine(
  decoded: DecodedText,
  after: number,
  test: (text: string) => boolean,
): number | undefined {
  for (let line = after + 1; line <= decoded.lineStarts.length; line++) {
    if (test(lineText(decoded, line))) return line;
  }
  return undefined;
}

const SKIP = ['skips', 'skip'] as const;
const CLAUDE_READS_AS_INSTRUCTIONS = 'Claude Code reads the frontmatter as instructions';

interface Problem {
  readonly message: string;
  readonly impacts: readonly Impact[];
  readonly span?: Span;
}

/**
 * Builds the problem from what each platform does, keeping only platforms that load the skill
 * from its location. Undefined when none of them does.
 */
function problem(
  scope: SkillScope,
  artifact: Artifact,
  lead: string,
  skippers: readonly PlatformId[],
  claude: { readonly clause: string; readonly severity: Impact['severity'] } | undefined,
  span?: Span,
): Problem | undefined {
  const skipping = reached(scope, artifact, skippers);
  const claudeReached =
    claude !== undefined && reached(scope, artifact, ['claude-code']).length > 0;
  const clauses = [
    platformsDo(skipping, SKIP, 'the skill'),
    claudeReached ? claude.clause : undefined,
  ].filter((clause) => clause !== undefined);
  if (clauses.length === 0) return undefined;
  return {
    message: `${lead} ${sentence(joinClauses(clauses))}`,
    impacts: [
      ...impactsOn(skipping, 'error'),
      ...(claudeReached ? [{ platform: 'claude-code', severity: claude.severity } as const] : []),
    ],
    ...(span === undefined ? {} : { span }),
  };
}

function absentProblem(scope: SkillScope, artifact: Artifact): Problem | undefined {
  const { decoded } = artifact;
  if (decoded.text.trim() === '') {
    return problem(
      scope,
      artifact,
      'SKILL.md is empty, so it has no frontmatter.',
      ['codex', 'gemini'],
      undefined,
    );
  }

  const first = lineText(decoded, 1);
  if (isCodexDelimiter(first)) {
    // `  ---`: Codex trims the line; Claude Code and Gemini CLI need `---` to start the file.
    const closed = codexFrontmatterClose(decoded) !== undefined;
    return problem(
      scope,
      artifact,
      `The \`---\` on line 1 is indented${closed ? '' : ' and never closed'}.`,
      closed ? ['gemini'] : ['codex', 'gemini'],
      { clause: CLAUDE_READS_AS_INSTRUCTIONS, severity: 'error' },
      lineSpan(decoded, 1),
    );
  }

  const firstContent = findLine(decoded, 0, (text) => text.trim() !== '');
  if (
    firstContent !== undefined &&
    firstContent > 1 &&
    isCodexDelimiter(lineText(decoded, firstContent))
  ) {
    return problem(
      scope,
      artifact,
      `The frontmatter starts on line ${formatInteger(firstContent)}, but agents look for it only on line 1.`,
      ['codex', 'gemini'],
      { clause: CLAUDE_READS_AS_INSTRUCTIONS, severity: 'error' },
      lineSpan(decoded, firstContent),
    );
  }

  return problem(
    scope,
    artifact,
    'SKILL.md does not start with `---`, so it has no frontmatter.',
    ['codex', 'gemini'],
    {
      clause:
        'Claude Code uses the directory name as its name and the first non-empty line of the body as its description',
      severity: 'warn',
    },
    lineSpan(decoded, 1),
  );
}

function unclosedProblem(
  scope: SkillScope,
  artifact: Artifact,
  openSpan: Span,
): Problem | undefined {
  const { decoded } = artifact;
  // Gemini CLI closes the block at any line that starts with `---` (skillLoader.ts).
  const geminiCloses = findLine(decoded, 1, (text) => text.startsWith('---')) !== undefined;
  // The block opens with `---` on line 1, so this is the line where Codex finds it closed.
  const indentedClose = codexFrontmatterClose(decoded);
  if (indentedClose !== undefined) {
    // Codex trims lines, so it finds the indented `---`. Claude Code's handling of a closing
    // line is undocumented, so only Gemini CLI, which needs `---` at the line start, is claimed.
    if (geminiCloses) return undefined;
    return problem(
      scope,
      artifact,
      `The closing \`---\` on line ${formatInteger(indentedClose)} is indented.`,
      ['gemini'],
      undefined,
      lineSpan(decoded, indentedClose),
    );
  }
  return problem(
    scope,
    artifact,
    'The frontmatter opened on line 1 has no closing `---` line.',
    geminiCloses ? ['codex'] : ['codex', 'gemini'],
    undefined,
    openSpan,
  );
}

export const frontmatterMissingRule = defineRule({
  meta: {
    id: 'skill/frontmatter-missing',
    title: 'Skill has no YAML frontmatter on line 1',
    rationale: `Agents read a skill's \`name\` and \`description\` from YAML frontmatter: a \`---\` line at the very start of SKILL.md, the fields, and a closing \`---\` line. Codex and Gemini CLI skip a SKILL.md without it, and Codex also skips one whose frontmatter is never closed. Claude Code still loads the skill, but takes its name from the directory and its description from the first non-empty line of the body, so automatic invocation depends on how the body starts. When the frontmatter is indented or starts after a blank line, Claude Code reads it as instructions. The Agent Skills specification requires the frontmatter.

Start the file with \`---\`, add \`name\` and \`description\`, and close the block with another \`---\` line.`,
    category: 'loading',
    severity: 'error',
    appliesTo: ['skill'],
    platforms: ['claude-code', 'codex', 'gemini'],
    sources: [
      SOURCES.claudeSkills,
      SKILL_SOURCES.codexSkillParser,
      SKILL_SOURCES.geminiSkillLoader,
      SOURCES.agentSkillsSpec,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const result = context.frontmatter(artifact);
      let found: Problem | undefined;
      if (result.kind === 'absent') found = absentProblem(context, artifact);
      else if (result.kind === 'unclosed')
        found = unclosedProblem(context, artifact, result.openSpan);
      if (found === undefined) continue;
      const resolved = resolveImpacts(context, artifact, found.impacts);
      if (resolved === undefined) continue;
      context.report({
        artifact,
        message: found.message,
        severity: resolved.severity,
        platforms: resolved.platforms,
        ...(found.span === undefined ? {} : { span: found.span }),
      });
    }
  },
});
