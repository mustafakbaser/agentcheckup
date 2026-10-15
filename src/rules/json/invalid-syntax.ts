import { RULESET_VERSION } from '../../core/meta.js';
import type { ArtifactKind, PlatformId, Severity } from '../../core/types.js';
import type { ParseIssue } from '../../parse/types.js';
import { issueKind } from '../../platforms/json-issues.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { at } from './access.js';
import { quote } from '../shared/format.js';
import { JSON_SOURCES } from './sources.js';

export { issueKind } from '../../platforms/json-issues.js';

/** The parser's sentence as a clause: `Expected a comma.` -> `expected a comma`. */
function describeIssue(issue: ParseIssue): string {
  const text = issue.message.endsWith('.') ? issue.message.slice(0, -1) : issue.message;
  return quote(text.charAt(0).toLowerCase() + text.slice(1)).slice(1, -1);
}

interface KindBehavior {
  readonly platform: PlatformId;
  /** What the agent does with a file it cannot parse. */
  readonly consequence: string;
  /** Verified: comments and trailing commas make the agent reject the file. */
  readonly strict: boolean;
}

const BEHAVIOR: Readonly<Partial<Record<ArtifactKind, KindBehavior>>> = {
  'claude-settings': {
    platform: 'claude-code',
    consequence:
      'Claude Code reports a Settings Error at startup and runs without this file; a -p run skips it silently.',
    strict: true,
  },
  'claude-plugin-manifest': {
    platform: 'claude-code',
    consequence: 'Claude Code reports a corrupt manifest file, and the plugin cannot be installed.',
    strict: true,
  },
  'mcp-json': {
    platform: 'claude-code',
    consequence: 'Claude Code cannot load any MCP server from this file.',
    strict: false,
  },
  'cursor-mcp': {
    platform: 'cursor',
    consequence: 'Cursor cannot load any MCP server from this file.',
    strict: false,
  },
  'cursor-hooks': {
    platform: 'cursor',
    consequence: 'Cursor cannot load any hook from this file.',
    strict: false,
  },
  'codex-hooks': {
    platform: 'codex',
    consequence:
      'Codex skips the file with a "failed to parse hooks config" warning, so none of its hooks run.',
    strict: true,
  },
  'gemini-settings': {
    platform: 'gemini',
    consequence: 'Gemini CLI stops at startup with a configuration error until the file is fixed.',
    strict: true,
  },
};

const AGENT: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
};

export const invalidSyntaxRule = defineRule({
  meta: {
    id: 'json/invalid-syntax',
    title: 'Configuration file is not valid JSON',
    rationale: [
      'Agents read these files with strict JSON parsers, so a `//` comment or a comma after the last entry breaks the whole file. Claude Code reports a Settings Error and runs without the settings file (a `-p` run skips it silently). A `plugin.json` that does not parse is a corrupt manifest, and the plugin cannot be installed. Codex skips a `hooks.json` it cannot parse, with a warning. Gemini CLI does not start until `settings.json` parses.',
      'Gemini CLI removes comments from `settings.json` before parsing, and agentcheckup reads the file the same way, so only trailing commas are reported there. Claude Code and Cursor do not document how they treat comments and trailing commas in `.mcp.json`, `.cursor/mcp.json` and `.cursor/hooks.json`, so those are `info` findings. Other syntax errors are errors in every file.',
      'The finding points at the first syntax error. Fix it and run agentcheckup again.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: [
      'claude-settings',
      'claude-plugin-manifest',
      'mcp-json',
      'cursor-mcp',
      'cursor-hooks',
      'codex-hooks',
      'gemini-settings',
    ],
    platforms: ['claude-code', 'codex', 'cursor', 'gemini'],
    sources: [
      SOURCES.claudeSettings,
      JSON_SOURCES.claudePluginTroubleshooting,
      SOURCES.claudeMcp,
      JSON_SOURCES.codexHookDiscovery,
      JSON_SOURCES.geminiSettingsLoader,
      SOURCES.cursorMcp,
      SOURCES.cursorHooks,
      JSON_SOURCES.cursorStrictness,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const behavior = BEHAVIOR[artifact.kind];
      if (behavior === undefined || !context.targets.has(behavior.platform)) continue;
      const doc = context.json(artifact);
      if (doc.ok) continue;
      // For gemini-settings, context.json() already applies Gemini CLI's comment stripping.
      const issue = doc.errors[0];
      if (issue === undefined) continue;
      const kind = issueKind(issue);
      if (kind === 'limit') continue;
      let severity: Severity = 'error';
      let message: string;
      if (kind === 'other') {
        message = `This file is not valid JSON (${describeIssue(issue)}). ${behavior.consequence}`;
      } else {
        const what = kind === 'comment' ? 'comments' : 'trailing commas';
        if (behavior.strict) {
          message = `JSON does not allow ${what}, so this file does not parse. ${behavior.consequence}`;
        } else {
          severity = 'info';
          message = `JSON does not allow ${what}. ${AGENT[behavior.platform] ?? behavior.platform} does not document whether it accepts them here; a strict JSON parser rejects the whole file.`;
        }
      }
      context.report({
        artifact,
        ...at(issue.span),
        severity,
        message,
        platforms: [behavior.platform],
      });
    }
  },
});
