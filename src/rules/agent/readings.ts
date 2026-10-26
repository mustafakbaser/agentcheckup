/**
 * What the agent rules share: the artifact behind each definition, at every path an agent reads
 * it from (a symlink's too), and whether the agent reads the file in its own format.
 */
import type { AgentDefinition } from '../../agents/types.js';
import type { Artifact, ArtifactKind } from '../../core/types.js';
import { classify } from '../../platforms/classify.js';
import type { ContextAgent } from '../../platforms/load/types.js';
import { readingsOf } from '../../platforms/readings.js';

/** Each artifact by its own path and by every symlink alias that makes it an agent file. */
export function artifactsByReading(artifacts: readonly Artifact[]): Map<string, Artifact> {
  return new Map(
    artifacts.flatMap((artifact) => readingsOf(artifact).map(({ path }) => [path, artifact])),
  );
}

/** The kind of file each agent defines its custom agents in. */
const OWN_KIND: Readonly<Record<ContextAgent, ArtifactKind | undefined>> = {
  'claude-code': 'claude-agent',
  codex: 'codex-agent',
  cursor: 'cursor-agent',
  gemini: 'gemini-agent',
  'copilot-cli': 'copilot-agent',
  'copilot-vscode': 'copilot-agent',
  'copilot-cloud': 'copilot-agent',
  windsurf: 'devin-agent',
  cline: undefined,
};

/**
 * True when the agent reads the definition's file in its own format, not as another agent's
 * file it reads too, such as Cursor reading `.claude/agents`.
 */
export function inOwnFormat(definition: AgentDefinition): boolean {
  const kind = classify(definition.file)?.kind;
  return kind !== undefined && kind === OWN_KIND[definition.agent];
}
