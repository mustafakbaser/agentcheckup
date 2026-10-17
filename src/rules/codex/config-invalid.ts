import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix } from '../../core/paths.js';
import type { Artifact, RuleContext } from '../../core/types.js';
import { issueKind } from '../../parse/json-access.js';
import { TOML_ISSUE } from '../../parse/toml.js';
import {
  type CodexServerProblem,
  codexProjectConfig,
  codexServerProblem,
} from '../../platforms/codex-config.js';
import { chainDirectories } from '../../platforms/load/codex-chain.js';
import { viewOf } from '../../platforms/load/view.js';
import { codexMcpServers } from '../../platforms/mcp.js';
import { nearestGitRoot } from '../../platforms/paths.js';
import { defineRule } from '../define.js';
import { at, FileFindings, keySpanOf } from '../json/access.js';
import { quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';

const ID = 'codex/config-invalid';

function problemMessage(name: string, problem: CodexServerProblem): string {
  const server = `MCP server ${quote(name)}`;
  const outcome =
    'Codex rejects the entry; whether it then stops at startup or only drops the server is not verified.';
  if (problem.kind === 'no-transport') {
    return `${server} has neither "command" nor "url", so it has no transport ("invalid transport"). ${outcome}`;
  }
  const { field, transport } = problem;
  if (field === 'bearer_token') {
    return `${server} sets "bearer_token", which Codex does not take on any server ("bearer_token is not supported for ${transport}"). ${outcome}`;
  }
  const kind =
    transport === 'stdio' ? 'a local (stdio) server' : 'a remote (streamable HTTP) server';
  return `${server} is ${kind}, and Codex does not take ${quote(field)} there ("${field} is not supported for ${transport}"). ${outcome}`;
}

function problemGuidance(problem: CodexServerProblem): string {
  if (problem.kind === 'no-transport') {
    return 'add "command" for a local server or "url" for a remote one, or remove the server';
  }
  if (problem.field === 'bearer_token') {
    return 'remove "bearer_token", revoke the token, and name an environment variable that holds it in "bearer_token_env_var"';
  }
  return problem.transport === 'stdio' && problem.field === 'url'
    ? 'keep either "command" or "url" for this server, or split it into two servers'
    : `remove ${quote(problem.field)} from this server`;
}

/** The directories whose layers Codex merges for a session started next to `artifact`. */
function layerDirectories(context: RuleContext<unknown>, artifact: Artifact): string[] {
  const owner = dirnamePosix(dirnamePosix(artifact.path));
  return chainDirectories(nearestGitRoot(context.snapshot, owner) ?? owner, owner);
}

export const configInvalidRule = defineRule({
  meta: {
    id: ID,
    title: 'Codex project config is not valid',
    rationale: [
      'Codex reads `.codex/config.toml` in each directory from the project root down to the working directory. When one of them is not valid TOML, Codex stops at startup with "Error parsing project config file" in a trusted project, so no session starts there. A file that is not valid UTF-8 stops it with "Failed to read project config file", trusted or not. Codex reads TOML 1.1, so line breaks and a trailing comma in an inline table, `\\e`, `\\xHH` and times without seconds are fine.',
      'The rule also warns about MCP server entries Codex rejects: one with neither `command` nor `url`, one with both, a field the transport does not take, and `bearer_token`, which Codex does not accept at all. Whether such an entry stops Codex at startup or only drops the server is not verified. Server entries are judged as Codex merges them across the project config files above.',
      'Fix the syntax at the position the message gives, or the server entry.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: ['codex-config'],
    platforms: ['codex'],
    sources: [
      SOURCES.codexConfigLoader,
      SOURCES.codexReadFileText,
      SOURCES.codexMcpTypes,
      SOURCES.codexMcp,
      SOURCES.codexConfigBasic,
      SOURCES.codexCargoLock,
      SOURCES.tomlSpec11,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    if (!context.targets.has('codex')) return;
    const view = viewOf(context);
    for (const artifact of context.artifacts) {
      const doc = context.toml(artifact);
      if (!doc.ok) {
        const [issue] = doc.errors;
        // Limits and UTF-16 text: agentcheckup did not read the file, Codex may.
        if (issue === undefined || issueKind(issue) !== 'other') continue;
        context.report({
          artifact,
          span: issue.span,
          message:
            issue.code === TOML_ISSUE.invalidUtf8
              ? 'This file is not valid UTF-8, so Codex cannot read it and stops at startup with "Failed to read project config file", in trusted and untrusted projects alike.'
              : `This file is not valid TOML: ${issue.message} In a trusted project Codex stops at startup with "Error parsing project config file", so no session starts here.`,
          platforms: ['codex'],
          guidance:
            issue.code === TOML_ISSUE.invalidUtf8
              ? 'save the file as UTF-8'
              : 'correct the TOML at this position',
        });
        continue;
      }
      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, 'MCP server entries Codex rejects');
      const config = codexProjectConfig(view, layerDirectories(context, artifact));
      for (const server of codexMcpServers(doc)) {
        const merged = config.table(['mcp_servers', server.name]) ?? server.config;
        const problem = codexServerProblem(merged);
        if (problem === undefined) continue;
        const field = problem.kind === 'unsupported-field' ? problem.field : undefined;
        const span =
          (field === undefined ? undefined : keySpanOf(doc, [...server.path, field])) ??
          keySpanOf(doc, server.path);
        findings.report({
          artifact,
          ...at(span),
          severity: 'warn',
          message: problemMessage(server.name, problem),
          platforms: ['codex'],
          guidance: problemGuidance(problem),
        });
      }
      findings.finish();
    }
  },
});
