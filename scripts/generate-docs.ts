/**
 * Generates docs/rules/<family>/<name>.md for every rule, docs/rules/README.md (the catalog),
 * the table of rules with fixes in docs/fix.md (between the FIXABLE_START and FIXABLE_END
 * markers; the rest of that page is written by hand), and schemas/config.schema.json, from rule
 * metadata. Run with `pnpm docs:generate`. CI runs it with `--check` and fails if the committed
 * files are stale.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { CONFIG_JSON_SCHEMA } from '../src/core/config.js';
import { DIRECTIVE_RULES } from '../src/core/directive-rules.js';
import { CONFIG_FILE_NAME, RULESET_VERSION } from '../src/core/meta.js';
import type { RuleMeta } from '../src/core/types.js';
import { builtinRules } from '../src/rules/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const PLATFORM_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  gemini: 'Gemini CLI',
  windsurf: 'Windsurf',
  cline: 'Cline',
};

/** The "Fixable" row: the classes of fix the rule can attach, from `meta.fix`. */
function fixable(meta: RuleMeta): string {
  const classes = meta.fix?.classes ?? [];
  if (classes.length === 0) return 'No';
  return `Yes, ${classes.map((name) => `\`${name}\``).join(' or ')}`;
}

/**
 * Metadata text as Markdown: a backslash outside a code span is escaped, so that it shows, and
 * in a table cell so is every `|`, which would end the cell even in a code span.
 */
function markdownText(text: string, cell = false): string {
  let out = '';
  let code = false;
  for (const char of text) {
    if (char === '`') code = !code;
    if (char === '\\' && !code) out += '\\\\';
    else if (char === '|' && cell) out += '\\|';
    else out += char;
  }
  return out;
}

/** The classes of a rule's fixes, as code: `` `safe`, `review` ``. */
function fixClasses(fix: NonNullable<RuleMeta['fix']>): string {
  return fix.classes.map((name) => `\`${name}\``).join(', ');
}

/** Where docs/fix.md explains the classes, from a rule page. */
const FIX_CLASSES_LINK = '../../fix.md#safe-review-and-manual';

/** The "Fix" section of a rule page: the classes and the summary, or that there is no fix. */
function fixSection(meta: RuleMeta): string {
  if (meta.fix === undefined) {
    return `Guidance only. This rule has no automatic fix. Where the rule can name a step, its finding says what to change ([fix classes](${FIX_CLASSES_LINK})).`;
  }
  return `Classes: ${fixClasses(meta.fix)} ([fix classes](${FIX_CLASSES_LINK})).

${markdownText(meta.fix.summary)}

Preview the fix with \`agentcheckup fix --rule ${meta.id}\`.`;
}

function rulePage(meta: RuleMeta): string {
  const sources = meta.sources
    .map(
      (source) => `- [${source.title}](${source.url}), ${source.status}, checked ${source.checked}`,
    )
    .join('\n');
  const fix = fixable(meta);
  return `<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# \`${meta.id}\`

${meta.title}.

| | |
| --- | --- |
| Severity | \`${meta.severity}\` |
| Category | \`${meta.category}\` |
| Platforms | ${meta.platforms.map((id) => PLATFORM_NAMES[id] ?? id).join(', ')} |
| Applies to | ${meta.appliesTo.map((kind) => `\`${kind}\``).join(', ')} |
| Fixable | ${fix} |
| Since | ${meta.since} |

## Why

${meta.rationale}

## Evidence

${sources}

## Fix

${fixSection(meta)}

## Configuration

\`\`\`json
{
  "rules": {
    "${meta.id}": "off"
  }
}
\`\`\`

Set the rule to \`"off"\`, \`"info"\`, \`"warn"\` or \`"error"\` in \`${CONFIG_FILE_NAME}\`, or
suppress one occurrence with a reason:

\`\`\`markdown
<!-- agentcheckup-disable-next-line ${meta.id} -- reason -->
\`\`\`
`;
}

