import type { AnyRule } from '../../core/types.js';
import { settingsKeyIgnoredRule } from './settings-key-ignored.js';

export const geminiRules: readonly AnyRule[] = [settingsKeyIgnoredRule];
