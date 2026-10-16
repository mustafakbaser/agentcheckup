import { RULESET_VERSION } from '../../core/meta.js';
import { positionAt } from '../../core/text.js';
import type { Artifact, ArtifactKind, PlatformId, ReportDescriptor } from '../../core/types.js';
import { reencode } from '../../fix/edits.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { formatInteger, platformsDo } from '../shared/format.js';
import { byHand, editBlocker } from './fixes.js';
import { targetedReaders } from './helpers.js';
import { INSTRUCTION_SOURCES } from './sources.js';

const RULE_ID = 'instr/encoding';

/** Platforms whose UTF-8 decoding of this kind is verified in their source code. */
const VERIFIED_UTF8_READERS: Partial<Record<ArtifactKind, readonly PlatformId[]>> = {
  'agents-md': ['codex'],
  'agents-override-md': ['codex'],
  'gemini-md': ['gemini'],
};

function encodingName(artifact: Artifact): string {
  return artifact.decoded.encoding === 'utf-16be'
    ? 'UTF-16 (big-endian)'
    : 'UTF-16 (little-endian)';
}

/**
 * A UTF-16 file that decoded without errors is converted to UTF-8 without a byte order mark,
 * keeping its text and line endings. Anything else needs the author, who knows the encoding.
 */
function utf16Repair(artifact: Artifact): Pick<ReportDescriptor, 'fix' | 'guidance'> {
  const action = 'save the file as UTF-8';
  if (artifact.decoded.hadDecodeErrors) {
    return {
      guidance: `${action} in an editor that shows it correctly; some of its bytes are not valid ${encodingName(artifact)}, so agentcheckup does not convert it`,
    };
  }
  const blocker = editBlocker(artifact);
  if (blocker !== undefined) return { guidance: byHand(action, blocker) };
  const change = reencode(artifact);
  if (change === undefined) return { guidance: action };
  return {
    fix: {
      id: `${RULE_ID}#utf-8`,
      class: 'safe',
      title: `Convert ${artifact.path} from ${encodingName(artifact)} to UTF-8`,
      changes: [change],
    },
  };
}

/** Bytes that are not valid UTF-8 come from another encoding only the author knows. */
const INVALID_UTF8_GUIDANCE =
  'open the file in the encoding it was written in, such as Windows-1252, and save it as UTF-8';

export const encodingRule = defineRule({
  meta: {
    id: RULE_ID,
    title: 'Instruction file is not UTF-8',
    rationale: [
      "Codex decodes `AGENTS.md` as UTF-8 (`String::from_utf8_lossy`), and Gemini CLI reads `GEMINI.md` with Node.js's UTF-8 decoder. A UTF-16 file, as written by Windows PowerShell's `>` redirection or Notepad's \"Unicode\" option, reaches them as garbled text with NUL characters between the letters. Bytes that are not valid UTF-8, usually from a legacy encoding such as Windows-1252, become U+FFFD replacement characters, and the original characters are lost.",
      'The other agents do not document how they decode instruction files, so for them this is information only.',
      'Save the file as UTF-8.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: [
      'agents-md',
      'agents-override-md',
      'claude-md',
      'claude-local-md',
      'claude-rule',
      'claude-agent',
      'gemini-md',
      'windsurf-rule',
      'windsurf-legacy-rules',
      'cline-rule',
      'cursor-rule',
      'cursor-legacy-rules',
      'copilot-instructions',
      'copilot-path-instructions',
    ],
    platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini', 'windsurf', 'cline'],
    sources: [
      SOURCES.codexAgentsMdSource,
      INSTRUCTION_SOURCES.geminiDiscoverySource,
      INSTRUCTION_SOURCES.claudeEncodingUndocumented,
    ],
    since: RULESET_VERSION,
    fix: {
      classes: ['safe'],
      summary:
        'Converts a UTF-16 file that decodes without errors to UTF-8 without a byte order mark, keeping its text and line endings. Invalid UTF-8 is left to you.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const { encoding, hadDecodeErrors, text } = artifact.decoded;
      if (encoding === 'utf-8' && !hadDecodeErrors) continue;
      const readers = targetedReaders(context, artifact);
      if (readers.length === 0) continue;
      const verified = readers.filter((platform) =>
        (VERIFIED_UTF8_READERS[artifact.kind] ?? []).includes(platform),
      );

      if (encoding !== 'utf-8') {
        const repair = utf16Repair(artifact);
        context.report(
          verified.length > 0
            ? {
                artifact,
                platforms: verified,
                message: `This file is encoded as ${encodingName(artifact)}. ${platformsDo(verified, ['reads', 'read'], 'it as UTF-8') ?? ''}, so the text arrives garbled, with NUL characters between the letters.`,
                ...repair,
              }
            : {
                artifact,
                platforms: readers,
                severity: 'info',
                message: `This file is encoded as ${encodingName(artifact)}. ${platformsDo(readers, ['does', 'do'], 'not document UTF-16 support') ?? ''}; save it as UTF-8.`,
                ...repair,
              },
        );
        continue;
      }

      const offset = text.indexOf('�');
      const span = offset === -1 ? undefined : { offset, length: 1 };
      const where =
        offset === -1
          ? ''
          : ` (first invalid byte on line ${formatInteger(positionAt(artifact.decoded, offset).line)})`;
      context.report(
        verified.length > 0
          ? {
              artifact,
              platforms: verified,
              severity: 'warn',
              ...(span ? { span } : {}),
              message: `This file is not valid UTF-8${where}. ${platformsDo(verified, ['replaces', 'replace'], 'the invalid bytes with U+FFFD replacement characters') ?? ''}, so the original characters are lost.`,
              guidance: INVALID_UTF8_GUIDANCE,
            }
          : {
              artifact,
              platforms: readers,
              severity: 'info',
              ...(span ? { span } : {}),
              message: `This file is not valid UTF-8${where}. Save it as UTF-8 so agents read every character as written.`,
              guidance: INVALID_UTF8_GUIDANCE,
            },
      );
    }
  },
});
