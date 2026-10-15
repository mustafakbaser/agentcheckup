import type { AnyRule } from '../../core/types.js';
import { duplicateKeyRule } from './duplicate-key.js';
import { invalidSyntaxRule } from './invalid-syntax.js';

export const jsonRules: readonly AnyRule[] = [duplicateKeyRule, invalidSyntaxRule];
