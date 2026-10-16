/**
 * Golden fix fixtures for the JSON, MCP, hooks, settings and risk rules:
 *
 *   test/fixtures/fix/<rule id>/<case>/before/…   the repository as scanned
 *   test/fixtures/fix/<rule id>/<case>/after/…    every file after `fix --write --review`
 *   test/fixtures/fix/<rule id>/<case>/case.json  optional {@link CaseOptions}
 *
 * Each case runs the real verification rounds (fixRounds) with every built-in rule, selecting
 * only the case's rule, and checks that the fixed copy matches `after/` byte for byte, that the
 * rule has nothing left to fix, that no finding is new, and that a second run changes nothing.
 *
 * Fixture text may hold two placeholders, replaced when a tree is read, so that the repository
 * never contains a credential-shaped string or an invisible character:
 * - `{{U+XXXX}}`: the character with that code point;
 * - `{{SECRET:<name>}}`: a fake credential from {@link SECRETS}, built at run time.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { AnyRule, Finding, Fix, PlatformId } from '../../../src/core/types.js';
import { applyPlan } from '../../../src/fix/apply.js';
import type { FixSelection } from '../../../src/fix/index.js';
import { type FixRun, fixRounds } from '../../../src/fix/verify.js';
import { builtinRules } from '../../../src/rules/index.js';
import { planned } from '../../fix/helpers.js';
import { type FileMap, lint, type LintOptions, snapshotFrom } from '../../helpers/lint.js';
import { noise } from './helpers.js';

const ROOT = fileURLToPath(new URL('../../fixtures/fix/', import.meta.url));

/** Fake credentials, assembled at run time so the source never contains a contiguous token. */
export const SECRETS: Readonly<Record<string, string>> = {
  github: 'gh' + 'p_' + noise(36, 101),
  openai:
    'sk-' +
    'proj-' +
    noise(40, 102, 'abcdefghijklmnopqrstuvwxyz0123456789') +
    'T3Blbk' +
    'FJ' +
    noise(40, 103, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
};

export interface CaseOptions {
  /** Fix classes to apply. Default both. */
  readonly classes?: readonly ('safe' | 'review')[];
  /** Opt in to mcp/literal-secret fixes. */
  readonly literalSecret?: boolean;
  readonly targets?: readonly PlatformId[];
  /** Rule ids of the `info` findings the fix is expected to introduce. Default none. */
  readonly introduced?: readonly string[];
}

function substitute(text: string): string {
  return text
    .replace(/\{\{U\+([0-9A-F]{4,6})\}\}/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\{\{SECRET:(\w+)\}\}/g, (_, name: string) => {
      const secret = SECRETS[name];
      if (secret === undefined) throw new Error(`Unknown fixture secret ${name}`);
      return secret;
    });
}

/** Every file under `dir`, dotfiles included, by POSIX path relative to it. */
export function readTree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      if (statSync(path).isDirectory()) visit(path, relative);
      else files[relative] = substitute(readFileSync(path, 'utf8'));
    }
  };
  visit(dir, '');
  return files;
}

/** The case names of a rule, sorted. */
export function goldenCases(ruleId: string): string[] {
  return readdirSync(join(ROOT, ruleId))
    .filter((name) => statSync(join(ROOT, ruleId, name)).isDirectory())
    .sort();
}

function caseOptions(dir: string): CaseOptions {
  try {
    return JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as CaseOptions;
  } catch {
    return {};
  }
}

export function selectionFor(ruleId: string, options: CaseOptions = {}): FixSelection {
  return {
    classes: new Set(options.classes ?? ['safe', 'review']),
    ruleIds: new Set([ruleId]),
    literalSecret: options.literalSecret ?? false,
  };
}

/** The verification rounds over in-memory files, every built-in rule scanning. */
export function runFixes(
  files: Readonly<Record<string, string>>,
  selection: FixSelection,
  targets?: readonly PlatformId[],
): FixRun {
  return fixRounds(
    snapshotFrom(files),
    { rules: builtinRules, ...(targets === undefined ? {} : { targets }) },
    selection,
  );
}

/** Text of every file in a fixed copy, by path. */
export function filesOf(run: FixRun): Record<string, string> {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  return Object.fromEntries(
    run.snapshot.files.map((file) => [file.path, decoder.decode(file.bytes)]),
  );
}

/** Findings of `ruleId` in a scan of in-memory files with `rules`, suppressed ones left out. */
export function findingsOf(
  files: FileMap,
  rules: readonly AnyRule[],
  ruleId: string,
  extras: Omit<LintOptions, 'rules'> = {},
): Finding[] {
  const result = lint(files, { rules, ...extras });
  if (result.ruleFailures.length > 0) {
    throw new Error(`Rule crashed: ${JSON.stringify(result.ruleFailures)}`);
  }
  return result.findings.filter(
    (finding) => finding.ruleId === ruleId && finding.suppressed === undefined,
  );
}

/** The fixes of `ruleId`'s findings, in report order. */
export function fixesOf(
  files: FileMap,
  rules: readonly AnyRule[],
  ruleId: string,
  extras: Omit<LintOptions, 'rules'> = {},
): (Fix | undefined)[] {
  return findingsOf(files, rules, ruleId, extras).map((finding) => finding.fix);
}

/** The text of `path` after applying `fix` alone to the files. */
export function applied(files: FileMap, fix: Fix | undefined, path: string): string {
  if (fix === undefined) throw new Error('No fix');
  const snapshot = applyPlan(snapshotFrom(files), { fixes: [planned(fix)] });
  const file = snapshot.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`${path} is not in the snapshot`);
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(file.bytes);
}

/** Every string a fix shows besides its diff: title, notes, warning, alternatives' too. */
export function shownText(fix: Fix): string[] {
  return [
    fix.title,
    ...(fix.notes ?? []),
    ...(fix.warning === undefined ? [] : [fix.warning]),
    ...(fix.alternatives ?? []).flatMap(shownText),
  ];
}

/** Runs one golden case and checks it, as the module comment describes. */
export function checkGolden(ruleId: string, name: string): FixRun {
  const dir = join(ROOT, ruleId, name);
  const options = caseOptions(dir);
  const before = readTree(join(dir, 'before'));
  const after = readTree(join(dir, 'after'));
  const selection = selectionFor(ruleId, options);
  const run = runFixes(before, selection, options.targets);

  expect(run.applied.length, 'fixes applied').toBeGreaterThan(0);
  expect(filesOf(run)).toEqual(after);
  for (const file of run.snapshot.files) {
    expect(Buffer.from(file.bytes).equals(Buffer.from(after[file.path] ?? '', 'utf8'))).toBe(true);
  }
  expect(
    run.verification.introduced.map((finding) => `${finding.severity} ${finding.ruleId}`),
    'new findings',
  ).toEqual((options.introduced ?? []).map((ruleId) => `info ${ruleId}`));
  const left = run.after.findings.filter(
    (finding) =>
      finding.ruleId === ruleId &&
      finding.suppressed === undefined &&
      finding.fix !== undefined &&
      selection.classes.has(finding.fix.class),
  );
  expect(left, 'findings left with a fix').toEqual([]);

  // Idempotent: the fixed copy plans nothing.
  const again = fixRounds(
    run.snapshot,
    { rules: builtinRules, ...(options.targets === undefined ? {} : { targets: options.targets }) },
    selection,
  );
  expect(again.applied).toEqual([]);
  expect(again.files).toEqual([]);
  return run;
}
