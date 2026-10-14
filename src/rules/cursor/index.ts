import type { AnyRule } from '../../core/types.js';
import { legacyCursorrulesRule } from './legacy-cursorrules.js';
import { mdFileIgnoredRule } from './md-file-ignored.js';
import { ruleFrontmatterRule } from './rule-frontmatter.js';
import { ruleNeverAppliedRule } from './rule-never-applied.js';

export const cursorRules: readonly AnyRule[] = [
  legacyCursorrulesRule,
  mdFileIgnoredRule,
  ruleFrontmatterRule,
  ruleNeverAppliedRule,
];
