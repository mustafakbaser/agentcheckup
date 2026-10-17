/**
 * Golden fixes of skill/body-too-long: every case under
 * test/fixtures/fix/skill/body-too-long/<case>/ holds a `before` and an `after` repository. The
 * case is walked from disk with its agentcheckup.config.json, fixed in memory with fixRounds for
 * this rule only, and must give `after` byte for byte, new files included. A case with a fix must
 * resolve every finding of the rule and add none; a case without one must leave the files as they
 * are. Both must leave nothing to fix on a second run.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../../src/core/config.js';
import type { Finding, Snapshot } from '../../../src/core/types.js';
import type { FixSelection } from '../../../src/fix/index.js';
import { type FixRun, fixRounds } from '../../../src/fix/verify.js';
import { walk } from '../../../src/io/walk.js';
import { builtinRules } from '../../../src/rules/index.js';

const ID = 'skill/body-too-long';
const FIXTURES = fileURLToPath(new URL('../../fixtures/fix/skill/body-too-long', import.meta.url));

/** The files each case creates, or an empty list when the rule offers no fix. */
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  'claude-heading': ['claude-2.md', 'agents-2.md'],
  'crlf-bom': ['usage.md', 'examples.md'],
  'custom-max-lines': ['commands.md', 'options.md'],
  'deeper-level': ['configure.md'],
  'hostile-heading': ['x.md', 'aux-2.md', 'section-4.md'],
  // Already split and within the limit: no finding.
  idempotency: [],
  'largest-first': ['api-reference.md', 'troubleshooting.md'],
  'name-collision': ['examples-2.md', 'usage-2.md', 'examples-3.md'],
  'no-headings': [],
  'scan-root': [],
  'sections-that-stay': ['extra-steps.md', 'more-steps.md'],
  'tokens-only': ['field-reference.md'],
};

const CASES = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** Every file below `dir`, by POSIX path relative to it. */
function diskFiles(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
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
function fixedFiles(before: ReadonlyMap<string, Uint8Array>, run: FixRun): Map<string, Uint8Array> {
  const files = new Map(before);
  for (const diff of run.files) {
    if (diff.from !== undefined) files.delete(diff.from);
    files.set(diff.path, diff.after);
  }
  return files;
}

const SELECTION: FixSelection = {
  classes: new Set(['safe', 'review']),
  ruleIds: new Set([ID]),
  literalSecret: false,
};

/** Fixes `snapshot` with this rule's fixes, scanned with the case's configuration. */
function fix(snapshot: Snapshot, root: string): FixRun {
  const file = join(root, 'agentcheckup.config.json');
  const config = existsSync(file)
    ? resolveConfig(JSON.parse(readFileSync(file, 'utf8')))
    : undefined;
  return fixRounds(
    snapshot,
    { rules: builtinRules, ...(config === undefined ? {} : { config }) },
    SELECTION,
  );
}

const active = (findings: readonly Finding[]): Finding[] =>
  findings.filter((finding) => finding.ruleId === ID && finding.suppressed === undefined);

describe('skill/body-too-long fix fixtures', () => {
  it('lists an expectation for every case', () => {
    expect(CASES).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(CASES)('%s', async (name) => {
    const beforeRoot = join(FIXTURES, name, 'before');
    const afterRoot = join(FIXTURES, name, 'after');
    const run = fix(await walk(beforeRoot, { scanIgnoredAgentConfig: true }), beforeRoot);
    expect(run.before.ruleFailures).toEqual([]);
    expect(run.skipped).toEqual([]);
    expect(run.deferred).toEqual([]);
    expect(run.verification.introduced).toEqual([]);
    expect(readable(fixedFiles(diskFiles(beforeRoot), run))).toEqual(
      readable(diskFiles(afterRoot)),
    );

    const created = EXPECTED[name] ?? [];
    const findings = active(run.before.findings);
    if (created.length === 0) {
      expect(run.applied).toEqual([]);
      for (const finding of findings) {
        expect(finding.fix).toBeUndefined();
        expect(finding.guidance).toBe(
          'move reference sections into files next to SKILL.md and link to them from the body',
        );
      }
      if (name !== 'idempotency') expect(findings.length).toBeGreaterThan(0);
    } else {
      expect(run.applied.map((applied) => [applied.fix.id, applied.fix.class])).toEqual([
        [`${ID}#split`, 'review'],
      ]);
      // One fix claims every finding of the file: the line count and the token estimate.
      expect(run.applied[0]?.findings).toEqual(
        findings.map((finding) => finding.fingerprint).sort(),
      );
      expect(findings.length).toBeGreaterThan(0);
      expect(active(run.after.findings)).toEqual([]);
      const creates = run.applied[0]?.fix.changes.flatMap((change) =>
        change.kind === 'create' ? [change.path.slice(change.path.lastIndexOf('/') + 1)] : [],
      );
      expect(creates).toEqual(created);
    }

    // Idempotent: nothing to fix in the fixed copy, nor in the committed `after` repository.
    expect(fix(run.snapshot, beforeRoot).applied).toEqual([]);
    const settled = fix(await walk(afterRoot, { scanIgnoredAgentConfig: true }), afterRoot);
    expect(settled.applied).toEqual([]);
    if (created.length > 0) expect(active(settled.before.findings)).toEqual([]);
  });
});
