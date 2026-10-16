/**
 * Report formats. Every formatter is pure: `(result, options) => string`. The CLI writes the
 * string and decides about color.
 */
import type { ScanResult } from '../core/engine.js';
import type { DetailLevel } from './feedback.js';
import { formatGithub } from './github.js';
import { formatJson } from './json.js';
import { formatMarkdown } from './markdown.js';
import { formatSarif } from './sarif.js';
import { formatStylish, plainStyle, type Style } from './stylish.js';

export { badgeMarkdown, badgeUrl } from './badge.js';
export {
  type ContextMarkdownOptions,
  formatContextMarkdown,
  formatMatrixMarkdown,
} from './context-markdown.js';
export { type ContextTextOptions, formatContextText, formatMatrixText } from './context-text.js';
export { DETAIL_LEVELS, type DetailLevel, isDetailLevel } from './feedback.js';
export { formatGithub, type GithubOptions } from './github.js';
export {
  formatJson,
  toJsonBaseline,
  toJsonContext,
  toJsonFix,
  toJsonInventory,
  toJsonReport,
} from './json.js';
export { formatMarkdown, type MarkdownOptions } from './markdown.js';
export {
  forJsonOutput,
  forMarkdown,
  forSarifMessage,
  forSarifText,
  forTerminal,
  forWorkflowCommand,
  forWorkflowProperty,
  guardWorkflowCommands,
} from './sanitize.js';
export {
  formatSarif,
  MAX_RESULTS as MAX_SARIF_RESULTS,
  type SarifLog,
  toSarif,
  toSarifFix,
} from './sarif.js';
export {
  formatStylish,
  type Paint,
  plainStyle,
  type Style,
  type StylishOptions,
} from './stylish.js';

/** Output format names, as accepted by `--format`. */
export const FORMATS = ['stylish', 'json', 'sarif', 'github', 'markdown'] as const;
export type FormatName = (typeof FORMATS)[number];

/** One-line descriptions for `--help`. */
export const FORMAT_DESCRIPTIONS: Readonly<Record<FormatName, string>> = {
  stylish: 'Human-readable terminal output (default)',
  json: 'Full report as JSON (schemas/report.schema.json)',
  sarif: 'SARIF 2.1.0 for GitHub code scanning',
  github: 'GitHub Actions annotations (workflow commands)',
  markdown: 'Markdown for job summaries and PR comments',
};

export function isFormatName(value: string): value is FormatName {
  return (FORMATS as readonly string[]).includes(value);
}

/** Options for {@link format}. Each format reads the ones that apply to it. */
export interface FormatOptions {
  /** stylish: color functions. Default {@link plainStyle}. */
  readonly style?: Style | undefined;
  /** stylish: ASCII-only decorations. */
  readonly ascii?: boolean | undefined;
  /** stylish: list suppressed findings too. */
  readonly showSuppressed?: boolean | undefined;
  /** stylish: findings shown per file. */
  readonly maxPerFile?: number | undefined;
  /**
   * stylish, markdown, github: how much to show (`--compact`, default, `--verbose`). Default
   * `default`. JSON and SARIF are data and ignore it.
   */
  readonly level?: DetailLevel | undefined;
  /** stylish: rule ids as OSC 8 hyperlinks. Only for ANSI output to a TTY: the caller decides. */
  readonly hyperlinks?: boolean | undefined;
  /** markdown: rows in the findings table. Default 50. */
  readonly maxFindings?: number | undefined;
}

/** Formats `result` as `name`. */
export function format(result: ScanResult, name: FormatName, options: FormatOptions = {}): string {
  switch (name) {
    case 'stylish':
      return formatStylish(result, {
        style: options.style ?? plainStyle,
        ascii: options.ascii,
        showSuppressed: options.showSuppressed,
        maxPerFile: options.maxPerFile,
        level: options.level,
        hyperlinks: options.hyperlinks,
      });
    case 'json':
      return formatJson(result);
    case 'sarif':
      return formatSarif(result);
    case 'github':
      return formatGithub(result, { level: options.level });
    case 'markdown':
      return formatMarkdown(result, { maxFindings: options.maxFindings, level: options.level });
  }
}
