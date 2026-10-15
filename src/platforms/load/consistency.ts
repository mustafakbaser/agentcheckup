/**
 * Load plans and findings must agree (docs/adr/0007, decision 2). Both directions:
 *
 * - Every skip a plan attributes to a rule (`SkippedLoad.ruleId`) has an unsuppressed finding of
 *   that rule on that file that lists the plan's agent.
 * - Every finding of a rule whose findings mean "this agent skips the file" ({@link SKIP_RULES})
 *   has a matching skip in a plan of that agent where the file is in scope. Every other finding
 *   in the `loading` category is listed in {@link LOADS_ANYWAY} with the reason it is not a skip.
 *
 * Where the two cannot match one to one, a named allowance says why ({@link ALLOWANCES}); each
 * has a test in test/platforms/load/consistency.test.ts. Nothing else is ignored.
 *
 * The check expects findings of a scan with default severities and no inline suppressions
 * (`--untrusted`), and the plans of `matrixPlans`, which put every file in scope of some plan.
 * test/platforms/load/consistency.test.ts runs it on fixtures and generated snapshots, and
 * `scripts/corpus/run.ts --consistency` on the corpus. Pure.
 */
import { compareStrings } from '../../core/compare.js';
import type { Finding } from '../../core/types.js';
import { skillLocation } from '../skills.js';
import { codexSeesBlank, isBlank } from './codex-text.js';
import type { ContextAgent, LoadPlan, SkipCode, SkippedLoad } from './types.js';
import type { LoadView } from './view.js';

/** A rule whose findings mean that `agent` skips the file, with the skip codes plans use. */
export interface SkipRule {
  readonly ruleId: string;
  readonly agent: ContextAgent;
  readonly codes: readonly SkipCode[];
  /**
   * The finding sits on the file that hides the skipped one and names it in `related`: the
   * override for a shadowed AGENTS.md, the cut file for one dropped after the Codex budget.
   */
  readonly onHidingFile?: boolean;
  /** A cut counts as the skip: a plan entry with `truncated` matches the finding too. */
  readonly truncates?: boolean;
}

/** Which findings mean which skips. A rule appears once per agent. */
export const SKIP_RULES: readonly SkipRule[] = [
  // Claude Code
  {
    ruleId: 'instr/agents-md-ignored-by-claude',
    agent: 'claude-code',
    codes: ['shadowed-by-claude-md'],
  },
  { ruleId: 'instr/filename-case', agent: 'claude-code', codes: ['case-mismatch'] },
  { ruleId: 'instr/import-depth', agent: 'claude-code', codes: ['import-too-deep'] },
  { ruleId: 'instr/import-outside-root', agent: 'claude-code', codes: ['import-outside-root'] },
  { ruleId: 'instr/import-unresolved', agent: 'claude-code', codes: ['import-unresolved'] },
  { ruleId: 'instr/subagent-invalid', agent: 'claude-code', codes: ['invalid-subagent'] },
  { ruleId: 'hooks/unknown-event', agent: 'claude-code', codes: ['unknown-event'] },
  { ruleId: 'json/invalid-syntax', agent: 'claude-code', codes: ['invalid-json'] },
  { ruleId: 'mcp/url-without-type', agent: 'claude-code', codes: ['url-without-type'] },
  // Codex
  {
    ruleId: 'instr/codex-size-budget',
    agent: 'codex',
    codes: ['over-byte-budget'],
    onHidingFile: true,
    truncates: true,
  },
  { ruleId: 'instr/empty-file', agent: 'codex', codes: ['blank-file'] },
  { ruleId: 'instr/filename-case', agent: 'codex', codes: ['case-mismatch'] },
  {
    ruleId: 'instr/override-shadows-agents-md',
    agent: 'codex',
    codes: ['shadowed-by-override', 'empty-override'],
    onHidingFile: true,
  },
  { ruleId: 'skill/description-missing', agent: 'codex', codes: ['no-description'] },
  { ruleId: 'skill/field-type', agent: 'codex', codes: ['invalid-frontmatter'] },
  { ruleId: 'skill/frontmatter-bom', agent: 'codex', codes: ['bom'] },
  { ruleId: 'skill/frontmatter-invalid', agent: 'codex', codes: ['invalid-frontmatter'] },
  { ruleId: 'skill/frontmatter-missing', agent: 'codex', codes: ['no-frontmatter'] },
  { ruleId: 'skill/name-format', agent: 'codex', codes: ['invalid-frontmatter'] },
  { ruleId: 'hooks/unknown-event', agent: 'codex', codes: ['unknown-event'] },
  { ruleId: 'json/invalid-syntax', agent: 'codex', codes: ['invalid-json'] },
  // Cursor
  { ruleId: 'cursor/md-file-ignored', agent: 'cursor', codes: ['not-mdc'] },
  { ruleId: 'instr/empty-file', agent: 'cursor', codes: ['blank-file'] },
  { ruleId: 'instr/filename-case', agent: 'cursor', codes: ['case-mismatch'] },
  { ruleId: 'hooks/unknown-event', agent: 'cursor', codes: ['unknown-event'] },
  { ruleId: 'json/invalid-syntax', agent: 'cursor', codes: ['invalid-json'] },
];

