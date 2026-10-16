/**
 * Helpers for the fix tests of the instruction rules: the fix and manual step a rule attaches to
 * its findings, and in-memory fix runs.
 */
import type { RuleResult } from '../../../src/core/engine.js';
import type { AnyRule, Finding, FixClass } from '../../../src/core/types.js';
import type { FixSelection } from '../../../src/fix/index.js';
import { type FixRun, fixRounds } from '../../../src/fix/verify.js';
import { decode } from '../../../src/core/text.js';
import { type FileMap, type LintOptions, snapshotFrom } from '../../helpers/lint.js';

/** The unsuppressed findings of `ruleId` with their fix and guidance. */
export function repairs(
  result: Pick<RuleResult, 'findings'>,
  ruleId: string,
): Pick<Finding, 'path' | 'fix' | 'guidance'>[] {
  return result.findings
    .filter((finding) => finding.ruleId === ruleId && finding.suppressed === undefined)
    .map(({ path, fix, guidance }) => ({
      path,
      ...(fix === undefined ? {} : { fix }),
      ...(guidance === undefined ? {} : { guidance }),
    }));
}

/** Every class, for one rule. */
export function selectRule(
  ruleId: string,
  classes: readonly FixClass[] = ['safe', 'review'],
): FixSelection {
  return { classes: new Set(classes), ruleIds: new Set([ruleId]), literalSecret: false };
}

/** Fixes in-memory files with `rules`, as `agentcheckup fix` plans them. */
export function fixFiles(
  files: FileMap,
  options: Omit<LintOptions, 'rules' | 'config'> & { readonly rules: readonly AnyRule[] },
  selection: FixSelection,
): FixRun {
  return fixRounds(
    snapshotFrom(files, options),
    {
      rules: options.rules,
      ...(options.targets === undefined ? {} : { targets: options.targets }),
      ...(options.trustDirectives === undefined
        ? {}
        : { trustDirectives: options.trustDirectives }),
    },
    selection,
  );
}

/** The decoded text of a file after a run. */
export function fixedText(run: FixRun, path: string): string | undefined {
  const file = run.snapshot.files.find((candidate) => candidate.path === path);
  return file === undefined ? undefined : decode(file.bytes).text;
}
