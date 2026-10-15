import type { AnyRule } from '../../core/types.js';
import { hiddenCommentRule } from './hidden-comment.js';
import { hiddenUnicodeRule } from './hidden-unicode.js';
import { remoteScriptExecutionRule } from './remote-script-execution.js';

export const riskRules: readonly AnyRule[] = [
  hiddenCommentRule,
  hiddenUnicodeRule,
  remoteScriptExecutionRule,
];