/** The "Fix" column of the catalog: the classes of the rule's fixes, or `manual`. */
function fixColumn(meta: RuleMeta): string {
  return meta.fix === undefined ? 'manual' : meta.fix.classes.join(', ');
}

function catalog(rules: readonly RuleMeta[]): string {
  const rows = rules
    .map(
      (meta) =>
        `| [\`${meta.id}\`](${meta.id}.md) | ${meta.severity} | ${meta.category} | ${fixColumn(meta)} | ${meta.title} |`,
    )
    .join('\n');
  return `<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# Rules

Rule set \`${RULESET_VERSION}\`: ${rules.length} rules.

Severity policy: \`error\` means a documented platform behavior skips, ignores, truncates or
breaks the file. \`warn\` means degraded behavior or a portability problem. \`info\` is advice
and never affects the score. See [ADR 0004](../adr/0004-evidence-backed-rules.md).

The Fix column gives the classes of fix a rule can attach for \`agentcheckup fix\`. \`manual\`
means guidance only, with no automatic fix. See [Fixing findings](../fix.md#safe-review-and-manual).

| Rule | Severity | Category | Fix | Problem |
| --- | --- | --- | --- | --- |
${rows}
`;
}

/** The markers around the generated part of docs/fix.md. */
const FIXABLE_START =
  '<!-- Start of the fixable rules, generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->';
const FIXABLE_END = '<!-- End of the fixable rules. -->';

/** The generated part of docs/fix.md: how many rules have fixes, and a row for each. */
function fixableRules(rules: readonly RuleMeta[]): string {
  const rows = rules.flatMap((meta) =>
    meta.fix === undefined
      ? []
      : [
          `| [\`${meta.id}\`](rules/${meta.id}.md) | ${fixClasses(meta.fix)} | ${markdownText(meta.fix.summary, true)} |`,
        ],
  );
  return `${rows.length} of the ${rules.length} rules can attach a fix. The others give a manual step where they can name one.

| Rule | Classes | What the fix does |
| --- | --- | --- |
${rows.join('\n')}`;
}

/** `page` with the text between the fixable-rules markers replaced by `generated`. */
function withFixableRules(page: string, generated: string): string {
  const start = page.indexOf(FIXABLE_START);
  const end = page.indexOf(FIXABLE_END);
  if (start === -1 || end < start) {
    throw new Error(`docs/fix.md must contain ${FIXABLE_START} and then ${FIXABLE_END}.`);
  }
  return `${page.slice(0, start + FIXABLE_START.length)}\n\n${generated}\n\n${page.slice(end)}`;
}

const outputs = new Map<string, string>();
const rules = [...builtinRules.map((rule) => rule.meta), ...DIRECTIVE_RULES].sort((a, b) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
);
for (const meta of rules) outputs.set(join('docs', 'rules', `${meta.id}.md`), rulePage(meta));
outputs.set(join('docs', 'rules', 'README.md'), catalog(rules));
outputs.set(
  join('docs', 'fix.md'),
  withFixableRules(await readFile(join(root, 'docs', 'fix.md'), 'utf8'), fixableRules(rules)),
);
outputs.set(
  join('schemas', 'config.schema.json'),
  `${JSON.stringify(
    {
      $id: 'https://raw.githubusercontent.com/mustafakbaser/agentcheckup/main/schemas/config.schema.json',
      title: 'agentcheckup configuration',
      ...CONFIG_JSON_SCHEMA,
    },
    null,
    2,
  )}\n`,
);

let stale = 0;
for (const [relative, raw] of outputs) {
  const target = join(root, relative);
  // Format exactly as `pnpm format` would, so --check compares like with like.
  const options = await prettier.resolveConfig(target);
  const content = await prettier.format(raw, { ...options, filepath: target });
  if (check) {
    const current = await readFile(target, 'utf8').catch(() => undefined);
    if (current !== content) {
      stale++;
      process.stderr.write(`stale: ${relative}\n`);
    }
    continue;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

if (check && stale > 0) {
  process.stderr.write(`\n${stale} generated file(s) are out of date. Run: pnpm docs:generate\n`);
  process.exitCode = 1;
}
