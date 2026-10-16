/**
 * Golden fixes of the Cursor and GitHub Copilot rules: each case under
 * test/fixtures/fix/<family>/<rule>/<case>/ holds the files before and after
 * `agentcheckup fix --write --review --rule <rule>`, byte for byte.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { Snapshot } from '../../../src/core/types.js';
import type { FixSelection } from '../../../src/fix/index.js';
import { type FixRun, fixRounds } from '../../../src/fix/verify.js';
import { builtinRules } from '../../../src/rules/index.js';
import { type FileMap, snapshotFrom } from '../../helpers/lint.js';

const ROOT = fileURLToPath(new URL('../../fixtures/fix/', import.meta.url));

/** Every file below `directory`, dotfiles included, by POSIX path relative to it. */
export function readTree(directory: string): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else files[path] = new Uint8Array(readFileSync(join(directory, path)));
    }
  };
  visit('');
  return files;
}

/** The cases of a rule: directory names under test/fixtures/fix/<rule>/. */
export function goldenCases(ruleId: string): string[] {
  return readdirSync(join(ROOT, ruleId), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Safe and review fixes of one rule, as `fix --write --review --rule <rule>` selects them. */
export function onlyRule(ruleId: string): FixSelection {
  return {
    classes: new Set(['safe', 'review']),
    ruleIds: new Set([ruleId]),
    literalSecret: false,
  };
}

/** Fixes in memory with every built-in rule scanning, but only `ruleId`'s fixes selected. */
export function runFix(snapshot: Snapshot, ruleId: string): FixRun {
  return fixRounds(snapshot, { rules: builtinRules }, onlyRule(ruleId));
}

/** The files of a fixed snapshot, by path. */
export function filesOf(snapshot: Snapshot): Record<string, Uint8Array> {
  return Object.fromEntries(snapshot.files.map((file) => [file.path, file.bytes]));
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** Bytes as text that shows a byte order mark and CR, so a failed comparison is readable. */
function visible(files: Record<string, Uint8Array>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, bytes]) => [
        path,
        decoder.decode(bytes).replaceAll('﻿', '<BOM>').replaceAll('\r', '<CR>'),
      ]),
  );
}

/**
 * Checks one golden case: the fixed copy matches `after/` byte for byte, the rule's findings
 * are gone, no error or warning is new, and a second run plans nothing.
 */
export function checkGolden(ruleId: string, name: string): FixRun {
  const directory = join(ROOT, ruleId, name);
  const before: FileMap = readTree(join(directory, 'before'));
  const after = readTree(join(directory, 'after'));
  const run = runFix(snapshotFrom(before), ruleId);

  expect(run.applied.length).toBeGreaterThan(0);
  expect(run.skipped).toEqual([]);
  expect(run.deferred).toEqual([]);
  const fixed = filesOf(run.snapshot);
  expect(visible(fixed)).toEqual(visible(after));
  for (const [path, bytes] of Object.entries(after)) {
    expect(Buffer.from(fixed[path] ?? new Uint8Array()).equals(Buffer.from(bytes))).toBe(true);
  }
  expect(run.after.findings.filter((finding) => finding.ruleId === ruleId)).toEqual([]);
  expect(run.verification.resolved).toBeGreaterThan(0);
  expect(run.verification.introduced.filter((finding) => finding.severity !== 'info')).toEqual([]);

  const again = runFix(run.snapshot, ruleId);
  expect(again.applied).toEqual([]);
  expect(again.skipped).toEqual([]);
  return run;
}
