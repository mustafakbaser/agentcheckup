/**
 * Golden fixes of the skill rules: every case under test/fixtures/fix/skill/<rule>/<case>/ holds a
 * `before` and an `after` repository. The case is walked from disk, fixed in memory with
 * fixRounds for its rule only, and must give `after` byte for byte, resolve every finding of the
 * rule, add no finding of any rule, and leave nothing to fix on a second run.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type Finding,
  type FixClass,
  PLATFORM_IDS,
  type Snapshot,
} from '../../../src/core/types.js';
import type { FixSelection } from '../../../src/fix/index.js';
import { fixRounds } from '../../../src/fix/verify.js';
import { walk } from '../../../src/io/walk.js';
import { builtinRules } from '../../../src/rules/index.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/fix/skill', import.meta.url));

/** The fixes each case applies, in order: id and class. */
const EXPECTED: Readonly<Record<string, readonly (readonly [string, FixClass])[]>> = {
  'broken-reference/backslashes': [
    ['skill/broken-reference#slashes', 'safe'],
    ['skill/broken-reference#slashes', 'safe'],
  ],
  'broken-reference/letter-case': [['skill/broken-reference#case', 'review']],
  'description-missing/empty-value': [['skill/description-missing#copy-body', 'review']],
  'description-missing/missing-key': [['skill/description-missing#copy-body', 'review']],
  'description-missing/yaml-injection': [['skill/description-missing#copy-body', 'review']],
  'field-type/allowed-tools-list': [['skill/field-type#allowed-tools-string', 'review']],
  'frontmatter-bom/utf8-bom-crlf': [['skill/frontmatter-bom#remove-bom', 'safe']],
  'frontmatter-missing/blank-lines-before': [['skill/frontmatter-missing#blank-lines', 'safe']],
  'frontmatter-missing/indented-block': [['skill/frontmatter-missing#dedent', 'safe']],
  'frontmatter-missing/indented-closing-line': [['skill/frontmatter-missing#dedent', 'safe']],
  'frontmatter-missing/no-frontmatter': [['skill/frontmatter-missing#add', 'review']],
  'name-dir-mismatch/directory-name': [['skill/name-dir-mismatch#directory', 'review']],
  'name-dir-mismatch/slug-equals-directory': [['skill/name-dir-mismatch#slug', 'safe']],
  'name-format/crlf-keeps-line-endings': [['skill/name-format#slug', 'safe']],
  'name-format/directory-name': [['skill/name-format#directory', 'review']],
  'name-format/number-like-slug': [['skill/name-format#slug', 'safe']],
  'name-format/slug-equals-directory': [['skill/name-format#slug', 'safe']],
  'name-format/yaml-keyword-slug': [['skill/name-format#slug', 'safe']],
  'name-missing/missing-key': [['skill/name-missing#directory', 'safe']],
  'name-missing/null-keyword-directory': [['skill/name-missing#directory', 'safe']],
  'yaml-portability/quote-scalars': [
    ['skill/yaml-portability#quote', 'review'],
    ['skill/yaml-portability#quote', 'review'],
  ],
};

function directories(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const CASES = directories(FIXTURES).flatMap((rule) =>
  directories(join(FIXTURES, rule)).map((name) => `${rule}/${name}`),
);

/** Every file below `root`, by POSIX path relative to it. */
function filesUnder(root: string, prefix = ''): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [inner, bytes] of filesUnder(root, path)) files.set(inner, bytes);
    } else {
      files.set(path, readFileSync(join(root, path)));
    }
  }
  return files;
}

/** Bytes as one character per byte, so a mismatch shows where the files differ. */
const bytes = (data: Uint8Array): string => Buffer.from(data).toString('latin1');

const active = (findings: readonly Finding[], ruleId: string): Finding[] =>
  findings.filter((finding) => finding.ruleId === ruleId && finding.suppressed === undefined);

function fix(snapshot: Snapshot, ruleId: string) {
  const selection: FixSelection = {
    classes: new Set(['safe', 'review']),
    ruleIds: new Set([ruleId]),
    literalSecret: false,
  };
  return fixRounds(snapshot, { rules: builtinRules, targets: PLATFORM_IDS }, selection);
}

describe('skill fix fixtures', () => {
  it('lists an expectation for every case', () => {
    expect(CASES).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(CASES)('%s', async (name) => {
    const ruleId = `skill/${name.slice(0, name.indexOf('/'))}`;
    const beforeRoot = join(FIXTURES, name, 'before');
    const afterRoot = join(FIXTURES, name, 'after');
    const run = fix(await walk(beforeRoot, { scanIgnoredAgentConfig: true }), ruleId);
    expect(run.before.ruleFailures).toEqual([]);

    expect(run.applied.map((applied) => [applied.fix.id, applied.fix.class])).toEqual(
      EXPECTED[name],
    );
    expect(run.skipped).toEqual([]);
    expect(run.deferred).toEqual([]);
    expect(active(run.before.findings, ruleId).length).toBeGreaterThan(0);
    expect(active(run.after.findings, ruleId)).toEqual([]);
    expect(run.verification.introduced).toEqual([]);

    // Byte for byte: files the walk did not read cannot have changed.
    const before = filesUnder(beforeRoot);
    const expected = filesUnder(afterRoot);
    const written = new Map(run.snapshot.files.map((file) => [file.path, file.bytes]));
    const actual = new Map(
      [...before].map(([path, data]) => [path, bytes(written.get(path) ?? data)]),
    );
    expect(actual).toEqual(new Map([...expected].map(([path, data]) => [path, bytes(data)])));

    // Idempotent: nothing to fix in the fixed copy, nor in the committed `after` repository.
    expect(fix(run.snapshot, ruleId).applied).toEqual([]);
    const settled = fix(await walk(afterRoot, { scanIgnoredAgentConfig: true }), ruleId);
    expect(active(settled.before.findings, ruleId)).toEqual([]);
    expect(settled.applied).toEqual([]);
  });
});
