/**
 * Hand-built ScanResults for formatter tests. Independent of rules and the engine on purpose:
 * formatter snapshots must only change when a formatter changes.
 */
import type { ScanResult } from '../../src/core/engine.js';
import type { CategoryTally, ScoreReport } from '../../src/core/score.js';
import {
  CATEGORIES,
  type Category,
  type Finding,
  type RuleMeta,
  type Severity,
} from '../../src/core/types.js';

const SOURCE = {
  title: 'Claude Code memory documentation',
  url: 'https://docs.anthropic.com/en/docs/claude-code/memory',
  checked: '2026-10-01',
  status: 'verified',
} as const;

export function rule(
  id: string,
  category: Category,
  severity: Severity,
  overrides: Partial<RuleMeta> = {},
): RuleMeta {
  return {
    id,
    title: `Title of ${id}`,
    rationale: `Why \`${id}\` matters. See [the docs](https://example.com/${id}).`,
    category,
    severity,
    appliesTo: ['claude-md', 'agents-md'],
    platforms: ['claude-code', 'codex'],
    sources: [SOURCE],
    since: '2026.10',
    ...overrides,
  };
}

export const RULES = {
  brokenImport: rule('instructions/broken-import', 'correctness', 'error', {
    title: 'Imported file does not exist',
    rationale:
      'Claude Code silently skips `@path` imports that do not resolve, so the instructions in them never load. See [memory imports](https://docs.anthropic.com/en/docs/claude-code/memory#imports).',
    platforms: ['claude-code'],
  }),
  fileTooLarge: rule('budget/file-too-large', 'budget', 'warn', {
    title: 'Instruction file exceeds the size budget',
    rationale: 'Large files crowd out the conversation. **Codex** truncates `AGENTS.md` at 32 KiB.',
  }),
  conflictingActivation: rule('cursor/conflicting-activation', 'loading', 'warn', {
    title: 'Rule sets both alwaysApply and globs',
    appliesTo: ['cursor-rule'],
    platforms: ['cursor'],
    fixable: 'safe',
  }),
  hiddenUnicode: rule('risk/hidden-unicode', 'risk', 'error', {
    title: 'Instructions contain invisible Unicode',
    platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini', 'windsurf', 'cline'],
  }),
  remoteScript: rule('risk/remote-script', 'risk', 'warn', {
    title: 'Instructions pipe a remote script into a shell',
  }),
  claudeOnlyImport: rule('portability/claude-only-import', 'portability', 'info', {
    title: '@import syntax is specific to Claude Code',
  }),
  vague: rule('clarity/missing-overview', 'clarity', 'info', {
    title: 'File has no project overview',
  }),
  unusedDirective: rule('directive/unused', 'correctness', 'warn', {
    title: 'Suppression directive does not suppress anything',
  }),
} as const;

export function finding(
  meta: RuleMeta,
  path: string,
  message: string,
  overrides: Partial<Finding> = {},
): Finding {
  return {
    ruleId: meta.id,
    severity: meta.severity,
    category: meta.category,
    message,
    path,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    related: [],
    platforms: meta.platforms,
    fingerprint: '00c0ffee15bad5:1',
    ...overrides,
  };
}

export function at(
  line: number,
  column: number,
  endLine = line,
  endColumn = column,
): Finding['range'] {
  return { start: { line, column }, end: { line: endLine, column: endColumn } };
}

function tallies(findings: readonly Finding[]): Record<Category, CategoryTally> {
  const result = Object.fromEntries(
    CATEGORIES.map((category) => [category, { errors: 0, warnings: 0, infos: 0 }]),
  ) as Record<Category, { errors: number; warnings: number; infos: number }>;
  for (const item of findings) {
    if (item.suppressed) continue;
    const tally = result[item.category];
    if (item.severity === 'error') tally.errors++;
    else if (item.severity === 'warn') tally.warnings++;
    else tally.infos++;
  }
  return result;
}

interface ResultInput {
  readonly artifacts?: ScanResult['artifacts'];
  readonly findings?: readonly Finding[];
  readonly score?: Pick<ScoreReport, 'score' | 'grade' | 'capped'>;
  readonly rules?: readonly RuleMeta[];
  readonly skipped?: ScanResult['skipped'];
  readonly unresolvedSymlinks?: ScanResult['unresolvedSymlinks'];
  readonly ruleFailures?: ScanResult['ruleFailures'];
  readonly configWarnings?: ScanResult['configWarnings'];
}

/** A consistent ScanResult: summary and category tallies are derived from the findings. */
export function makeResult(input: ResultInput = {}): ScanResult {
  const findings = input.findings ?? [];
  const artifacts = input.artifacts ?? [];
  const active = findings.filter((item) => !item.suppressed);
  const score = input.score ?? { score: null, grade: null, capped: false };
  return {
    schemaVersion: 1,
    tool: { name: 'agentcheckup', version: '1.4.0' },
    ruleset: '2026.10',
    targets: ['claude-code', 'cline', 'codex', 'copilot', 'cursor', 'gemini', 'windsurf'],
    artifacts,
    findings,
    score: {
      formula: 1,
      ...score,
      categories: tallies(findings),
      artifacts:
        score.score === null
          ? []
          : artifacts.map((artifact) => ({ path: artifact.path, score: 100 })),
    },
    summary: {
      errors: active.filter((item) => item.severity === 'error').length,
      warnings: active.filter((item) => item.severity === 'warn').length,
      infos: active.filter((item) => item.severity === 'info').length,
      suppressed: findings.length - active.length,
    },
    rules: input.rules ?? [],
    skipped: input.skipped ?? [],
    unresolvedSymlinks: input.unresolvedSymlinks ?? [],
    ruleFailures: input.ruleFailures ?? [],
    configWarnings: input.configWarnings ?? [],
  };
}

