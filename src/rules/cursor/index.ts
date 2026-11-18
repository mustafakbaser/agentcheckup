import type { AnyRule } from '../../core/types.js';
import { bugbotRuleTooLongRule } from './bugbot-rule-too-long.js';
import { legacyCursorrulesRule } from './legacy-cursorrules.js';
import { mdFileIgnoredRule } from './md-file-ignored.js';
import { ruleFrontmatterRule } from './rule-frontmatter.js';
import { ruleNeverAppliedRule } from './rule-never-applied.js';

export const cursorRules: readonly AnyRule[] = [
  bugbotRuleTooLongRule,
  legacyCursorrulesRule,
  mdFileIgnoredRule,
  ruleFrontmatterRule,
  ruleNeverAppliedRule,
];
