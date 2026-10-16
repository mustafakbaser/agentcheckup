import { RULESET_VERSION } from '../../core/meta.js';
import { joinRelative, pathStatus } from '../../core/paths.js';
import type { Artifact, Fix, RuleContext } from '../../core/types.js';
import { jsonRenameKey, jsonReplaceValue, safeCopiedText } from '../../fix/edits.js';
import { mcpServers } from '../../platforms/mcp.js';
import { defineRule } from '../define.js';
import { at, isObject, type JsonObject, keySpanOf, own, projectRootOf } from '../json/access.js';
import { editable, mergeEdits, sharedFileGuidance } from '../json/fix-support.js';
import { plural } from '../shared/format.js';
import { SOURCES } from '../sources.js';

const ID = 'settings/auto-approve-project-mcp';
const KEY = 'enableAllProjectMcpServers';
const LIST_KEY = 'enabledMcpjsonServers';

/** Most server names the fix copies into the list. */
const MAX_SERVERS = 100;

type Servers =
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly guidance: string };

/**
 * The servers the project's `.mcp.json` declares today, minus those `disabledMcpjsonServers`
 * turns off: what `enableAllProjectMcpServers` approves now. An absent `.mcp.json` declares none.
 */
function currentServers(
  context: RuleContext<undefined>,
  settings: Artifact,
  root: JsonObject,
): Servers {
  const path = joinRelative(projectRootOf(settings), '.mcp.json') ?? '.mcp.json';
  const manual = {
    ok: false,
    guidance: `list the servers of ${path} you trust in "${LIST_KEY}" and remove "${KEY}"`,
  } as const;
  const status = pathStatus(context.snapshot, path);
  if (status === 'missing') return { ok: true, names: [] };
  if (status !== 'exists') return manual;
  const mcp = context.allArtifacts.find(
    (artifact) => artifact.path === path && artifact.kind === 'mcp-json',
  );
  if (mcp === undefined) return manual;
  const doc = context.json(mcp);
  if (!doc.ok || !isObject(doc.value)) return manual;
  const disabledList = own(root, 'disabledMcpjsonServers');
  const disabled = new Set(
    Array.isArray(disabledList)
      ? disabledList.filter((name): name is string => typeof name === 'string')
      : [],
  );
  const names: string[] = [];
  for (const server of mcpServers(mcp, doc)) {
    if (disabled.has(server.name)) continue;
    // Server names are copied from the repository: one plain line, or no fix.
    if (safeCopiedText(server.name) !== server.name || names.length === MAX_SERVERS) {
      return manual;
    }
    names.push(server.name);
  }
  return { ok: true, names };
}

function fixFor(artifact: Artifact, names: readonly string[]): Fix | undefined {
  const change = mergeEdits(artifact, [
    jsonRenameKey(artifact, [KEY], LIST_KEY),
    jsonReplaceValue(artifact, [KEY], names),
  ]);
  if (change === undefined) return undefined;
  return {
    id: `${ID}#list`,
    class: 'review',
    title:
      names.length === 0
        ? `Replace "${KEY}" with an empty "${LIST_KEY}"`
        : `Replace "${KEY}" with "${LIST_KEY}" naming ${plural(names.length, 'server')}`,
    changes: [change],
    notes: [
      'The servers in .mcp.json today stay approved. Claude Code asks before it starts a server that a later change adds; add it to the list once you trust it.',
    ],
  };
}

export const autoApproveProjectMcpRule = defineRule({
  meta: {
    id: ID,
    title: 'Settings approve every project MCP server automatically',
    rationale: [
      'In interactive sessions, Claude Code asks before it uses a server from a project\'s `.mcp.json`. `"enableAllProjectMcpServers": true` approves every server in that file without asking, including servers that a later commit or pull request adds. In a committed `.claude/settings.json` it takes effect once a teammate trusts the project; from then on, whoever can change `.mcp.json` can start a new process on that teammate\'s machine without a prompt.',
      'List the servers you trust by name in `enabledMcpjsonServers` instead.',
    ].join('\n\n'),
    category: 'risk',
    severity: 'warn',
    appliesTo: ['claude-settings'],
    platforms: ['claude-code'],
    sources: [SOURCES.claudeSettings, SOURCES.claudeMcp],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      summary:
        'Replaces "enableAllProjectMcpServers": true with "enabledMcpjsonServers" listing the servers the project\'s .mcp.json declares today, so later additions need approval. Not offered when the file already has such a list or .mcp.json cannot be read.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const doc = context.json(artifact);
      if (!doc.ok || !isObject(doc.value)) continue;
      if (own(doc.value, KEY) !== true) continue;
      let fix: Fix | undefined;
      let guidance: string | undefined;
      if (!editable(artifact)) {
        guidance = sharedFileGuidance(artifact);
      } else if (own(doc.value, LIST_KEY) !== undefined) {
        guidance = `remove "${KEY}" and check that "${LIST_KEY}" names every server you trust`;
      } else {
        const servers = currentServers(context, artifact, doc.value);
        if (servers.ok) fix = fixFor(artifact, servers.names);
        else guidance = servers.guidance;
      }
      context.report({
        artifact,
        ...at(keySpanOf(doc, [KEY])),
        message:
          '"enableAllProjectMcpServers": true approves every server in this project\'s .mcp.json without a prompt, including servers that later commits add. List trusted servers in "enabledMcpjsonServers" instead.',
        ...(fix === undefined ? {} : { fix }),
        ...(guidance === undefined ? {} : { guidance }),
      });
    }
  },
});
