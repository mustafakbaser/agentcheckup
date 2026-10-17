/**
 * Findings that are never handed to an agent ("For you"): the user decides about them.
 *
 * - mcp/literal-secret: the credential must be revoked and rotated, which no edit does.
 * - risk/hidden-unicode and risk/hidden-comment: the hidden content is the payload; a prompt that
 *   asks an agent to work on it would feed the payload to the agent.
 * - Anything that changes what agents may run, reach or approve: the rule families `mcp`,
 *   `hooks`, `settings` and `risk`, skill/shell-preprocessing, and every finding in a JSON file
 *   (Claude Code and Gemini CLI settings, MCP configuration, hook files, plugin manifests), which
 *   is where permissions, MCP servers, hooks and env overrides live.
 */
import type { ArtifactKind } from '../core/types.js';
import { JSON_KINDS } from '../platforms/kinds.js';
import type { ForYouReason } from './types.js';

export const CREDENTIAL_RULE = 'mcp/literal-secret';

/** Rules whose finding is about hidden text. */
const HIDDEN_CONTENT_RULES: ReadonlySet<string> = new Set([
  'risk/hidden-unicode',
  'risk/hidden-comment',
]);

/** Rule families left to the user. */
export const FOR_YOU_FAMILIES: readonly string[] = ['hooks', 'mcp', 'risk', 'settings'];

/** Rules outside those families that are left to the user. */
export const FOR_YOU_RULES: readonly string[] = ['skill/shell-preprocessing'];

const FAMILIES: ReadonlySet<string> = new Set(FOR_YOU_FAMILIES);
const RULES: ReadonlySet<string> = new Set(FOR_YOU_RULES);

/**
 * Why a finding of `ruleId` in a file of `kind` is left to the user, or undefined. A file of
 * unknown kind is left to the user too: what it configures cannot be told.
 */
export function forYouReason(
  ruleId: string,
  kind: ArtifactKind | undefined,
): ForYouReason | undefined {
  if (ruleId === CREDENTIAL_RULE) return 'credential';
  if (HIDDEN_CONTENT_RULES.has(ruleId)) return 'hidden-content';
  const slash = ruleId.indexOf('/');
  const family = slash < 0 ? ruleId : ruleId.slice(0, slash);
  if (FAMILIES.has(family) || RULES.has(ruleId)) return 'security';
  if (kind === undefined || JSON_KINDS.has(kind)) return 'security';
  return undefined;
}
