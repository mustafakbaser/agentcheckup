/**
 * Identity and versioning constants.
 *
 * The tool name appears in config file names, inline directives, SARIF output and docs URLs.
 * Everything that depends on the name reads it from here, so a rename touches one file.
 */
export const TOOL_NAME = 'agentcheckup';
export const REPOSITORY_URL = 'https://github.com/mustafakbaser/agentcheckup';
export const CONFIG_FILE_NAME = `${TOOL_NAME}.config.json`;
export const DIRECTIVE_PREFIX = TOOL_NAME;

/**
 * Calendar-versioned rule set. A released rule set is immutable: within one version, rules
 * may only get false-positive fixes, so a repository's score never drops without a version bump.
 */
export const RULESET_VERSION = '2026.10';

/** Version of the scoring formula documented in docs/scoring.md. */
export const SCORE_FORMULA_VERSION = 1;

/** Version of the JSON report shape published in schemas/report.schema.json. */
export const REPORT_SCHEMA_VERSION = 1;

/**
 * Version of the finding fingerprint scheme (src/core/fingerprint.ts), written to every report
 * as `fingerprintVersion`. `--baseline` matches findings by fingerprint, so it refuses a
 * baseline with another version: every finding would look new. Reports without the field have
 * version 1, which hashed the text of the finding's line in JSON files too.
 */
export const FINGERPRINT_VERSION = 2;

export function ruleDocsUrl(ruleId: string): string {
  return `${REPOSITORY_URL}/blob/main/docs/rules/${ruleId}.md`;
}
