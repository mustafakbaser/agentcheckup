import type { Rule } from '../core/types.js';

/** Identity helper that gives rule objects full type inference for their options. */
export function defineRule<Options = undefined>(rule: Rule<Options>): Rule<Options> {
  return rule;
}
