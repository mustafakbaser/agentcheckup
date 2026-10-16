/**
 * Shared helpers for the fix tests: artifacts from in-memory files, applying one change, and
 * test-only rules that attach fixes (no built-in rule emits fixes yet).
 */
import { analyze, type Analysis } from '../../src/core/engine.js';
import { decode } from '../../src/core/text.js';
import type {
  AnyRule,
  Artifact,
  ArtifactKind,
  FileChange,
  Fix,
  FixClass,
  PlatformId,
  RuleContext,
  Severity,
  Snapshot,
} from '../../src/core/types.js';
import { applyPlan } from '../../src/fix/apply.js';
import type { FixSelection, PlannedFix } from '../../src/fix/index.js';
import { encodeText } from '../../src/fix/text.js';
import { defineRule } from '../../src/rules/define.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';

export const SOURCE = {
  title: 'test',
  url: 'https://example.com',
  checked: '2026-10-16',
  status: 'verified',
} as const;

/** Bytes of `text` in UTF-16 with a byte order mark. */
export function utf16(text: string, encoding: 'utf-16le' | 'utf-16be' = 'utf-16le'): Uint8Array {
  return encodeText(text, encoding, true);
}

/** UTF-8 bytes with a byte order mark. */
export function utf8Bom(text: string): Uint8Array {
  return encodeText(text, 'utf-8', true);
}

/** The analysis of in-memory files and one of its artifacts. */
export function artifactOf(
  path: string,
  content: string | Uint8Array,
  files: FileMap = {},
): { analysis: Analysis; artifact: Artifact } {
  const analysis = analyze(snapshotFrom({ ...files, [path]: content }));
  const artifact = analysis.index.get(path);
  if (artifact === undefined) throw new Error(`${path} is not an artifact`);
  return { analysis, artifact };
}

export function fixOf(
  changes: readonly FileChange[],
  id = 'test/rule#fix',
  cls: FixClass = 'safe',
): Fix {
  return { id, class: cls, title: 'Test fix', changes };
}

export function planned(fix: Fix, ruleId = 'test/rule'): PlannedFix {
  return { fix, ruleId, findings: [], effects: [], status: 'planned' };
}

/** Applies changes as one fix and returns the new snapshot. */
export function applyChanges(snapshot: Snapshot, ...changes: (FileChange | undefined)[]): Snapshot {
  const defined = changes.map((change) => {
    if (change === undefined) throw new Error('The builder refused the change.');
    return change;
  });
  return applyPlan(snapshot, { fixes: [planned(fixOf(defined))] });
}

/** The file's bytes in a snapshot. */
export function bytesOf(snapshot: Snapshot, path: string): Uint8Array {
  const file = snapshot.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`${path} is not in the snapshot`);
  return file.bytes;
}

/** The file's decoded text in a snapshot. */
export function textOf(snapshot: Snapshot, path: string): string {
  return decode(bytesOf(snapshot, path)).text;
}

/** Applies one builder change to the artifact's file and returns the new decoded text. */
export function edited(artifact: Artifact, change: FileChange | undefined): string {
  const snapshot = snapshotFrom({ [artifact.path]: artifact.file.bytes });
  const path = change?.kind === 'rename' ? change.to : artifact.path;
  return textOf(applyChanges(snapshot, change), path);
}

export const SAFE_ONLY: FixSelection = { classes: new Set(['safe']), literalSecret: false };
export const ALL_CLASSES: FixSelection = {
  classes: new Set(['safe', 'review']),
  literalSecret: false,
};

export interface TestRuleOptions {
  readonly id: string;
  readonly appliesTo?: readonly ArtifactKind[];
  readonly severity?: Severity;
  readonly platforms?: readonly PlatformId[];
  readonly check: (context: RuleContext<undefined>, artifact: Artifact) => void;
}

/** A rule that runs `check` on every artifact of its kinds. */
export function testRule(options: TestRuleOptions): AnyRule {
  return defineRule({
    meta: {
      id: options.id,
      title: 'Test rule',
      rationale: 'Test rule.',
      category: 'correctness',
      severity: options.severity ?? 'warn',
      appliesTo: options.appliesTo ?? ['agents-md'],
      platforms: options.platforms ?? ['codex', 'claude-code', 'cursor'],
      sources: [SOURCE],
      since: '2026.10',
      fix: { classes: ['safe', 'review'], summary: 'Test fix.' },
    },
    defaultOptions: undefined,
    check(context) {
      for (const artifact of context.artifacts) options.check(context, artifact);
    },
  });
}