/**
 * Findings in the `loading` category that do not mean the agent skips the file: the plan loads
 * it, and the finding is about what it gets or when.
 */
export const LOADS_ANYWAY: readonly {
  readonly ruleId: string;
  readonly agents: readonly ContextAgent[];
  readonly reason: string;
}[] = [
  {
    ruleId: 'instr/encoding',
    agents: ['claude-code', 'codex', 'cursor'],
    reason: 'The agent reads the file; the text arrives garbled.',
  },
  {
    ruleId: 'instr/symlink-materialized',
    agents: ['claude-code', 'codex', 'cursor'],
    reason: 'The agent reads the stored link target as the file content.',
  },
  {
    ruleId: 'instr/empty-file',
    agents: ['claude-code'],
    reason: 'Claude Code loads the file; it adds no instructions. The plan shows its size.',
  },
  {
    ruleId: 'instr/claude-rule-frontmatter',
    agents: ['claude-code'],
    reason: 'Claude Code loads the rule; the finding is about when (its `paths`).',
  },
  {
    ruleId: 'settings/ignored-permission-mode',
    agents: ['claude-code'],
    reason: 'A setting Claude Code ignores, not a file it skips.',
  },
  {
    ruleId: 'settings/plugin-manifest',
    agents: ['claude-code'],
    reason: 'Plugins load once installed; plans list them as a hidden scope.',
  },
  {
    ruleId: 'skill/duplicate-name',
    agents: ['claude-code', 'codex'],
    reason: 'Both skills are listed; the finding is about which one a name reaches.',
  },
  {
    ruleId: 'skill/description-missing',
    agents: ['claude-code', 'cursor'],
    reason: 'The agent lists the skill without a description.',
  },
  {
    ruleId: 'skill/frontmatter-bom',
    agents: ['claude-code'],
    reason: 'Claude Code lists the skill as one without frontmatter.',
  },
  {
    ruleId: 'skill/frontmatter-invalid',
    agents: ['claude-code', 'cursor'],
    reason: 'The agent lists the skill without the fields it could not read.',
  },
  {
    ruleId: 'skill/frontmatter-missing',
    agents: ['claude-code'],
    reason: 'Claude Code lists the skill, named after its directory.',
  },
  {
    ruleId: 'cursor/legacy-cursorrules',
    agents: ['cursor'],
    reason: 'Cursor still reads .cursorrules; the finding recommends moving it.',
  },
  {
    ruleId: 'cursor/rule-never-applied',
    agents: ['cursor'],
    reason: 'The rule loads only when @-mentioned: a `manual` entry.',
  },
];

/** Most related locations one instr/codex-size-budget finding lists (MAX_RELATED there). */
export const CODEX_BUDGET_MAX_RELATED = 20;

/**
 * The documented exceptions. Each has a test in test/platforms/load/consistency.test.ts that
 * shows the mismatch it accounts for.
 */
