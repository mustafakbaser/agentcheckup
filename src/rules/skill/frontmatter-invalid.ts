import { RULESET_VERSION } from '../../core/meta.js';
import { lineText } from '../../core/text.js';
import type { Artifact, Span } from '../../core/types.js';
import type { FrontmatterResult, ParseIssue } from '../../parse/types.js';
import {
  codexRejectsDuplicate,
  codexRepairedYaml,
  frontmatterYaml,
  invalidCause,
} from '../../platforms/codex-skills.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { joinClauses, platformsDo, quote, sentence } from '../shared/format.js';
import { claudeCodeRepair, parsesAsFrontmatter } from './repair.js';
import {
  type Impact,
  impactsOn,
  isDistributable,
  loadableSkills,
  reached,
  resolveImpacts,
  SKILL_PLATFORMS,
  type SkillScope,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

type Invalid = Extract<FrontmatterResult, { kind: 'invalid' }>;
type Unsupported = Extract<FrontmatterResult, { kind: 'unsupported' }>;

interface Problem {
  readonly message: string;
  readonly impacts: readonly Impact[];
  readonly span: Span;
}

/** skills-ref and the anthropics/skills packager reject frontmatter that does not parse. */
const VALIDATORS: Impact = { platform: 'claude-code', severity: 'warn', scope: 'distribution' };

const MAX_REASON_LENGTH = 100;

/** The parser's message, shortened, without a trailing period. */
function reason(issue: ParseIssue): string {
  const text = issue.message.endsWith('.') ? issue.message.slice(0, -1) : issue.message;
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH)}…` : text;
}

const SKIP = ['skips', 'skip'] as const;
const VALIDATORS_REJECT = 'the skills-ref validator and the anthropics/skills packager reject it';

/** `lead`, followed by the clauses as one sentence when there are any. */
function withClauses(lead: string, clauses: readonly (string | undefined)[]): string {
  const present = clauses.filter((clause) => clause !== undefined);
  return present.length === 0 ? lead : `${lead} ${sentence(joinClauses(present))}`;
}

function unsupportedProblem(scope: SkillScope, artifact: Artifact, result: Unsupported): Problem {
  const opening = lineText(artifact.decoded, 1).trim();
  const label = result.syntax === 'toml' ? `${quote(opening)} (TOML)` : quote(opening);
  const skipping = reached(scope, artifact, ['codex', 'gemini']);
  const claude = reached(scope, artifact, ['claude-code']).length > 0;
  return {
    message: withClauses(
      `The frontmatter opens with ${label}, but agents read only YAML between \`---\` lines.`,
      [
        platformsDo(skipping, SKIP, 'the skill'),
        claude ? 'Claude Code reads the frontmatter as instructions' : undefined,
        isDistributable(scope, artifact) ? VALIDATORS_REJECT : undefined,
      ],
    ),
    impacts: [
      ...impactsOn(skipping, 'error'),
      ...(claude ? [{ platform: 'claude-code', severity: 'error' } as const] : []),
      VALIDATORS,
    ],
    span: result.span,
  };
}

function duplicateProblem(
  scope: SkillScope,
  artifact: Artifact,
  issue: ParseIssue,
  key: string,
): Problem {
  if (codexRejectsDuplicate(key) && reached(scope, artifact, ['codex']).length > 0) {
    return {
      message: withClauses(`The frontmatter repeats ${quote(key)}.`, [
        'Codex rejects a repeated field and skips the skill',
        isDistributable(scope, artifact)
          ? 'the skills-ref validator rejects duplicate keys'
          : undefined,
      ]),
      impacts: [{ platform: 'codex', severity: 'error' }, VALIDATORS],
      span: issue.span,
    };
  }
  return {
    message: `The frontmatter repeats ${quote(key)}. The skills-ref validator rejects duplicate keys, and other YAML parsers either reject them or keep one of the values.`,
    impacts: impactsOn(SKILL_PLATFORMS, 'warn', 'distribution'),
    span: issue.span,
  };
}

