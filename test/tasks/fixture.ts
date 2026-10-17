/**
 * Repositories for the `agentcheckup tasks` tests, as file maps: scanned in memory by the model
 * and formatter tests, written to a temporary directory by the CLI tests.
 */
import { analyze, runRules, type ScanOptions } from '../../src/core/engine.js';
import { allRuleMeta } from '../../src/cli/common.js';
import { builtinRules } from '../../src/rules/index.js';
import type { TaskScan } from '../../src/tasks/index.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';
import { GITHUB_TOKEN } from '../report/fix-fixtures.js';

export { GITHUB_TOKEN };

/** A skill body of `count` numbered lines under two headings. */
function longBody(count: number): string {
  const lines = ['# Guide', '', 'Read this first.', '', '## Setup', ''];
  for (let i = 1; i <= 120; i++) lines.push(`Setup step ${i}.`);
  lines.push('', '## API reference', '');
  for (let i = 1; lines.length < count; i++) lines.push(`Endpoint ${i} returns JSON.`);
  lines.push('', '### Errors', '', 'Errors are JSON too.');
  return `${lines.join('\n')}\n`;
}

/**
 * A small repository with one finding of each kind of handling:
 * - tasks: an unresolved import (error), a broad `allowed-tools` (warning), two broken links in
 *   one skill (one task), a description without "Use when" (info), a long skill body (info), a
 *   Cursor rule that never applies (info), a vague directive (info);
 * - step 0: AGENTS.md that Claude Code skips, which has a safe fix;
 * - for you: a literal credential in .mcp.json.
 */
export const SAMPLE_REPO: Readonly<Record<string, string>> = {
  'AGENTS.md': '# Project\n\nWrite clean code.\n\nRun `pnpm test` before you commit.\n',
  'CLAUDE.md': '# Claude\n\n@docs/missing-setup.md\n',
  '.claude/skills/deploy/SKILL.md': [
    '---',
    'name: deploy',
    'description: Deploys the API to staging and production with a blue-green rollout.',
    'allowed-tools: Bash Read',
    '---',
    '# Deploy',
    '',
    'Run `pnpm deploy` and check the dashboard.',
    '',
    'See [the runbook](runbook.md) and [the rollback steps](rollback.md).',
    '',
  ].join('\n'),
  '.claude/skills/guide/SKILL.md': `---\nname: guide\ndescription: Explains the API of the service. Use when the user asks how to call the API.\n---\n${longBody(560)}`,
  '.cursor/rules/manual.mdc': 'Use tabs for indentation in Go files.\n',
  '.mcp.json': `${JSON.stringify(
    {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github@1.0.0'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN },
        },
      },
    },
    null,
    2,
  )}\n`,
};

export const SCAN_OPTIONS: ScanOptions = { rules: builtinRules };

/** A scan of `files` in memory, as `agentcheckup tasks` scans a directory. */
export function scanOf(files: FileMap, options: Partial<ScanOptions> = {}): TaskScan {
  const scanOptions = { ...SCAN_OPTIONS, ...options };
  const analysis = analyze(snapshotFrom(files), scanOptions);
  const result = runRules(analysis, scanOptions);
  if (result.ruleFailures.length > 0) {
    throw new Error(`A rule crashed: ${JSON.stringify(result.ruleFailures)}`);
  }
  return { findings: result.findings, rules: allRuleMeta(), analysis };
}

/** The code points of `text` that are control, bidirectional or tag characters. */
export function hiddenCharacters(text: string): number[] {
  const found: number[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    const control = (cp < 0x20 && cp !== 0x0a && cp !== 0x09) || (cp >= 0x7f && cp <= 0x9f);
    const bidi = (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
    const zeroWidth = cp >= 0x200b && cp <= 0x200f;
    const tag = cp >= 0xe0000 && cp <= 0xe007f;
    if (control || bidi || zeroWidth || tag) found.push(cp);
  }
  return found;
}

/**
 * The lines of a Markdown prompt outside `~~~~untrusted` blocks. Throws when a block is not
 * closed, so a test cannot pass on a prompt whose fence a value broke.
 */
export function linesOutsideUntrusted(markdown: string): string[] {
  const outside: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    if (fence === undefined) {
      if (line.startsWith('~~~~') && line.endsWith('untrusted')) {
        fence = line.slice(0, line.length - 'untrusted'.length);
        if (fence.replaceAll('~', '') !== '') throw new Error(`Bad fence: ${line}`);
      } else {
        outside.push(line);
      }
    } else if (line === fence) {
      fence = undefined;
    } else if (
      line.startsWith('~') &&
      line.replaceAll('~', '').trim() === '' &&
      line.length >= fence.length
    ) {
      throw new Error(`A line inside an untrusted block could close it: ${line}`);
    }
  }
  if (fence !== undefined) throw new Error('An untrusted block is not closed.');
  return outside;
}
