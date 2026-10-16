import { RULESET_VERSION } from '../../core/meta.js';
import type { Span } from '../../core/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { quote } from '../shared/format.js';
import {
  type Impact,
  inPlugin,
  isDistributable,
  loadableSkills,
  normalizeName,
  resolveImpacts,
  skillLocation,
  trimmedString,
  validFrontmatter,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

const RESERVED_WORDS = ['anthropic', 'claude'] as const;
const SYNCED_NAMESPACE = 'anthropic-skills';

const isReservedNamespace = (name: string): boolean =>
  name === SYNCED_NAMESPACE || name.startsWith(`${SYNCED_NAMESPACE}:`);

/**
 * The skill folder name when SKILL.md sits directly in a `.claude/skills` directory, the only
 * place where Claude Code applies its reserved folder names, with whether that directory is the
 * project's own (at the scan root).
 */
function claudeSkillFolder(path: string): { folder: string; project: boolean } | undefined {
  const location = skillLocation(path);
  if (!location?.root.endsWith('.claude/skills')) return undefined;
  const parts = location.relative.split('/');
  const folder = parts.length === 2 ? parts[0] : undefined;
  return folder === undefined ? undefined : { folder, project: location.root === '.claude/skills' };
}

interface Problem {
  readonly message: string;
  readonly impacts: readonly Impact[];
  readonly span?: Span;
  readonly guidance: string;
}

const RENAME_DIRECTORY = 'rename the skill directory, and set "name" to match';
const RENAME_SKILL =
  'choose a name without "anthropic" or "claude", and rename the skill directory to match';

function folderProblem(paths: readonly string[]): Problem | undefined {
  for (const path of paths) {
    const found = claudeSkillFolder(path);
    if (found === undefined) continue;
    const { folder, project } = found;
    // Claude Code documents the `synced` folder only in its enterprise, personal and project
    // skills directories. Of these, a scan sees only the project's own `.claude/skills`, not
    // nested ones or directories added with --add-dir.
    if (project && folder.toLowerCase() === 'synced') {
      return {
        message: `The skill directory ${quote(folder)} is reserved for skills synced from claude.ai, so Claude Code skips this skill.`,
        impacts: [{ platform: 'claude-code', severity: 'error' }],
        guidance: RENAME_DIRECTORY,
      };
    }
    if (isReservedNamespace(folder)) {
      return {
        message: `The skill directory ${quote(folder)} is reserved for skills synced from claude.ai, so Claude Code skips this skill.`,
        impacts: [{ platform: 'claude-code', severity: 'error' }],
        guidance: RENAME_DIRECTORY,
      };
    }
  }
  return undefined;
}

function nameProblem(
  raw: string,
  span: Span | undefined,
  distributable: boolean,
  inPlugin: boolean,
): Problem | undefined {
  const name = normalizeName(raw).toLowerCase();
  const word = RESERVED_WORDS.find((reserved) => name.includes(reserved));
  // Claude Code applies the reserved namespace outside plugins only.
  const namespace = isReservedNamespace(name) && !inPlugin;
  if (namespace) {
    return {
      message: `Skill name ${quote(raw)} is reserved for skills synced from claude.ai, so Claude Code skips the skill.${distributable ? ' The Claude API and claude.ai upload also reject a name that contains "anthropic".' : ''}`,
      impacts: [
        { platform: 'claude-code', severity: 'error' },
        { platform: 'claude-code', severity: 'warn', scope: 'distribution' },
      ],
      ...(span === undefined ? {} : { span }),
      guidance: RENAME_SKILL,
    };
  }
  if (word === undefined || !distributable) return undefined;
  return {
    message: `Skill name ${quote(raw)} contains the reserved word ${quote(word)}, so the Claude API and claude.ai upload reject the skill.`,
    impacts: [{ platform: 'claude-code', severity: 'warn', scope: 'distribution' }],
    ...(span === undefined ? {} : { span }),
    guidance: RENAME_SKILL,
  };
}

export const nameReservedWordRule = defineRule({
  meta: {
    id: 'skill/name-reserved-word',
    title: 'Skill name uses a reserved word or name',
    rationale: `The Claude API and claude.ai upload reject a skill whose \`name\` contains the reserved words \`anthropic\` or \`claude\`. This matters only for skills that are installed or uploaded on their own, so it is not reported for skills in an agent's skills directory or in a plugin.

Claude Code reserves names for skills synced from claude.ai. Outside a plugin, a skill directory or frontmatter \`name\` that is \`anthropic-skills\` or starts with \`anthropic-skills:\` does not load, and Claude Code skips a skill directory named \`synced\`, in any letter case, in its enterprise, personal and project skills directories. Of these, agentcheckup sees only the project's \`.claude/skills\` at the scan root, so it checks \`synced\` there and not in nested \`.claude/skills\` directories.

Choose a name without these words.`,
    category: 'portability',
    severity: 'warn',
    appliesTo: ['skill'],
    platforms: ['claude-code'],
    sources: [
      SOURCES.claudeApiSkills,
      SKILL_SOURCES.claudeSkillsApiGuide,
      SKILL_SOURCES.claudeSkillBestPractices,
      SOURCES.claudeSkills,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const problems: Problem[] = [];
      const folder = folderProblem([artifact.path, ...artifact.aliases]);
      if (folder !== undefined) problems.push(folder);
      const frontmatter = validFrontmatter(context, artifact);
      const raw = trimmedString(frontmatter?.data.values['name']);
      if (frontmatter !== undefined && raw !== undefined && raw !== '') {
        const problem = nameProblem(
          raw,
          frontmatter.data.valueSpan('name'),
          isDistributable(context, artifact),
          inPlugin(context, artifact),
        );
        if (problem !== undefined) problems.push(problem);
      }
      for (const problem of problems) {
        const resolved = resolveImpacts(context, artifact, problem.impacts);
        if (resolved === undefined) continue;
        context.report({
          artifact,
          message: problem.message,
          severity: resolved.severity,
          platforms: resolved.platforms,
          ...(problem.span === undefined ? {} : { span: problem.span }),
          guidance: problem.guidance,
        });
      }
    }
  },
});
