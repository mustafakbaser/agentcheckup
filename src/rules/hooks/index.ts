import type { AnyRule } from '../../core/types.js';
import { failsOpenRule } from './fails-open.js';
import { scriptMissingRule } from './script-missing.js';
import { timeoutUnitsRule } from './timeout-units.js';
import { unknownEventRule } from './unknown-event.js';

export const hooksRules: readonly AnyRule[] = [
  failsOpenRule,
  scriptMissingRule,
  timeoutUnitsRule,
  unknownEventRule,
];