function syntaxProblem(scope: SkillScope, artifact: Artifact, issue: ParseIssue): Problem {
  const yaml = frontmatterYaml(artifact.decoded.text);
  // Claude Code's recovery is undocumented: it only decides whether to claim the documented
  // outcome (no fields), never what the message says.
  const claudeRecovers = parsesAsFrontmatter(claudeCodeRepair(yaml));
  const codexRecovers = codexRepairedYaml(yaml) !== undefined;

  const clauses: string[] = [];
  const impacts: Impact[] = [VALIDATORS];
  if (!claudeRecovers && reached(scope, artifact, ['claude-code']).length > 0) {
    clauses.push('Claude Code loads the skill with no fields set');
    impacts.push({ platform: 'claude-code', severity: 'error' });
  }
  if (reached(scope, artifact, ['codex']).length > 0) {
    if (codexRecovers) {
      clauses.push('Codex quotes the value and loads the skill');
    } else {
      clauses.push('Codex skips the skill');
      impacts.push({ platform: 'codex', severity: 'error' });
    }
  }
  if (isDistributable(scope, artifact)) clauses.push(VALIDATORS_REJECT);
  return {
    message: withClauses(`The frontmatter is not valid YAML (${reason(issue)}).`, clauses),
    impacts,
    span: issue.span,
  };
}

function invalidProblem(
  scope: SkillScope,
  artifact: Artifact,
  result: Invalid,
): Problem | undefined {
  const cause = invalidCause(artifact.decoded.text, result);
  if (cause === undefined) return undefined;
  if (cause.kind === 'limit') {
    return {
      message: `agentcheckup did not check this frontmatter: ${reason(cause.issue)}.`,
      impacts: impactsOn(SKILL_PLATFORMS, 'info', 'distribution'),
      span: cause.issue.span,
    };
  }
  if (cause.kind === 'not-a-mapping') {
    const skipping = reached(scope, artifact, ['codex', 'gemini']);
    return {
      message: withClauses('The frontmatter is not a mapping of keys to values.', [
        platformsDo(skipping, SKIP, 'the skill'),
        isDistributable(scope, artifact) ? 'the skills-ref validator rejects it' : undefined,
      ]),
      impacts: [...impactsOn(skipping, 'error'), VALIDATORS],
      span: cause.issue.span,
    };
  }
  if (cause.kind === 'duplicate') return duplicateProblem(scope, artifact, cause.issue, cause.key);
  return syntaxProblem(scope, artifact, cause.issue);
}

export const frontmatterInvalidRule = defineRule({
  meta: {
    id: 'skill/frontmatter-invalid',
    title: 'Skill frontmatter is not valid YAML',
    rationale: `When the YAML between the \`---\` lines does not parse, Claude Code loads the skill with no fields set: \`/name\` works, but Claude cannot match requests against the description. Codex skips the skill, unless quoting values that contain \`: \` or start with \`[\`, \`{\`, \`@\` or a backtick makes the YAML parse; it retries once that way. Codex also skips a skill that repeats \`name\`, \`description\` or \`metadata\`. For a skill that is installed or uploaded on its own, the skills-ref validator and the anthropics/skills packager reject the file.

TOML (\`+++\`) and \`---js\` blocks are not frontmatter to any agent: Codex and Gemini CLI skip the skill, and Claude Code reads the block as instructions.

Quote values that contain \`: \` or start with a YAML indicator such as \`[\`, \`{\`, \`@\` or a backtick, indent with spaces, and do not repeat keys.`,
    category: 'loading',
    severity: 'error',
    appliesTo: ['skill'],
    platforms: SKILL_PLATFORMS,
    sources: [
      SOURCES.claudeSkills,
      SKILL_SOURCES.codexSkillParser,
      SKILL_SOURCES.geminiSkillLoader,
      SOURCES.skillsRefValidator,
      SKILL_SOURCES.anthropicsSkillValidator,
      SKILL_SOURCES.strictYaml,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const result = context.frontmatter(artifact);
      let problem: Problem | undefined;
      if (result.kind === 'unsupported') problem = unsupportedProblem(context, artifact, result);
      else if (result.kind === 'invalid') problem = invalidProblem(context, artifact, result);
      if (problem === undefined) continue;
      const resolved = resolveImpacts(context, artifact, problem.impacts);
      if (resolved === undefined) continue;
      context.report({
        artifact,
        message: problem.message,
        severity: resolved.severity,
        platforms: resolved.platforms,
        span: problem.span,
      });
    }
  },
});
