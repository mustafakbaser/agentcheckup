/**
 * Generates docs/rules/<family>/<name>.md for every rule, docs/rules/README.md (the catalog),
 * and schemas/config.schema.json, from rule metadata. Run with `pnpm docs:generate`.
 * CI runs it with `--check` and fails if the committed files are stale.
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

function catalog(rules: readonly RuleMeta[]): string {
  const rows = rules
    .map(
      (meta) =>
        `| [\`${meta.id}\`](${meta.id}.md) | ${meta.severity} | ${meta.category} | ${meta.title} |`,
    )
    .join('\n');
  return `<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# Rules

Rule set \`${RULESET_VERSION}\`: ${rules.length} rules.

Severity policy: \`error\` means a documented platform behavior skips, ignores, truncates or
breaks the file. \`warn\` means degraded behavior or a portability problem. \`info\` is advice
and never affects the score. See [ADR 0004](../adr/0004-evidence-backed-rules.md).

| Rule | Severity | Category | Problem |
| --- | --- | --- | --- |
${rows}
`;
}

const outputs = new Map<string, string>();
const rules = [...builtinRules.map((rule) => rule.meta), ...DIRECTIVE_RULES].sort((a, b) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
);
for (const meta of rules) outputs.set(join('docs', 'rules', `${meta.id}.md`), rulePage(meta));
outputs.set(join('docs', 'rules', 'README.md'), catalog(rules));
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
