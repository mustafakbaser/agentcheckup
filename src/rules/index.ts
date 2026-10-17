import type { AnyRule } from '../core/types.js';
import { analysisRules } from './analysis/index.js';
import { copilotRules } from './copilot/index.js';
import { cursorRules } from './cursor/index.js';
import { geminiRules } from './gemini/index.js';
import { hooksRules } from './hooks/index.js';
import { instructionsRules } from './instructions/index.js';
import { jsonRules } from './json/index.js';
import { mcpRules } from './mcp/index.js';
import { riskRules } from './risk/index.js';
import { settingsRules } from './settings/index.js';
import { skillRules } from './skill/index.js';

/** Every built-in rule, in id order. */
export const builtinRules: readonly AnyRule[] = [
  ...analysisRules,
  ...copilotRules,
  ...cursorRules,
  ...geminiRules,
  ...hooksRules,
  ...instructionsRules,
  ...jsonRules,
  ...mcpRules,
  ...riskRules,
  ...settingsRules,
  ...skillRules,
].sort((a, b) => (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0));
