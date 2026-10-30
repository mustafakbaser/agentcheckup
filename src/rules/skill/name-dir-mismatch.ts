import { RULESET_VERSION } from '../../core/meta.js';
import { pluginRootOf } from '../../platforms/location.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { joinClauses, joinNames, quote, quotePath, sentence } from '../shared/format.js';
import {
  type Impact,
  isDistributable,
  loadableSkills,
  normalizeName,
  readersAt,
  resolveImpacts,
  skillDirectory,
  skillDirectoryName,
  trimmedString,
  validFrontmatter,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';
import { fixFields, isValidSkillName, nameFix } from './fixes.js';

export const nameDirMismatchRule = defineRule({
  meta: {
    id: 'skill/name-dir-mismatch',
    title: 'Skill name does not match its directory name',
    rationale: `The Agent Skills specification, Cursor, Cline and GitHub Copilot in VS Code require \`name\` to equal the name of the directory that contains SKILL.md, and VS Code does not load a skill whose name does not match. The skills-ref validator compares both after NFKC normalization and rejects a mismatch. The Claude Skills API is out of beta: only a request that still sends the \`skills-2025-10-02\` beta header needs the uploaded files inside a top-level directory named after the skill, and without it \`SKILL.md\` may sit at the root of the upload. Claude Code and Codex do not require a match.

Only the agents that load the skill where it is count, so a skill in a plugin is judged by the plugin's agents. A SKILL.md at a plugin root is exempt, because there \`name\` deliberately differs from the plugin directory. The specification and upload requirements count only for skills that are installed or uploaded on their own.

Rename the directory or change \`name\` so that they match.`,
    category: 'correctness',
    severity: 'error',
    appliesTo: ['skill'],
    platforms: ['claude-code', 'cursor', 'copilot', 'cline'],
    sources: [
      SOURCES.agentSkillsSpec,
      SKILL_SOURCES.vscodeSkills,
      SOURCES.cursorSkills,
      SOURCES.clineSkills,
      SOURCES.skillsRefValidator,
      SKILL_SOURCES.claudeSkillsApiGuide,
      SOURCES.claudeSkills,
    ],
    since: RULESET_VERSION,
    fix: {
      classes: ['safe', 'review'],
      summary:
        'Sets `name` to the directory name: safe when that is the name in lowercase with hyphens, review otherwise. Directories are never renamed.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const frontmatter = validFrontmatter(context, artifact);
      if (frontmatter === undefined) continue;
      const raw = trimmedString(frontmatter.data.values['name']);
      if (raw === undefined || raw === '') continue;
      const name = normalizeName(raw);

      const reported = new Set<string>();
      for (const path of [artifact.path, ...artifact.aliases]) {
        const directory = skillDirectoryName(path);
        if (directory === undefined || reported.has(directory)) continue;
        if (normalizeName(directory) === name) continue;
        // A SKILL.md at a plugin root takes its name from `name`, not from the plugin directory.
        if (pluginRootOf(context.snapshot, path)?.root === skillDirectory(path)) continue;
        reported.add(directory);

        // Judge each path by the platforms that read that path. Only the skill's own directory
        // is packaged and uploaded, so only it carries the specification requirement.
        const own = path === artifact.path;
        const readers = readersAt(context.snapshot, path, artifact.caseMismatch !== undefined);
        const copilot = readers.has('copilot');
        const cursor = readers.has('cursor');
        const cline = readers.has('cline');
        const impacts: Impact[] = [
          ...(own
            ? [{ platform: 'claude-code', severity: 'warn', scope: 'distribution' } as const]
            : []),
          ...(copilot ? [{ platform: 'copilot', severity: 'error' } as const] : []),
          ...(cursor ? [{ platform: 'cursor', severity: 'warn' } as const] : []),
          ...(cline ? [{ platform: 'cline', severity: 'warn' } as const] : []),
        ];
        const resolved = resolveImpacts(context, artifact, impacts);
        if (resolved === undefined) continue;
        const where = own
          ? `its directory ${quote(directory)}`
          : `the directory ${quote(directory)} of its symlink ${quotePath(path)}`;
        const spec = own && isDistributable(context, artifact);
        const requirers = [
          ...(cursor ? ['Cursor'] : []),
          ...(cline ? ['Cline'] : []),
          ...(spec ? ['the Agent Skills specification'] : []),
        ];
        const consequence = sentence(
          joinClauses([
            ...(copilot ? ['GitHub Copilot in VS Code does not load the skill'] : []),
            ...(requirers.length === 0
              ? []
              : [
                  `${joinNames(requirers)} ${requirers.length === 1 ? 'requires' : 'require'} them to match`,
                ]),
          ]),
        );
        const span = frontmatter.data.valueSpan('name');
        // A symlink's directory is the user's to rename: the skill's own name may be right.
        const repair = own
          ? nameFix(context, artifact, frontmatter, 'skill/name-dir-mismatch', raw)
          : {
              guidance: isValidSkillName(name)
                ? `rename the directory of the symlink ${quotePath(path)} to ${quote(name)}`
                : 'choose a name that matches the directory of the skill and of every symlink to it, and rename directories as needed',
            };
        context.report({
          artifact,
          message: `Skill name ${quote(raw)} does not match ${where}. ${consequence}`,
          severity: resolved.severity,
          platforms: resolved.platforms,
          ...(span === undefined ? {} : { span }),
          ...fixFields(repair),
        });
      }
    }
  },
});
