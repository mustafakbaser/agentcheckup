/**
 * What the report formats share about a `--policy` check: check titles, counts, the order and
 * status of violations, and the sentence every missing hook carries.
 *
 * Violations are not findings. Every format lists them on their own, never among the findings,
 * and they never change the score. Their messages and the policy name are raw text from the
 * repository or the policy file, on one line and bounded in length: each channel sanitizes them
 * where it writes them. Messages carry no `path:line`; the formats add it from `path` and `line`.
 */
import { REPOSITORY_URL } from '../core/meta.js';
import { HOOKS_NOT_ENFORCED } from '../policy/evaluate.js';
import {
  POLICY_CHECKS,
  type PolicyCheck,
  type PolicyReport,
  type PolicyViolation,
} from '../policy/types.js';
import { plural } from './text.js';

/** Where docs/policy.md is published; each check has a section with its id as the anchor. */
export const POLICY_DOCS_URL = `${REPOSITORY_URL}/blob/main/docs/policy.md`;

/** Short names, for titles and table cells. */
export const CHECK_TITLES: Readonly<Record<PolicyCheck, string>> = {
  'mcp-not-allowed': 'MCP server not allowed',
  'mcp-unpinned': 'MCP server not pinned',
  'forbidden-setting': 'Forbidden setting',
  'denied-tool': 'Denied tool or command',
  'hook-missing': 'Required hook missing',
  'startup-budget': 'Startup context over budget',
  'subagent-budget': 'Subagent call over budget',
  'model-not-allowed': 'Model not allowed',
  'unanalyzed-config': 'Configuration not analyzed',
};

/** One sentence per check, for SARIF rule descriptions. */
export const CHECK_DESCRIPTIONS: Readonly<Record<PolicyCheck, string>> = {
  'mcp-not-allowed': 'An MCP server runs a package, image or origin that mcp.allow does not list.',
  'mcp-unpinned':
    'An MCP server runs a package without an exact version or digest, and mcp.requirePin is on.',
  'forbidden-setting': 'A setting the policy lists in forbid is configured.',
  'denied-tool':
    'A grant lets an agent use a tool or run a command without asking that the policy denies.',
  'hook-missing':
    'A hook the policy requires is not configured. Configured, not enforced: hooks fail open on errors and timeouts, and user settings can turn them off.',
  'startup-budget':
    "An agent's largest load plan holds more startup tokens than the policy's budget for it.",
  'subagent-budget':
    "A subagent call starts with more tokens, in a context window of its own, than the policy's budget for the agent's subagents, or with what agentcheckup cannot measure. The policy fails closed.",
  'model-not-allowed':
    'An agent definition or a model setting names a model the policy does not allow for the agent, or one whose model cannot be read under an allowlist.',
  'unanalyzed-config':
    'A configuration file could not be analyzed, so it may hide a violation. The policy fails closed.',
};

/** True for a check this version knows, so its id can be written as trusted text. */
export function isPolicyCheck(value: string): value is PolicyCheck {
  return (POLICY_CHECKS as readonly string[]).includes(value);
}

/** The documentation of a check. */
export function checkDocsUrl(check: PolicyCheck): string {
  return `${POLICY_DOCS_URL}#${check}`;
}

/** The first 12 hex digits of the policy file's SHA-256, enough to tell two policies apart. */
export function shortSha(sha256: string): string {
  return sha256.slice(0, 12);
}

export interface PolicyCounts {
  readonly total: number;
  /** Violations that fail the run. */
  readonly failing: number;
  /** With a baseline: violations the baseline did not have. */
  readonly new: number;
  /** With a baseline: violations the baseline had too. */
  readonly unchanged: number;
  /** True when the run compared with a baseline. */
  readonly compared: boolean;
}

export function policyCounts(report: PolicyReport): PolicyCounts {
  const { violations } = report;
  return {
    total: violations.length,
    failing: violations.filter((violation) => violation.fails).length,
    new: violations.filter((violation) => violation.baseline === 'new').length,
    unchanged: violations.filter((violation) => violation.baseline === 'unchanged').length,
    compared: violations.some((violation) => violation.baseline !== undefined),
  };
}

/** Failing violations first, each group in report order (check, path, line, id). */
export function rankedViolations(report: PolicyReport): PolicyViolation[] {
  return [
    ...report.violations.filter((violation) => violation.fails),
    ...report.violations.filter((violation) => !violation.fails),
  ];
}

/** `path:line`, `path`, or undefined for a violation of the whole repository. Raw text. */
export function violationLocation(violation: PolicyViolation): string | undefined {
  if (violation.path === undefined) return undefined;
  return violation.line === undefined ? violation.path : `${violation.path}:${violation.line}`;
}

/**
 * A message split into what may be cut and the closing sentence every hook-missing message
 * shares ("Configured, not enforced: …"). Formats that cut long messages cut `text` only and
 * always show `hookNote`, so no line about a required hook loses it.
 */
export function splitHookNote(message: string): {
  readonly text: string;
  readonly hookNote?: string;
} {
  const suffix = ` ${HOOKS_NOT_ENFORCED}`;
  return message.endsWith(suffix)
    ? { text: message.slice(0, -suffix.length), hookNote: HOOKS_NOT_ENFORCED }
    : { text: message };
}

/**
 * The headline of a policy section, trusted text: `No violations`, `1 violation fails the run`,
 * `2 of 3 violations fail the run`, `3 violations, none fails the run`.
 */
export function violationsHeadline(counts: PolicyCounts): string {
  const { total, failing } = counts;
  if (total === 0) return 'No violations';
  if (failing === 0) return `${plural(total, 'violation')}, none fails the run`;
  const verb = failing === 1 ? 'fails' : 'fail';
  if (failing === total) return `${plural(total, 'violation')} ${verb} the run`;
  return `${failing} of ${plural(total, 'violation')} ${verb} the run`;
}

/** `2 new, 1 unchanged since the baseline`, or undefined without a baseline or violations. */
export function baselineBreakdown(counts: PolicyCounts): string | undefined {
  if (!counts.compared || counts.total === 0) return undefined;
  return `${counts.new} new, ${counts.unchanged} unchanged since the baseline`;
}
