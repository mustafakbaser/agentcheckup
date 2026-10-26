import { buildAgents } from '../../agents/index.js';
import type { EffectiveModel, ModelSetting } from '../../agents/types.js';
import { RULESET_VERSION } from '../../core/meta.js';
import { lineSpan } from '../../core/text.js';
import type { RelatedLocation, RuleContext } from '../../core/types.js';
import { viewOf } from '../../platforms/load/view.js';
import { defineRule } from '../define.js';
import { quote, quotePath } from '../shared/format.js';
import { SOURCES } from '../sources.js';
import { artifactsByReading } from './readings.js';

const ID = 'agent/subagent-model-ignored';

const FORCE = 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE';

function joined(value: string | readonly string[]): string {
  return typeof value === 'string' ? value : value.join(', ');
}

/** The model Claude Code runs every subagent on while the switch is on. */
function runsOn(effective: EffectiveModel): string {
  if (effective.value === undefined) return "the main conversation's model";
  return effective.source === 'setting'
    ? `CLAUDE_CODE_SUBAGENT_MODEL, ${quote(joined(effective.value))}`
    : `the main conversation's model, ${quote(joined(effective.value))} in ${quotePath(effective.file ?? '')}`;
}

/** Where the switch is turned on, for the finding's related location. */
function switchLocation(
  context: RuleContext<undefined>,
  overridden: NonNullable<EffectiveModel['overridden']>,
  settings: readonly ModelSetting[],
): RelatedLocation {
  const file = context.allArtifacts.find((artifact) => artifact.path === overridden.file);
  const setting = settings.find(
    (candidate) => candidate.file === overridden.file && candidate.key === overridden.key,
  );
  return {
    path: overridden.file,
    message: `${FORCE} is on here.`,
    ...(file === undefined || setting === undefined
      ? {}
      : { span: lineSpan(file.decoded, setting.line) }),
  };
}

export const subagentModelIgnoredRule = defineRule({
  meta: {
    id: ID,
    title: "Claude Code ignores the subagent's model",
    rationale: [
      `While \`${FORCE}\` is on, Claude Code ignores the \`model\` field of every subagent and runs each one on \`CLAUDE_CODE_SUBAGENT_MODEL\`, or on the main conversation's model when that is not set. A repository turns it on in the \`env\` block of \`.claude/settings.json\` or \`.claude/settings.local.json\`, so a subagent's \`model\` there has no effect, though the file says otherwise. Requires Claude Code v2.1.257 or later.`,
      `Remove \`model\` from the subagent, or turn \`${FORCE}\` off if subagents should keep their own models.`,
    ].join('\n\n'),
    category: 'correctness',
    severity: 'warn',
    // The other agents' files: `.claude/agents` may reach them through a symlink.
    appliesTo: ['claude-agent', 'cursor-agent', 'gemini-agent', 'copilot-agent', 'devin-agent'],
    platforms: ['claude-code'],
    sources: [SOURCES.claudeSubagents, SOURCES.claudeModelConfig],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    if (!context.targets.has('claude-code') || context.artifacts.length === 0) return;
    const artifacts = artifactsByReading(context.artifacts);
    const { definitions, settings } = buildAgents(viewOf(context));
    for (const definition of definitions) {
      const artifact = artifacts.get(definition.file);
      const { model, effective } = definition;
      if (artifact === undefined || model === undefined || definition.agent !== 'claude-code') {
        continue;
      }
      const { overridden } = effective;
      if (overridden?.key !== `env.${FORCE}`) continue;
      if (definition.status !== 'loads' && definition.status !== 'unknown') continue;
      context.report({
        artifact,
        span: lineSpan(artifact.decoded, model.line),
        message:
          `Claude Code ignores this model, ${quote(joined(model.value))}: ` +
          `${quotePath(overridden.file)} turns on ${FORCE}, so the subagent runs on ${runsOn(effective)}.`,
        related: [switchLocation(context, overridden, settings)],
        guidance: `remove model, or turn ${FORCE} off if subagents should keep their own models`,
      });
    }
  },
});
