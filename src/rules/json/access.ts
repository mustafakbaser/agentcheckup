/**
 * Helpers for rules over values from `context.json()`. The generic accessors live in
 * src/parse/json-access.ts and are re-exported here.
 */
import type { ReportDescriptor, Span } from '../../core/types.js';
import type { JsonPath } from '../../parse/json-access.js';
import { formatInteger, quote } from '../shared/format.js';

export { projectRootOf } from '../../platforms/paths.js';

export {
  collectStrings,
  isObject,
  keySpanOf,
  MAX_DEPTH,
  MAX_STRINGS,
  own,
  ownObject,
  spanOf,
} from '../../parse/json-access.js';
export type { JsonObject, JsonPath, ParsedJson, StringValue } from '../../parse/json-access.js';

const IDENTIFIER = /^[a-z_$][\w$-]*$/i;

/** `['mcpServers', 'my server', 'args', 0]` -> `mcpServers["my server"].args[0]`. */
export function pathLabel(path: JsonPath): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${String(segment)}]`;
    else if (IDENTIFIER.test(segment) && segment.length <= 60)
      out += out === '' ? segment : `.${segment}`;
    else out += `[${quote(segment)}]`;
  }
  return out;
}

/** `{ span }` when known, `{}` otherwise (the finding then points at the whole file). */
export function at(span: Span | undefined): { readonly span?: Span } {
  return span === undefined ? {} : { span };
}

/** Findings one rule reports per file before the rest are summarized in one finding. */
export const MAX_FINDINGS_PER_FILE = 100;

/**
 * Reports at most {@link MAX_FINDINGS_PER_FILE} findings for one file, then one summary finding
 * at the first omitted location. A hostile file can hold thousands of entries; past this count
 * more findings add nothing for the reader and cost report time. Call `finish()` after the file.
 */
export class FileFindings {
  readonly #report: (descriptor: ReportDescriptor) => void;
  readonly #what: string;
  #count = 0;
  #omitted = 0;
  #first: ReportDescriptor | undefined;

  /** `what` names the omitted findings in the plural, e.g. "hooks with a missing script". */
  constructor(report: (descriptor: ReportDescriptor) => void, what: string) {
    this.#report = report;
    this.#what = what;
  }

  /**
   * True while the next finding is listed with its fix. Past the cap a finding only counts toward
   * the summary, which has no fix, so build a fix only when this is true: each JSON fix parses
   * the whole file again to check itself, and a hostile file holds thousands of entries.
   */
  get listsNext(): boolean {
    return this.#count < MAX_FINDINGS_PER_FILE;
  }

  report(descriptor: ReportDescriptor): void {
    if (this.#count < MAX_FINDINGS_PER_FILE) {
      this.#count++;
      this.#report(descriptor);
      return;
    }
    this.#omitted++;
    this.#first ??= descriptor;
  }

  finish(): void {
    const first = this.#first;
    if (first === undefined) return;
    // The summary stands for many findings, so the first omitted one's fix and manual step
    // would resolve only part of it.
    const { fix: _fix, guidance: _guidance, ...rest } = first;
    this.#report({
      ...rest,
      message: `Only the first ${formatInteger(MAX_FINDINGS_PER_FILE)} ${this.#what} in this file are listed; ${formatInteger(this.#omitted)} more from here on ${this.#omitted === 1 ? 'is' : 'are'} not.`,
    });
  }
}
