/**
 * A scan that could not see something never reads like a clean scan: every format says what it
 * did not check (src/report/coverage.ts).
 */
import { describe, expect, it } from 'vitest';

import type { ScanResult } from '../../src/core/engine.js';
import { coverageMessages, coverageOf } from '../../src/report/coverage.js';
import { formatGithub } from '../../src/report/github.js';
import { formatJson } from '../../src/report/json.js';
import { formatMarkdown } from '../../src/report/markdown.js';
import { formatSarif } from '../../src/report/sarif.js';
import { formatStylish as stylish, plainStyle } from '../../src/report/stylish.js';
import { emptyResult, makeResult } from './fixtures.js';
import { parseWorkflowCommand } from './safety.js';

/** Two agent files too large to read, and nothing else: what a 5 MB CLAUDE.md gives. */
const unread: ScanResult = makeResult({
  skipped: [
    { path: 'AGENTS.md', reason: 'too-large', size: 5_000_036 },
    { path: 'CLAUDE.md', reason: 'too-large', size: 5_000_036 },
  ],
});

/** A trusted scan that left gitignored and vendored agent configuration out. */
const leftOut: ScanResult = {
  ...makeResult(),
  unscannedConfig: {
    gitignored: ['.claude/settings.local.json', 'CLAUDE.local.md'],
    excluded: ['vendor/.mcp.json'],
    complete: true,
  },
};

/** A walk that stopped at its entry limit, with a directory it could not list. */
const stopped: ScanResult = makeResult({
  skipped: [
    { path: 'a/99999', reason: 'file-limit' },
    { path: 'deep/x/', reason: 'depth-limit' },
  ],
});

const show = { show: (path: string): string => path };

const formatStylish = (result: ScanResult): string => stylish(result, { style: plainStyle });

describe('coverageMessages', () => {
  it('says nothing for a scan that saw everything', () => {
    expect(coverageMessages(coverageOf(emptyResult), show)).toEqual([]);
    // An unread file that is no agent configuration, and an import past its limit.
    const other = makeResult({
      skipped: [
        { path: 'notes.bin', reason: 'binary' },
        { path: 'docs/guide.md', reason: 'import-limit' },
      ],
    });
    expect(coverageMessages(coverageOf(other), show)).toEqual([]);
  });

  it('warns where a limit hid agent configuration', () => {
    expect(coverageMessages(coverageOf(stopped), show)).toEqual([
      {
        level: 'warning',
        text: 'The scan stopped at its limit of directory entries before a/99999, so agent configuration in the directories it had not listed was not checked.',
      },
      {
        level: 'warning',
        text: '1 directory could not be listed (too deep: 1), so agent configuration in them was not checked: deep/x/',
      },
    ]);
    expect(coverageMessages(coverageOf(unread), show)).toEqual([
      {
        level: 'warning',
        text: '2 agent configuration files were not checked (too large: 2): AGENTS.md, CLAUDE.md',
      },
    ]);
  });

  it('notes what a trusted scan left out, and how to check it', () => {
    expect(coverageMessages(coverageOf(leftOut), show)).toEqual([
      {
        level: 'notice',
        text: '2 agent configuration files are excluded by .gitignore; add --no-gitignore to check them: .claude/settings.local.json, CLAUDE.local.md',
      },
      {
        level: 'notice',
        text: '1 agent configuration file in build output or vendored code is not checked; add --untrusted to check it: vendor/.mcp.json',
      },
    ]);
    const partial = {
      ...leftOut,
      unscannedConfig: { ...leftOut.unscannedConfig!, complete: false },
    };
    expect(coverageMessages(coverageOf(partial), show)[0]?.text).toMatch(/^At least 2 agent/);
  });

  it('lists a few paths and counts the rest', () => {
    const many = {
      ...makeResult(),
      unscannedConfig: {
        gitignored: ['a/AGENTS.md', 'b/AGENTS.md', 'c/AGENTS.md', 'd/AGENTS.md', 'e/AGENTS.md'],
        excluded: [],
        complete: true,
      },
    };
    expect(coverageMessages(coverageOf(many), { ...show, more: '...' })[0]?.text).toBe(
      '5 agent configuration files are excluded by .gitignore; add --no-gitignore to check them: a/AGENTS.md, b/AGENTS.md, c/AGENTS.md, ... and 2 more',
    );
  });
});

describe('every format says what the scan did not check', () => {
  it('stylish: never "No agent configuration files found" when it found some', () => {
    expect(formatStylish(unread)).toContain(
      'No agent configuration files were checked; see the notes above.',
    );
    expect(formatStylish(unread)).not.toContain('No agent configuration files found');
    expect(formatStylish(emptyResult)).toContain('No agent configuration files found.');
    const output = formatStylish(leftOut);
    expect(output).toContain(
      '2 agent configuration files are excluded by .gitignore; add --no-gitignore to check them',
    );
    expect(output).toContain('add --untrusted to check it: vendor/.mcp.json');
  });

  it('stylish: no "No problems found" with a check mark when a limit hid something', () => {
    const artifacts = [{ path: 'AGENTS.md', kind: 'agents-md', readers: ['codex'] }] as const;
    const score = { score: 100, grade: 'A', capped: false } as const;
    const limited = { ...makeResult({ artifacts, score }), skipped: stopped.skipped };
    expect(formatStylish(limited)).toContain(
      '! No problems found in the 1 file checked; some agent configuration was not checked (see above)',
    );
    // Left out on purpose, with an option to check it: still a clean result, with the note.
    const clean = {
      ...makeResult({ artifacts, score }),
      unscannedConfig: leftOut.unscannedConfig!,
    };
    expect(formatStylish(clean)).toContain('✔ No problems found (1 file checked)');
  });

  it('github: a warning annotation, so the run does not print nothing', () => {
    const lines = formatGithub(unread).trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(parseWorkflowCommand(lines[0]!)).toMatchObject({
      command: 'warning',
      properties: { title: 'agentcheckup: not checked' },
      data: '2 agent configuration files were not checked (too large: 2): AGENTS.md, CLAUDE.md',
    });
    expect(formatGithub(leftOut)).toMatch(/^::notice title=agentcheckup%3A not checked::2 agent/);
    expect(formatGithub(emptyResult)).toBe('');
  });

  it('markdown, SARIF and JSON', () => {
    expect(formatMarkdown(unread)).toContain(
      '## agentcheckup: no agent configuration files checked',
    );
    expect(formatMarkdown(emptyResult)).toContain('no agent configuration files found');
    expect(formatMarkdown(stopped)).toContain('**Not checked:** The scan stopped');
    const sarif = JSON.parse(formatSarif(leftOut)) as {
      runs: {
        invocations: {
          toolExecutionNotifications: { level: string; message: { text: string } }[];
        }[];
      }[];
    };
    const notes = sarif.runs[0]!.invocations[0]!.toolExecutionNotifications;
    expect(notes.map((note) => note.level)).toEqual(['note', 'note']);
    const json = JSON.parse(formatJson(leftOut)) as { unscannedConfig: unknown };
    expect(json.unscannedConfig).toEqual({
      gitignored: ['.claude/settings.local.json', 'CLAUDE.local.md'],
      excluded: ['vendor/.mcp.json'],
      complete: true,
    });
    expect(JSON.parse(formatJson(emptyResult))).not.toHaveProperty('unscannedConfig');
  });
});