export const ALLOWANCES = {
  /**
   * Skips that no rule reports, so they carry no `ruleId` (U3). `rule`, when set, is the rule that
   * reports the same skip where it judges the file; the check then also requires that it did not.
   */
  skipWithoutRule: [
    {
      agent: 'claude-code',
      code: 'over-byte-budget',
      reason: 'A file over 4 MiB: no rule reports it; the walker does not read such files.',
    },
    {
      agent: 'claude-code',
      code: 'shadowed-by-claude-md',
      rule: 'instr/agents-md-ignored-by-claude',
      reason:
        'The rule leaves alone an AGENTS.md whose instructions Claude Code reads anyway (a CLAUDE.md that is a symlink to it or a copy of it) and one in a configuration, skill or template folder, and it judges each AGENTS.md from its own directory: a session started deeper can add the CLAUDE.md that shadows it.',
    },
    {
      agent: 'claude-code',
      code: 'import-unresolved',
      rule: 'instr/import-unresolved',
      reason:
        'The import rules do not judge files of a session started in a template or example folder: such files resolve imports in the projects they are copied into.',
    },
    {
      agent: 'claude-code',
      code: 'import-outside-root',
      rule: 'instr/import-outside-root',
      reason:
        'The import rules do not judge files of a session started in a template or example folder: such files resolve imports in the projects they are copied into.',
    },
    {
      agent: 'claude-code',
      code: 'import-too-deep',
      rule: 'instr/import-depth',
      reason:
        'instr/import-depth does not judge a chain through a file agentcheckup did not read; the plan still stops after four hops.',
    },
  ] satisfies readonly {
    readonly agent: ContextAgent;
    readonly code: SkipCode;
    readonly rule?: string;
    readonly reason: string;
  }[],
  /**
   * instr/codex-size-budget lists at most {@link CODEX_BUDGET_MAX_RELATED} related files, so a
   * dropped file past that count has no finding that names it. Allowed when the plan's chain has a
   * finding of the rule with a full related list.
   */
  relatedCap: 'codex-size-budget-related-cap',
  /**
   * An AGENTS.md that holds only a byte order mark (U4): instr/empty-file reports it empty, but
   * Codex keeps U+FEFF and reads the file, so its plan has an entry, not a skip.
   */
  bomOnlyAgentsMd: 'bom-only-agents-md',
  /**
   * A SKILL.md outside the agent's skills directories, in a plugin or a skill collection: the
   * skill rules judge it for the agents that load it once installed, but plans cover what the
   * repository loads as it is (ADR 0003), so no plan mentions it.
   */
  installedSkill: 'installed-skill',
  /**
   * The agent skips the file for several reasons that different rules report, such as a Codex
   * skill without a description whose name is not text. The agent stops at the first reason in
   * the order it reads the file, and the plan records that one with its rule, so the other
   * rules' findings match that skip.
   */
  firstSkipReason: 'first-skip-reason',
} as const;

export type AllowanceName =
  | 'skip-without-rule'
  | typeof ALLOWANCES.relatedCap
  | typeof ALLOWANCES.bomOnlyAgentsMd
  | typeof ALLOWANCES.installedSkill
  | typeof ALLOWANCES.firstSkipReason;

export type MismatchKind =
  /** A skip names a rule, and no unsuppressed finding of it on that file lists the agent. */
  | 'skip-without-finding'
  /** A skip without a rule id that no allowance covers. */
  | 'skip-without-rule'
  /** A skip without a rule id, although the rule that reports such skips reports this one. */
  | 'rule-not-cited'
  /** A skip names a rule the mapping table does not list for this agent and code. */
  | 'unmapped-skip'
  /** A finding means a skip, and no plan of the agent has it, although one covers the file. */
  | 'finding-without-skip'
  /** A finding means a skip, and no plan of the agent mentions the file at all. */
  | 'finding-not-planned'
  /** A loading finding whose rule is in neither table for this agent. */
  | 'unmapped-finding';

export interface Mismatch {
  readonly kind: MismatchKind;
  /** `''` for a skip without a rule id. */
  readonly ruleId: string;
  readonly agent: ContextAgent;
  readonly path: string;
  /** Working directory of the plan, for mismatches found on a plan. */
  readonly cwd?: string;
  readonly code?: SkipCode;
}

export interface ConsistencyInput {
  /** Every finding of the scan; suppressed ones are ignored. */
  readonly findings: readonly Finding[];
  /** Plans built on the scan's analysis, after its rules ran. */
  readonly plans: readonly LoadPlan[];
  readonly view: Pick<LoadView, 'index'>;
}

export interface ConsistencyOptions {
  /** Allowances to turn off, to show what each one accounts for. */
  readonly without?: readonly AllowanceName[];
}

export interface ConsistencyReport {
  /** Sorted by rule id, kind, agent, path. */
  readonly mismatches: readonly Mismatch[];
  /** How often each allowance applied. */
  readonly allowed: Readonly<Partial<Record<AllowanceName, number>>>;
}

/** Checks both directions. See the module comment. */
export function checkConsistency(
  input: ConsistencyInput,
  options: ConsistencyOptions = {},
): ConsistencyReport {
  return new Checker(input, options).run();
}

function compareMismatches(a: Mismatch, b: Mismatch): number {
  return (
    compareStrings(a.ruleId, b.ruleId) ||
    compareStrings(a.kind, b.kind) ||
    compareStrings(a.agent, b.agent) ||
    compareStrings(a.path, b.path) ||
    compareStrings(a.cwd ?? '', b.cwd ?? '') ||
    compareStrings(a.code ?? '', b.code ?? '')
  );
}

