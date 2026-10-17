/**
 * Golden fixes of the instruction rules and the directive findings: for every case in
 * test/fixtures/fix/<rule-id-with-dashes>/<case>/, the files in `before/` are walked from disk,
 * fixed in memory with that rule's fix classes selected, and compared byte for byte with
 * `after/`. The fix must resolve the rule's findings, add no finding, and leave nothing to fix
 * on a second run.
 *
 * Only the `instr-*` and `directive-*` directories belong to this test; other rule families
 * test their own.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIRECTIVE_RULES } from '../../../src/core/directive-rules.js';
import type { FixClass, RuleMeta } from '../../../src/core/types.js';
import type { FixSelection } from '../../../src/fix/index.js';
import { fixRounds, type FixRun } from '../../../src/fix/verify.js';
import { walk } from '../../../src/io/walk.js';
import { builtinRules } from '../../../src/rules/index.js';

const ROOT = fileURLToPath(new URL('../../fixtures/fix/', import.meta.url));
const OWNED_PREFIXES = ['instr-', 'directive-'];

function metaOf(ruleId: string): RuleMeta {
  const meta =
    builtinRules.find((rule) => rule.meta.id === ruleId)?.meta ??
    DIRECTIVE_RULES.find((candidate) => candidate.id === ruleId);
  if (meta === undefined) throw new Error(`Unknown rule ${ruleId}`);
  return meta;
}

/** Every file below `dir`, by POSIX path relative to it. */
function diskFiles(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(dir, path).split(sep).join('/'), readFileSync(path));
  }
  return files;
}

/** Bytes as Latin-1 text: one character per byte, so a failing diff shows every byte. */
function readable(files: ReadonlyMap<string, Uint8Array>): Record<string, string> {
  return Object.fromEntries(
    [...files]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, bytes]) => [path, Buffer.from(bytes).toString('latin1')]),
  );
}

/** The files of `before/` with the run's changes. */
function fixedFiles(before: ReadonlyMap<string, Buffer>, run: FixRun): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>(before);
  for (const diff of run.files) {
    if (diff.from !== undefined) files.delete(diff.from);
    files.set(diff.path, diff.after);
  }
  return files;
}

interface GoldenCase {
  readonly ruleId: string;
  readonly name: string;
  readonly dir: string;
}

const CASES: GoldenCase[] = readdirSync(ROOT)
  .filter((ruleDir) => OWNED_PREFIXES.some((prefix) => ruleDir.startsWith(prefix)))
  .sort()
  .flatMap((ruleDir) =>
    readdirSync(join(ROOT, ruleDir))
      .sort()
      .map((name) => ({
        ruleId: ruleDir.replace('-', '/'),
        name,
        dir: join(ROOT, ruleDir, name),
      })),
  );

describe('golden fixes', () => {
  it('covers every fixable rule of the instruction family and the directives', () => {
    const covered = new Set(CASES.map((item) => item.ruleId));
    const fixable = [...builtinRules.map((rule) => rule.meta), ...DIRECTIVE_RULES].filter(
      (meta) =>
        meta.fix !== undefined &&
        (meta.id.startsWith('instr/') || meta.id.startsWith('directive/')),
    );
    expect(fixable.map((meta) => meta.id).filter((id) => !covered.has(id))).toEqual([]);
  });

  it.each(CASES)('$ruleId $name', async ({ ruleId, dir }) => {
    const classes: readonly FixClass[] = metaOf(ruleId).fix?.classes ?? [];
    const selection: FixSelection = {
      classes: new Set(classes),
      ruleIds: new Set([ruleId]),
      literalSecret: false,
    };
    const beforeDir = join(dir, 'before');
    const snapshot = await walk(beforeDir);
    const run = fixRounds(snapshot, { rules: builtinRules }, selection);

    expect(run.before.ruleFailures).toEqual([]);
    expect(run.applied.length).toBeGreaterThan(0);
    expect(run.applied.every((fix) => fix.ruleId === ruleId)).toBe(true);
    expect(run.skipped).toEqual([]);
    expect(readable(fixedFiles(diskFiles(beforeDir), run))).toEqual(
      readable(diskFiles(join(dir, 'after'))),
    );

    // The rule's findings are gone and nothing new appeared.
    const active = (findings: FixRun['after']['findings']) =>
      findings.filter((finding) => finding.ruleId === ruleId && finding.suppressed === undefined);
    expect(active(run.before.findings).length).toBeGreaterThan(0);
    expect(active(run.after.findings)).toEqual([]);
    expect(run.verification.introduced).toEqual([]);

    // A second run plans nothing.
    const again = fixRounds(run.snapshot, { rules: builtinRules }, selection);
    expect(again.applied).toEqual([]);
    expect(again.files).toEqual([]);
  });
});
