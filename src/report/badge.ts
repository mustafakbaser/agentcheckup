/**
 * Score badge for READMEs: a static shields.io badge, so no service needs repository access.
 * https://shields.io/badges/static-badge
 */
import type { ScanResult } from '../core/engine.js';
import { REPOSITORY_URL } from '../core/meta.js';
import type { Grade } from '../core/score.js';

const LABEL = 'agent config';

const GRADE_COLORS: Readonly<Record<Grade, string>> = {
  A: 'brightgreen',
  B: 'green',
  C: 'yellow',
  D: 'orange',
  F: 'red',
};
const NO_SCORE_COLOR = 'lightgrey';

/**
 * One path segment of a static badge URL. Shields reads `-` as the field separator and `_` as a
 * space, so literal ones are doubled (`--`, `__`), spaces become `_`, and the rest is
 * percent-encoded (`92/100` -> `92%2F100`).
 */
export function shieldsSegment(text: string): string {
  return encodeURIComponent(text.replaceAll('-', '--').replaceAll('_', '__').replaceAll(' ', '_'));
}

function badgeMessage(result: ScanResult): string {
  return result.score.score === null ? 'no config' : `${result.score.score}/100`;
}

/** `https://img.shields.io/badge/agent_config-92%2F100-brightgreen`. */
export function badgeUrl(result: ScanResult): string {
  const { grade } = result.score;
  const color =
    result.score.score === null || grade === null ? NO_SCORE_COLOR : GRADE_COLORS[grade];
  return `https://img.shields.io/badge/${shieldsSegment(LABEL)}-${shieldsSegment(badgeMessage(result))}-${color}`;
}

/** Percent-encodes the characters that would end or break a Markdown link destination. */
function linkDestination(url: string): string {
  return url.replace(
    /[\s()<>]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** `[![agent config: 92/100](badge)](link)`, linking to agentcheck unless told otherwise. */
export function badgeMarkdown(result: ScanResult, linkUrl: string = REPOSITORY_URL): string {
  return `[![${LABEL}: ${badgeMessage(result)}](${badgeUrl(result)})](${linkDestination(linkUrl)})`;
}