const ARTIFACTS: ScanResult['artifacts'] = [
  { path: '.cursor/rules/style.mdc', kind: 'cursor-rule', readers: ['cursor'] },
  { path: 'AGENTS.md', kind: 'agents-md', readers: ['codex', 'cursor', 'copilot', 'gemini'] },
  { path: 'CLAUDE.md', kind: 'claude-md', readers: ['claude-code'] },
  { path: 'skills/deploy/SKILL.md', kind: 'skill', readers: ['claude-code', 'codex'] },
];

/** Two clean files. */
export const cleanResult: ScanResult = makeResult({
  artifacts: ARTIFACTS.slice(1, 3),
  score: { score: 100, grade: 'A', capped: false },
  rules: [RULES.brokenImport, RULES.fileTooLarge],
});

/** Nothing to check: score null. */
export const emptyResult: ScanResult = makeResult();

/** Everything at once: severities, categories, suppressions, related locations, notices. */
export const richResult: ScanResult = makeResult({
  artifacts: ARTIFACTS,
  score: { score: 49, grade: 'F', capped: true },
  rules: [
    RULES.fileTooLarge,
    RULES.vague,
    RULES.conflictingActivation,
    RULES.unusedDirective,
    RULES.brokenImport,
    RULES.claudeOnlyImport,
    RULES.hiddenUnicode,
    RULES.remoteScript,
  ],
  findings: [
    finding(
      RULES.conflictingActivation,
      '.cursor/rules/style.mdc',
      '`alwaysApply: true` overrides `globs`, so the rule loads in every chat.',
      {
        range: at(2, 1, 2, 18),
        fingerprint: '1a2b3c4d5e6f70:1',
        fix: {
          description: 'Remove `globs`',
          safety: 'safe',
          edits: [{ offset: 4, length: 14, text: '' }],
        },
      },
    ),
    finding(RULES.vague, 'AGENTS.md', 'Start with a one-paragraph project overview.', {
      fingerprint: '2b3c4d5e6f7081:1',
    }),
    finding(RULES.hiddenUnicode, 'AGENTS.md', 'Line contains 3 invisible Unicode tag characters.', {
      range: at(12, 3, 12, 9),
      fingerprint: '3c4d5e6f708192:1',
    }),
    finding(
      RULES.remoteScript,
      'AGENTS.md',
      'Pipes a remote script into a shell: curl https://example.com/install.sh | sh',
      {
        range: at(30, 1, 30, 46),
        fingerprint: '4d5e6f708192a3:1',
        suppressed: { kind: 'inline', reason: 'Documented install step, reviewed 2026-10' },
      },
    ),
    finding(
      RULES.fileTooLarge,
      'CLAUDE.md',
      'File is 52,310 characters; Claude Code works best under 40,000.',
      { fingerprint: '5e6f708192a3b4:1' },
    ),
    finding(RULES.brokenImport, 'CLAUDE.md', 'Imported file docs/missing.md does not exist.', {
      range: at(3, 5, 3, 22),
      fingerprint: '6f708192a3b4c5:1',
      related: [{ path: 'docs/', message: 'Closest existing directory' }],
    }),
    finding(
      RULES.claudeOnlyImport,
      'CLAUDE.md',
      '@-imports are only read by Claude Code; Codex sees the literal text.',
      {
        range: at(140, 1, 140, 30),
        fingerprint: '708192a3b4c5d6:1',
        related: [
          { path: 'AGENTS.md', message: 'Codex reads this file instead', range: at(1, 1) },
          { path: 'docs/a.md', message: 'Imported here', range: at(4, 1, 4, 12) },
          { path: 'docs/b.md', message: 'Imported here', range: at(5, 1, 5, 12) },
          { path: 'docs/c.md', message: 'Imported here', range: at(6, 1, 6, 12) },
        ],
      },
    ),
    finding(
      RULES.unusedDirective,
      'skills/deploy/SKILL.md',
      'No risk/remote-script finding to suppress here.',
      {
        range: at(2, 1, 2, 60),
        fingerprint: '8192a3b4c5d6e7:1',
        suppressed: { kind: 'config', reason: 'Generated file' },
      },
    ),
  ],
  skipped: [
    { path: 'big/AGENTS.md', reason: 'too-large', size: 2_400_000 },
    { path: 'assets/CLAUDE.md', reason: 'binary' },
    { path: 'vendor/a/AGENTS.md', reason: 'file-limit' },
    { path: 'vendor/b/AGENTS.md', reason: 'file-limit' },
  ],
  unresolvedSymlinks: [
    { path: 'GEMINI.md', target: '../../shared/GEMINI.md', problem: 'outside-root' },
    { path: '.github/copilot-instructions.md', target: 'missing.md', problem: 'broken' },
  ],
  ruleFailures: [
    {
      ruleId: 'mcp/unknown-server-field',
      message: "Cannot read properties of undefined (reading 'type')",
    },
  ],
  configWarnings: ['Unknown rule "instructions/typo-rule" in configuration.'],
});
