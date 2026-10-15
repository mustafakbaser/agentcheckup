import type { RuleSource } from '../../core/types.js';
import { SOURCES } from '../../platforms/sources.js';

/**
 * Evidence used only by the skill family, checked 2026-10-14. Shared evidence lives in
 * src/rules/sources.ts. Source-code entries point at the default branch; the behavior they cite
 * is described in the rationale of each rule that uses them.
 */
const CHECKED = '2026-10-14';

const verified = (title: string, url: string): RuleSource => ({
  title,
  url,
  checked: CHECKED,
  status: 'verified',
});

export const SKILL_SOURCES = {
  claudePermissions: verified(
    'Claude Code: Configure permissions',
    'https://code.claude.com/docs/en/permissions',
  ),
  claudeSkillsApiGuide: verified(
    'Claude API: Using Agent Skills with the API',
    'https://platform.claude.com/docs/en/build-with-claude/skills-guide',
  ),
  claudeSkillBestPractices: verified(
    'Claude API: Skill authoring best practices',
    'https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices',
  ),
  anthropicsSkillValidator: verified(
    'anthropics/skills packager validation (quick_validate.py)',
    'https://github.com/anthropics/skills/blob/main/skills/skill-creator/scripts/quick_validate.py',
  ),
  // Shared with the Codex load plan, which cites them by key.
  codexSkillParser: SOURCES.codexSkillParser,
  codexSkillLoader: SOURCES.codexSkillLoader,
  codexSkillDiscovery: SOURCES.codexSkillDiscovery,
  codexReadFileText: SOURCES.codexReadFileText,
  unicodeWhiteSpace: verified(
    'Unicode PropList.txt: White_Space (U+FEFF is not whitespace, so Rust trim() keeps it)',
    'https://www.unicode.org/Public/UCD/latest/ucd/PropList.txt',
  ),
  geminiSkills: verified('Gemini CLI: Agent Skills', 'https://geminicli.com/docs/cli/skills/'),
  geminiSkillLoader: verified(
    'Gemini CLI source: skillLoader.ts',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/skills/skillLoader.ts',
  ),
  geminiSkillManager: verified(
    'Gemini CLI source: skillManager.ts (same-name skills override each other)',
    'https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/skills/skillManager.ts',
  ),
  vscodeSkills: verified(
    'VS Code: Use Agent Skills (GitHub Copilot)',
    'https://code.visualstudio.com/docs/agent-customization/agent-skills',
  ),
  copilotAddSkills: verified(
    'GitHub Copilot: Add skills',
    'https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills',
  ),
  strictYaml: verified(
    'StrictYAML (used by skills-ref): features removed from YAML',
    'https://hitchdev.com/strictyaml/features-removed/',
  ),
  yaml11Bool: verified('YAML 1.1: Boolean type', 'https://yaml.org/type/bool.html'),
} as const satisfies Record<string, RuleSource>;
