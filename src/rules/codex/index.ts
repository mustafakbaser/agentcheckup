import type { AnyRule } from '../../core/types.js';
import { configInvalidRule } from './config-invalid.js';
import { ignoredProjectKeyRule } from './ignored-project-key.js';

export const codexRules: readonly AnyRule[] = [configInvalidRule, ignoredProjectKeyRule];
