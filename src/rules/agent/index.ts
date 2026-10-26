import type { AnyRule } from '../../core/types.js';
import { modelNotDocumentedRule } from './model-not-documented.js';
import { subagentModelIgnoredRule } from './subagent-model-ignored.js';

export const agentRules: readonly AnyRule[] = [modelNotDocumentedRule, subagentModelIgnoredRule];