class Checker {
  readonly #input: ConsistencyInput;
  readonly #off: ReadonlySet<AllowanceName>;
  readonly #findings: readonly Finding[];
  readonly #mismatches: Mismatch[] = [];
  readonly #allowed: Partial<Record<AllowanceName, number>> = {};

  constructor(input: ConsistencyInput, options: ConsistencyOptions) {
    this.#input = input;
    this.#off = new Set(options.without ?? []);
    this.#findings = input.findings.filter((finding) => finding.suppressed === undefined);
  }

  run(): ConsistencyReport {
    for (const plan of this.#input.plans) {
      for (const skip of plan.skipped) this.#checkSkip(plan, skip);
    }
    const agents = new Set(this.#input.plans.map((plan) => plan.agent));
    for (const finding of this.#findings) {
      for (const agent of finding.platforms) {
        if (agents.has(agent as ContextAgent)) this.#checkFinding(finding, agent as ContextAgent);
      }
    }
    const seen = new Set<string>();
    const mismatches = this.#mismatches.filter((mismatch) => {
      const key = JSON.stringify(mismatch);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { mismatches: mismatches.sort(compareMismatches), allowed: this.#allowed };
  }

  /** The path of the artifact a plan path reaches: symlink aliases resolve to the real file. */
  #real(path: string): string {
    return this.#input.view.index.get(path)?.path ?? path;
  }

  #allow(name: AllowanceName): boolean {
    if (this.#off.has(name)) return false;
    this.#allowed[name] = (this.#allowed[name] ?? 0) + 1;
    return true;
  }

  #findingsOf(ruleId: string, agent: ContextAgent): Finding[] {
    return this.#findings.filter(
      (finding) => finding.ruleId === ruleId && finding.platforms.includes(agent),
    );
  }

  // Plan -> finding ---------------------------------------------------------------------------

  #checkSkip(plan: LoadPlan, skip: SkippedLoad): void {
    const { agent, cwd } = plan;
    const path = this.#real(skip.path);
    const at = { agent, path, cwd, code: skip.code };
    if (skip.ruleId === undefined) {
      if (skip.code === 'not-read') return;
      const allowance = ALLOWANCES.skipWithoutRule.find(
        (item) => item.agent === agent && item.code === skip.code,
      );
      if (allowance === undefined || !this.#allow('skip-without-rule')) {
        this.#mismatches.push({ kind: 'skip-without-rule', ruleId: '', ...at });
        return;
      }
      const rule = 'rule' in allowance ? allowance.rule : undefined;
      if (rule !== undefined && this.#findingsOf(rule, agent).some((f) => f.path === path)) {
        this.#mismatches.push({ kind: 'rule-not-cited', ruleId: rule, ...at });
      }
      return;
    }

    const ruleId = skip.ruleId;
    const mapping = SKIP_RULES.find(
      (item) => item.ruleId === ruleId && item.agent === agent && item.codes.includes(skip.code),
    );
    if (mapping === undefined) {
      this.#mismatches.push({ kind: 'unmapped-skip', ruleId, ...at });
      return;
    }
    const findings = this.#findingsOf(ruleId, agent);
    if (findings.some((finding) => finding.path === path)) return;
    if (
      mapping.onHidingFile === true &&
      findings.some((finding) => finding.related.some((related) => related.path === path))
    ) {
      return;
    }
    if (
      ruleId === 'instr/codex-size-budget' &&
      this.#fullRelatedListIn(plan, findings) &&
      this.#allow(ALLOWANCES.relatedCap)
    ) {
      return;
    }
    this.#mismatches.push({ kind: 'skip-without-finding', ruleId, ...at });
  }

  /** A finding on a file of the plan's chain whose related list reached the cap. */
  #fullRelatedListIn(plan: LoadPlan, findings: readonly Finding[]): boolean {
    const chain = new Set([
      ...plan.entries.map((entry) => this.#real(entry.path)),
      ...plan.skipped.map((skip) => this.#real(skip.path)),
    ]);
    return findings.some(
      (finding) => chain.has(finding.path) && finding.related.length >= CODEX_BUDGET_MAX_RELATED,
    );
  }

  // Finding -> plan ---------------------------------------------------------------------------

  #checkFinding(finding: Finding, agent: ContextAgent): void {
    const { ruleId, path } = finding;
    const mapping = SKIP_RULES.find((item) => item.ruleId === ruleId && item.agent === agent);
    if (mapping === undefined) {
      if (finding.category !== 'loading') return;
      const known = LOADS_ANYWAY.some(
        (item) => item.ruleId === ruleId && item.agents.includes(agent),
      );
      if (!known) this.#mismatches.push({ kind: 'unmapped-finding', ruleId, agent, path });
      return;
    }
    // instr/codex-size-budget also warns near the limit, before anything is cut.
    if (ruleId === 'instr/codex-size-budget' && finding.severity !== 'error') return;

    const plans = this.#input.plans.filter((plan) => plan.agent === agent);
    const targets = new Set([
      path,
      ...(mapping.onHidingFile === true ? finding.related.map((related) => related.path) : []),
    ]);
    const skipped = plans.some((plan) =>
      plan.skipped.some(
        (skip) =>
          skip.ruleId === ruleId &&
          mapping.codes.includes(skip.code) &&
          targets.has(this.#real(skip.path)),
      ),
    );
    if (skipped) return;
    const skippedForAnother = plans.some((plan) =>
      plan.skipped.some(
        (skip) =>
          this.#real(skip.path) === path &&
          SKIP_RULES.some(
            (other) =>
              other.ruleId === skip.ruleId &&
              other.agent === agent &&
              other.codes.includes(skip.code),
          ),
      ),
    );
    if (skippedForAnother && this.#allow(ALLOWANCES.firstSkipReason)) return;
    const entries = plans.flatMap((plan) =>
      plan.entries.filter((entry) => this.#real(entry.path) === path),
    );
    if (mapping.truncates === true && entries.some((entry) => entry.truncated !== undefined)) {
      return;
    }
    if (
      ruleId === 'instr/empty-file' &&
      agent === 'codex' &&
      entries.length > 0 &&
      this.#bomOnly(path) &&
      this.#allow(ALLOWANCES.bomOnlyAgentsMd)
    ) {
      return;
    }

    const mentions = plans.map((plan) => this.#mention(plan, path));
    // Loaded, skipped for another reason, or not analyzed: the plan covers the file.
    if (entries.length > 0 || mentions.includes('skipped') || mentions.includes('incomplete')) {
      this.#mismatches.push({ kind: 'finding-without-skip', ruleId, agent, path });
      return;
    }
    // Out of scope of every plan that mentions it: no plan claims anything about it.
    if (mentions.includes('out-of-scope')) return;
    if (this.#installedSkill(path, agent) && this.#allow(ALLOWANCES.installedSkill)) return;
    this.#mismatches.push({ kind: 'finding-not-planned', ruleId, agent, path });
  }

  /** A skill that no skills directory of `agent` holds, through any path that reaches it. */
  #installedSkill(path: string, agent: ContextAgent): boolean {
    const artifact = this.#input.view.index.get(path);
    if (artifact?.kind !== 'skill') return false;
    const caseMismatch = artifact.caseMismatch !== undefined;
    return [artifact.path, ...artifact.aliases].every(
      (reached) => skillLocation(reached, caseMismatch)?.platforms.has(agent) !== true,
    );
  }

  /** How a plan mentions a file, if it does. Entries are checked by the caller. */
  #mention(plan: LoadPlan, path: string): 'skipped' | 'incomplete' | 'out-of-scope' | undefined {
    if (plan.skipped.some((skip) => this.#real(skip.path) === path)) return 'skipped';
    const incomplete = plan.incomplete.some((item) => {
      const colon = item.indexOf(':');
      return colon >= 0 && this.#real(item.slice(colon + 1)) === path;
    });
    if (incomplete) return 'incomplete';
    if (plan.outOfScope.some((item) => this.#real(item.path) === path)) return 'out-of-scope';
    return undefined;
  }

  /** An instruction file that holds only a byte order mark and whitespace, which Codex reads. */
  #bomOnly(path: string): boolean {
    const artifact = this.#input.view.index.get(path);
    return (
      artifact !== undefined &&
      artifact.decoded.hasBom &&
      isBlank(artifact.decoded.text) &&
      !codexSeesBlank(artifact.file.bytes)
    );
  }
}

/** Mismatches grouped by rule id (`''` for skips without one), in rule order. */
export function mismatchesByRule(
  mismatches: readonly Mismatch[],
): Map<string, readonly Mismatch[]> {
  const groups = new Map<string, Mismatch[]>();
  for (const mismatch of [...mismatches].sort(compareMismatches)) {
    const group = groups.get(mismatch.ruleId) ?? [];
    group.push(mismatch);
    groups.set(mismatch.ruleId, group);
  }
  return groups;
}
