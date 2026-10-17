import { RULESET_VERSION } from '../../core/meta.js';
import { PLATFORM_IDS } from '../../core/types.js';
import type { Artifact, ArtifactKind, PlatformId } from '../../core/types.js';
import { configDocument, MARKDOWN_KINDS } from '../../platforms/kinds.js';
import { defineRule } from '../define.js';
import { hookHandlers, hookSourceOf } from '../hooks/walk.js';
import { at, collectStrings, type JsonPath, own, type ParsedJson, spanOf } from '../json/access.js';
import { formatInteger, quote } from '../shared/format.js';
import { mcpServers } from '../mcp/servers.js';
import { SOURCES } from '../sources.js';
import {
  findRemoteExecution,
  findRemoteExecutionInLine,
  type RemoteExecution,
} from './remote-script.js';
import { CommandContext } from './command-context.js';
import { RISK_SOURCES } from './sources.js';

/** JSON and TOML kinds whose hook or MCP server commands run without the agent deciding to. */
const COMMAND_KINDS: readonly ArtifactKind[] = [
  'claude-settings',
  'codex-hooks',
  'cursor-hooks',
  'gemini-settings',
  'mcp-json',
  'cursor-mcp',
  'claude-plugin-manifest',
  'codex-config',
];

/** Findings per file; a file with more lines like this gets one summary finding. */
export const MAX_REMOTE_FINDINGS = 20;

/** The manual step: no fix, because only the author knows which version to trust. */
const GUIDANCE =
  'download the script to a file, pin it to a version or checksum (for example with sha256sum -c) and run that file, or install the tool from a package manager';

function transport(match: RemoteExecution): string {
  return match.url.toLowerCase().startsWith('http://')
    ? ' Over http://, anyone on the network path can also replace the script.'
    : '';
}

export function describeRemoteExecution(match: RemoteExecution): string {
  return `This command downloads a script from ${quote(match.url)} and runs it in one step (${match.form}). An agent that follows it runs whatever that address serves at the time, without review.${transport(match)}`;
}

function describeCommand(match: RemoteExecution, what: string): string {
  return `${what} downloads a script from ${quote(match.url)} and runs it in one step (${match.form}) every time it runs. Whoever controls that address decides what runs on every machine that uses this configuration.${transport(match)}`;
}

interface CommandString {
  readonly path: JsonPath;
  readonly value: string;
  readonly what: string;
}

/** Hook commands and MCP server command lines: strings that run without anyone reading them. */
function commandStrings(artifact: Artifact, doc: ParsedJson): CommandString[] {
  const out: CommandString[] = [];
  const source = hookSourceOf(artifact);
  if (source !== undefined) {
    for (const { event, handler, path } of hookHandlers(doc, source.platform, {
      root: source.root,
    })) {
      const command = own(handler, 'command');
      if (typeof command === 'string') {
        out.push({ path: [...path, 'command'], value: command, what: `This ${event} hook` });
      }
    }
  }
  if (
    artifact.kind !== 'claude-settings' &&
    artifact.kind !== 'codex-hooks' &&
    artifact.kind !== 'cursor-hooks'
  ) {
    for (const server of mcpServers(artifact, doc)) {
      // Codex also runs `http_headers_helper` to get a remote server's headers.
      const fields =
        artifact.kind === 'codex-config'
          ? ['command', 'args', 'http_headers_helper']
          : ['command', 'args'];
      for (const field of fields) {
        for (const item of collectStrings(own(server.config, field), [...server.path, field])) {
          out.push({ ...item, what: `MCP server ${quote(server.name)}` });
        }
      }
    }
  }
  return out;
}

export const remoteScriptExecutionRule = defineRule({
  meta: {
    id: 'risk/remote-script-execution',
    title: 'Command downloads a script and runs it in one step',
    rationale: [
      "Agents run commands from their instruction and skill files, including commands in code blocks. `curl -fsSL https://… | sh` downloads a script and runs it in one step, so whoever controls that address when the command runs decides what executes, with the user's permissions, and nothing reviews it. Hook commands and MCP server command lines do this on every event or server start, without anyone deciding to run them. Claude Code does not auto-approve `curl` and `wget` by default, as a defense against prompt injection.",
      'The rule reports `curl` or `wget` piped into a shell or interpreter, `bash <(curl …)`, `bash -c "$(curl …)"`, `eval "$(curl …)"` and PowerShell `irm … | iex` with a real URL. Not reported: placeholder URLs such as `https://example.com`, commands that their line, paragraph or heading says not to run, and commands addressed to a person ("tell the user to install it with …"), because a person sees those before anything runs.',
      'Pin the download to a version and checksum, or install from a package manager or a vendored script.',
    ].join('\n\n'),
    category: 'risk',
    severity: 'warn',
    appliesTo: [...MARKDOWN_KINDS, ...COMMAND_KINDS],
    platforms: PLATFORM_IDS,
    sources: [RISK_SOURCES.claudeSecurity, SOURCES.agentsMd],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const readers = artifact.readers.filter((platform: PlatformId) =>
        context.targets.has(platform),
      );
      if (readers.length === 0) continue;
      if (!MARKDOWN_KINDS.has(artifact.kind)) {
        const doc = configDocument(context, artifact);
        if (!doc.ok) continue;
        let reported = 0;
        for (const command of commandStrings(artifact, doc)) {
          if (reported === MAX_REMOTE_FINDINGS) break;
          const match = findRemoteExecution(command.value, 0, command.value.length);
          if (match === undefined) continue;
          reported++;
          context.report({
            artifact,
            ...at(spanOf(doc, command.path)),
            message: describeCommand(match, command.what),
            platforms: readers,
            guidance: GUIDANCE,
          });
        }
        continue;
      }
      const { text, lineStarts } = artifact.decoded;
      let reported = 0;
      let skipped = 0;
      let firstSkipped: RemoteExecution | undefined;
      let prose: CommandContext | undefined;
      for (let line = 0; line < lineStarts.length; line++) {
        const start = lineStarts[line] ?? 0;
        const end = lineStarts[line + 1] ?? text.length;
        const match = findRemoteExecutionInLine(text, start, end);
        if (match === undefined) continue;
        prose ??= new CommandContext(text, lineStarts, context.markdown(artifact));
        if (prose.suppression(line, match.offset) !== undefined) continue;
        if (reported === MAX_REMOTE_FINDINGS) {
          skipped++;
          firstSkipped ??= match;
          continue;
        }
        reported++;
        context.report({
          artifact,
          span: { offset: match.offset, length: match.length },
          message: describeRemoteExecution(match),
          platforms: readers,
          guidance: GUIDANCE,
        });
      }
      if (firstSkipped !== undefined) {
        context.report({
          artifact,
          span: { offset: firstSkipped.offset, length: firstSkipped.length },
          message: `Only the first ${formatInteger(MAX_REMOTE_FINDINGS)} lines that download and run a script in this file are listed; ${formatInteger(skipped)} more from here on ${skipped === 1 ? 'is' : 'are'} not.`,
          platforms: readers,
        });
      }
    }
  },
});
