/**
 * SARIF for a `--policy` check. Each violation with a file becomes a result with `ruleId`
 * `policy/<check>` and `properties.policy: true`, an error when it fails the run and a warning
 * otherwise; each check that has violations gets a rule descriptor of the same id.
 *
 * GitHub code scanning needs a file for every result and rejects an upload with a result that
 * has none. A violation of the whole repository (a missing hook, a startup budget) therefore
 * becomes a tool execution notification linked to its `policy/<check>` rule instead.
 */
import type { ScanResult } from '../core/engine.js';
import { POLICY_CHECKS, type PolicyCheck, type PolicyViolation } from '../policy/types.js';
import { CHECK_DESCRIPTIONS, CHECK_TITLES, checkDocsUrl, isPolicyCheck } from './policy-common.js';
import { forSarifMessage } from './sanitize.js';
import {
  pathToUri,
  ruleName,
  type SarifNotification,
  type SarifResult,
  type SarifRule,
} from './sarif.js';

/** `partialFingerprints` key for violation ids. Versioned like the findings' key. */
export const POLICY_FINGERPRINT_KEY = 'agentcheckup-policy/v1';

export interface PolicySarif {
  readonly rules: readonly SarifRule[];
  readonly results: readonly SarifResult[];
  readonly notifications: readonly SarifNotification[];
}

const EMPTY: PolicySarif = { rules: [], results: [], notifications: [] };

function describeCheck(check: PolicyCheck): SarifRule {
  const id = `policy/${check}`;
  const url = checkDocsUrl(check);
  const title = CHECK_TITLES[check];
  const description = CHECK_DESCRIPTIONS[check];
  return {
    id,
    name: ruleName(id),
    shortDescription: { text: title },
    fullDescription: { text: description },
    helpUri: url,
    help: {
      text: `${description}\n\nDocumentation: ${url}`,
      markdown: `**${title}**\n\n${description}\n\n[Policy documentation](${url})`,
    },
    defaultConfiguration: { level: 'error' },
    properties: { tags: ['policy'] },
  };
}

function messageOf(violation: PolicyViolation, ruleId: string): { readonly text: string } {
  const text = forSarifMessage(violation.message);
  return { text: text.trim() === '' ? ruleId : text };
}

/**
 * Rules, results and notifications for the policy, or nothing without one. Rule indexes start
 * at `firstRuleIndex`: the policy's rules follow the scan's in the driver.
 */
export function policySarif(result: ScanResult, firstRuleIndex: number): PolicySarif {
  const report = result.policy;
  if (report === undefined) return EMPTY;
  const checks = POLICY_CHECKS.filter((check) =>
    report.violations.some((violation) => violation.check === check),
  );
  const index = new Map(checks.map((check, position) => [check, firstRuleIndex + position]));
  const results: SarifResult[] = [];
  const notifications: SarifNotification[] = [];
  for (const violation of report.violations) {
    if (!isPolicyCheck(violation.check)) continue;
    const ruleId = `policy/${violation.check}`;
    const ruleIndex = index.get(violation.check) ?? firstRuleIndex;
    const level = violation.fails ? 'error' : 'warning';
    if (violation.path === undefined) {
      notifications.push({
        level,
        message: messageOf(violation, ruleId),
        associatedRule: { id: ruleId, index: ruleIndex },
      });
      continue;
    }
    results.push({
      ruleId,
      ruleIndex,
      level,
      message: messageOf(violation, ruleId),
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: pathToUri(violation.path), uriBaseId: '%SRCROOT%' },
            ...(violation.line === undefined
              ? {}
              : { region: { startLine: Math.max(1, violation.line) } }),
          },
        },
      ],
      partialFingerprints: { [POLICY_FINGERPRINT_KEY]: violation.id },
      ...(violation.baseline === undefined ? {} : { baselineState: violation.baseline }),
      properties: { policy: true },
    });
  }
  return { rules: checks.map(describeCheck), results, notifications };
}
