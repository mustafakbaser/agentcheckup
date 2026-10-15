import { RULESET_VERSION } from '../../core/meta.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { quote } from '../shared/format.js';
import { basename, targetedReaders } from './helpers.js';
import { INSTRUCTION_SOURCES } from './sources.js';

export const filenameCaseRule = defineRule({
  meta: {
    id: 'instr/filename-case',
    title: 'Instruction file name has the wrong letter case',
    rationale: [
      'Agents look for instruction files by exact name: `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`. Codex, for example, opens a file named exactly `AGENTS.md` in each directory. On the case-insensitive file systems that macOS and Windows use by default, `Agents.md` matches that name and loads; on Linux, including most CI runners and containers, it does not. The same repository then gives agents different instructions on different machines.',
      "Windsurf's Cascade agent documents both `AGENTS.md` and `agents.md`, so agentcheckup does not report `agents.md` for Windsurf; other spellings, such as `Agents.md`, are reported.",
      'Rename the file to the exact name if it holds agent instructions, or to a different name if it does not. On a case-insensitive file system, use `git mv` so Git records the rename.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'warn',
    appliesTo: ['agents-md', 'agents-override-md', 'claude-md', 'claude-local-md', 'gemini-md'],
    platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini', 'windsurf', 'cline'],
    sources: [
      SOURCES.codexAgentsMdSource,
      SOURCES.claudeMemory,
      SOURCES.geminiMd,
      INSTRUCTION_SOURCES.cascadeAgentsMd,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      if (artifact.caseMismatch === undefined) continue;
      // Cascade documents exactly two spellings, AGENTS.md and agents.md.
      const documentedForCascade = basename(artifact.path) === 'agents.md';
      const platforms = targetedReaders(context, artifact).filter(
        (platform) => !(documentedForCascade && platform === 'windsurf'),
      );
      if (platforms.length === 0) continue;
      const name = quote(basename(artifact.path));
      const expected = quote(basename(artifact.caseMismatch.expected));
      context.report({
        artifact,
        platforms,
        message: `This file is named ${name}, not ${expected}, so agents find it on macOS and Windows but not on Linux, where file names are case-sensitive. Rename it to ${expected}, or give it another name if it is not agent instructions.`,
      });
    }
  },
});
