import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../../src/core/engine.js';
import { formatBaselineMarkdown } from '../../src/report/baseline-markdown.js';
import { formatBaselineText } from '../../src/report/baseline-text.js';
import { rebaseResult } from '../../src/core/rebase.js';
import { plainStyle } from '../../src/report/stylish.js';
import { ansiStyle } from '../../src/cli/style.js';
import {
  baselineDiff,
  sampleBaseline,
  withContext,
  withHostileContext,
} from '../helpers/context.js';
import { hostileResult } from './hostile.js';
import { richResult } from './fixtures.js';
import { unsafeCodePoints } from './safety.js';

const result = withContext(richResult);

describe('formatBaselineText', () => {
  it('is empty without a baseline', () => {
    expect(formatBaselineText(richResult)).toBe('');
    expect(formatBaselineMarkdown(richResult)).toBe('');
  });

  it('lists gate hits, finding counts and the change in session-start context', () => {
    expect(formatBaselineText(result, { style: plainStyle })).toBe(
      [
        'Since the baseline',
        '✖ 5 security-relevant changes need review',
        '    New MCP server, not pinned: stdio, npx -y @acme/browser-mcp, not pinned · .cursor/mcp.json:2',
        '    Permission widened: permissions.allow adds Bash(curl:*) · .claude/settings.json:6',
        '    Hook changed: PreToolUse Bash runs scripts/hooks/guard.sh, command changed · .claude/settings.json:4',
        '    Env override: ANTHROPIC_BASE_URL → https://llm-proxy.example.net · .claude/settings.json:8',
        '    Hidden Unicode: AGENTS.md:12 has 3 invisible Unicode tag characters',
        'Findings: 2 new, 6 unchanged, 2 resolved',
        'Session-start context:',
        '  Claude Code (packages/api) ≈1,977 → ≈2,697 tokens (+720)',
        '  Codex (packages/api) ≈7,801 → ≈8,253 tokens (+452), AGENTS.md chain ' +
          '31,204 → 33,010 bytes, now over the 32,768-byte limit',
        '  Unchanged: Cursor',
        '',
      ].join('\n'),
    );
  });

  it('shows plan directories relative to the scanned directory, as the context output does', () => {
    expect(formatBaselineText(rebaseResult(result, 'sub/dir'))).toBe(formatBaselineText(result));
    expect(formatBaselineMarkdown(rebaseResult(result, 'sub/dir'))).toBe(
      formatBaselineMarkdown(result),
    );
  });

  it('counts the new findings of rules newer than the baseline', () => {
    const newer: ScanResult = {
      ...result,
      baseline: {
        ...sampleBaseline,
        against: {
          version: '0.1.0',
          ruleset: '2026.09',
          sameRuleset: false,
          newRules: ['instructions/broken-import'],
        },
      },
    };
    expect(formatBaselineText(newer)).toContain(
      'Findings: 2 new (1 from new rules), 6 unchanged, 2 resolved\n',
    );
    expect(formatBaselineText(result)).toContain('Findings: 2 new, 6 unchanged, 2 resolved\n');
  });

  it('says when nothing needs review, and says nothing about the gate without one', () => {
    const quiet: ScanResult = {
      ...result,
      baseline: { ...sampleBaseline, gate: { classes: ['hooks'], hits: [] } },
    };
    expect(formatBaselineText(quiet)).toContain('\n✔ No security-relevant changes need review\n');
    expect(formatBaselineText(quiet, { ascii: true })).toContain(
      '\nNo security-relevant changes need review\n',
    );
    const ungated: ScanResult = { ...result, baseline: baselineDiff() };
    expect(formatBaselineText(ungated)).toBe(
      'Since the baseline\nFindings: 0 new, 0 unchanged, 0 resolved\n',
    );
  });

  it('notes a baseline from another ruleset and caps long lists', () => {
    const hits = Array.from({ length: 12 }, (_, index) => ({
      class: 'hooks' as const,
      id: `hook:.claude/settings.json#E${String(index).padStart(2, '0')}`,
      change: 'added' as const,
      summary: `hook ${index}`,
    }));
    const many: ScanResult = {
      ...result,
      baseline: {
        ...sampleBaseline,
        against: { version: '0.0.0', ruleset: '2026.09', sameRuleset: false, newRules: [] },
        context: Array.from({ length: 12 }, () => sampleBaseline.context[2]!),
        gate: { classes: ['hooks'], hits },
      },
    };
    const text = formatBaselineText(many, { ascii: true });
    expect(text).toContain('x 12 security-relevant changes need review\n');
    expect(text).toContain('    ... and 2 more\n');
    expect(text).toContain('\n  and 2 more plans\n');
    expect(text).toContain(
      '! The baseline was written with ruleset 2026.09, so findings from rules it did not run count as new.',
    );
  });

  it('paints with the given style', () => {
    expect(formatBaselineText(result, { style: ansiStyle })).toContain(
      '\u001b[1mSince the baseline',
    );
  });

  it('neutralizes hostile summaries, paths and rulesets', () => {
    const hostile = withHostileContext(hostileResult);
    const text = formatBaselineText({
      ...hostile,
      baseline: {
        ...hostile.baseline!,
        against: { version: 'x', ruleset: '\u001b[2J::error::x', sameRuleset: false, newRules: [] },
      },
    });
    expect(unsafeCodePoints(text, { tab: true, newline: true })).toEqual([]);
    for (const line of text.split('\n')) expect(line.trimStart().startsWith('::')).toBe(false);
  });
});
