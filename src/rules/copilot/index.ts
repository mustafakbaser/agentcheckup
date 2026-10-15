import type { AnyRule } from '../../core/types.js';
import { applyToRule } from './apply-to.js';
import { instructionsMisplacedRule } from './instructions-misplaced.js';

export const copilotRules: readonly AnyRule[] = [applyToRule, instructionsMisplacedRule];
