import type { HookPlatform } from './events.js';

export const PLATFORM_LABEL: Readonly<Record<HookPlatform, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  copilot: 'GitHub Copilot',
  windsurf: 'Devin Local',
};
