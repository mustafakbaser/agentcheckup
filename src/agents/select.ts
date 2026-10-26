import type { ContextAgent } from '../platforms/load/types.js';
import type { AgentsReport } from './types.js';

/** The definitions and settings of the given agents only, in the same order. */
export function selectAgents(
  report: AgentsReport,
  agents: ReadonlySet<ContextAgent>,
): AgentsReport {
  return {
    definitions: report.definitions.filter((definition) => agents.has(definition.agent)),
    settings: report.settings.filter((setting) => agents.has(setting.agent)),
  };
}
