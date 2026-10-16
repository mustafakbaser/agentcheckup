import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, ArtifactKind, Fix, PlatformId, Severity, Span } from '../../core/types.js';
import { replaceSpan } from '../../fix/edits.js';
import { lineEndAfter, lineStartBefore } from '../../fix/text.js';
import { issueKind } from '../../parse/json-access.js';
import type { ParseIssue } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { at } from './access.js';
import { plural, quote } from '../shared/format.js';
import { editable, mergeEdits, sharedFileGuidance } from './fix-support.js';
import { JSON_SOURCES } from './sources.js';

// Shared with the load plans, which skip a config file that does not parse.
export { issueKind } from '../../parse/json-access.js';
export type { IssueKind } from '../../parse/json-access.js';

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

const ID = 'json/invalid-syntax';

function isBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 0x20 && code !== 0x09) return false;
  }
  return true;
}

/**
 * What to delete for a comment at `span`: the whole line when the comment is alone on it (with
 * the line break), otherwise the comment and the spaces that separate it from the code.
 */
function commentRange(text: string, span: Span): Span {
  const end = span.offset + span.length;
  const lineStart = lineStartBefore(text, span.offset);
  const lineEnd = lineEndAfter(text, end);
  const before = text.slice(lineStart, span.offset);
  const after = text.slice(end, lineEnd);
  if (isBlank(before) && isBlank(after)) {
    const newline = text.indexOf('\n', lineEnd);
    if (newline !== -1) return { offset: lineStart, length: newline + 1 - lineStart };
    // The last line: take the line break before it instead.
    let start = lineStart;
    if (start > 0 && text.charCodeAt(start - 1) === 0x0a) start--;
    if (start > 0 && text.charCodeAt(start - 1) === 0x0d) start--;
    return { offset: start, length: lineEnd - start };
  }
  if (isBlank(before)) {
    let stop = end;
    while (stop < lineEnd && (text.charCodeAt(stop) === 0x20 || text.charCodeAt(stop) === 0x09)) {
      stop++;
    }
    return { offset: span.offset, length: stop - span.offset };
  }
  let start = span.offset;
  while (start > lineStart && isBlank(text.charAt(start - 1))) start--;
  return { offset: start, length: end - start };
}

/** Sorted, non-overlapping spans; touching or overlapping ones are joined. */
function joinSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.offset - b.offset);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out.at(-1);
    if (last !== undefined && span.offset <= last.offset + last.length) {
      const end = Math.max(last.offset + last.length, span.offset + span.length);
      out[out.length - 1] = { offset: last.offset, length: end - last.offset };
    } else {
      out.push(span);
    }
  }
  return out;
}

/**
 * Deletes every trailing comma and, with `comments`, every comment, when those are the file's
 * only syntax errors. Gemini CLI strips comments itself, so its settings keep them. Undefined
 * when another error is listed, or the parser's list may be cut short.
 */
function stripFix(
  artifact: Artifact,
  errors: readonly ParseIssue[],
  comments: boolean,
): Fix | undefined {
  if (errors.length === 0 || errors.length >= MAX_LISTED_ERRORS) return undefined;
  const { text } = artifact.decoded;
  const spans: Span[] = [];
  let commas = 0;
  let removed = 0;
  for (const error of errors) {
    const kind = issueKind(error);
    if (kind === 'trailing-comma' && text.charAt(error.span.offset) === ',') {
      commas++;
      spans.push({ offset: error.span.offset, length: 1 });
    } else if (kind === 'comment' && comments && error.span.length >= 2) {
      removed++;
      spans.push(commentRange(text, error.span));
    } else {
      return undefined;
    }
  }
  const change = mergeEdits(
    artifact,
    joinSpans(spans).map((span) => replaceSpan(artifact, span, '')),
  );
  if (change === undefined) return undefined;
  const parts = [
    ...(removed === 0 ? [] : [plural(removed, 'comment')]),
    ...(commas === 0 ? [] : [plural(commas, 'trailing comma')]),
  ];
  return {
    id: `${ID}#strip`,
    class: 'review',
    title: `Delete ${parts.join(' and ')} so the file is valid JSON`,
    changes: [change],
    ...(removed === 0
      ? {}
      : {
          notes: [
            'The comments are deleted, not moved: keep anything you still need in a README or a "description" field.',
          ],
        }),
  };
}

/** The JSON parser lists at most this many errors; a list this long may be incomplete. */
const MAX_LISTED_ERRORS = 100;

export const invalidSyntaxRule = defineRule({
  meta: {
    id: ID,
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
    fix: {
      classes: ['review'],
      summary:
        'Deletes the trailing commas and comments (in Gemini CLI settings, which allow comments, only the trailing commas) when they are the only syntax errors. Other syntax errors are left to you.',
    },
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
      const fix =
        kind !== 'other' && editable(artifact)
          ? stripFix(artifact, doc.errors, artifact.kind !== 'gemini-settings')
          : undefined;
      context.report({
        artifact,
        ...at(issue.span),
        severity,
        message,
        platforms: [behavior.platform],
        ...(fix === undefined ? {} : { fix }),
        ...(kind !== 'other' && !editable(artifact)
          ? { guidance: sharedFileGuidance(artifact) }
          : {}),
      });
    }
  },
});
