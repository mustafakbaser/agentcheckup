import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix } from '../../core/paths.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { isBlank } from './codex.js';
import { basename, fileExists, joinPath } from './helpers.js';

export const overrideShadowsAgentsMdRule = defineRule({
  meta: {
    id: 'instr/override-shadows-agents-md',
    title: 'AGENTS.override.md hides AGENTS.md from Codex',
    rationale: [
      'In each directory, Codex reads only the first of `AGENTS.override.md` and `AGENTS.md` that exists as a file. It picks the override even when it is empty, then skips it because it has no content, so an empty or whitespace-only `AGENTS.override.md` leaves Codex with no instructions from that directory.',
      'A non-empty override replaces `AGENTS.md` for Codex only: Claude Code never reads `AGENTS.override.md`, and the other agents do not document it. That case is reported as information.',
      'Delete an override you no longer need, or keep it out of version control.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: ['agents-override-md'],
    platforms: ['codex'],
    sources: [SOURCES.codexAgentsMd, SOURCES.codexAgentsMdSource],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      // A case variant such as agents.override.md is not found on case-sensitive file systems;
      // instr/filename-case reports it.
      if (basename(artifact.path) !== 'AGENTS.override.md') continue;
      const directory = dirnamePosix(artifact.path);
      const agentsPath = joinPath(directory, 'AGENTS.md');
      if (!fileExists(context.snapshot, agentsPath)) continue;
      const related = [
        { path: agentsPath, message: 'Not read by Codex while the override exists.' },
      ];
      if (isBlank(artifact.decoded.text)) {
        context.report({
          artifact,
          related,
          message:
            'This AGENTS.override.md is empty, but Codex still reads it instead of the AGENTS.md next to it, so Codex gets no instructions from this directory.',
        });
      } else {
        context.report({
          artifact,
          related,
          severity: 'info',
          message:
            'Codex reads this file instead of the AGENTS.md next to it, so Codex does not see the instructions in AGENTS.md. Claude Code never reads AGENTS.override.md.',
        });
      }
    }
  },
});
