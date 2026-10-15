import type { AnyRule } from '../../core/types.js';
import { agentsMdIgnoredByClaudeRule } from './agents-md-ignored-by-claude.js';
import { claudeMdTooLongRule } from './claude-md-too-long.js';
import { claudeRuleFrontmatterRule } from './claude-rule-frontmatter.js';
import { codexSizeBudgetRule } from './codex-size-budget.js';
import { emptyFileRule } from './empty-file.js';
import { encodingRule } from './encoding.js';
import { filenameCaseRule } from './filename-case.js';
import { importDepthRule } from './import-depth.js';
import { importOutsideRootRule } from './import-outside-root.js';
import { importUnresolvedRule } from './import-unresolved.js';
import { overrideShadowsAgentsMdRule } from './override-shadows-agents-md.js';
import { subagentInvalidRule } from './subagent-invalid.js';
import { symlinkMaterializedRule } from './symlink-materialized.js';
import { vagueDirectiveRule } from './vague-directive.js';
import { windsurfRuleTooLongRule } from './windsurf-rule-too-long.js';

export const instructionsRules: readonly AnyRule[] = [
  agentsMdIgnoredByClaudeRule,
  claudeMdTooLongRule,
  claudeRuleFrontmatterRule,
  codexSizeBudgetRule,
  emptyFileRule,
  encodingRule,
  filenameCaseRule,
  importDepthRule,
  importOutsideRootRule,
  importUnresolvedRule,
  overrideShadowsAgentsMdRule,
  subagentInvalidRule,
  symlinkMaterializedRule,
  vagueDirectiveRule,
  windsurfRuleTooLongRule,
];
