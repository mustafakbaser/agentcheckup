/**
 * Load plans and findings must agree (docs/adr/0007, decision 2). Both directions:
 *
 * - Every skip a plan attributes to a rule (`SkippedLoad.ruleId`) has an unsuppressed finding of
 *   that rule on that file that lists the plan's agent.
 * - Every finding of a rule whose findings mean "this agent skips the file" ({@link SKIP_RULES})
 *   has a matching skip in a plan of that agent where the file is in scope. Every other finding
 *   in the `loading` category is listed in {@link LOADS_ANYWAY} with the reason it is not a skip.
 *
 * Findings name platforms, plans name agents. The agents of one platform, such as the three
 * Copilot surfaces, form a group: a finding of the platform matches a skip in any of the group's
 * plans ({@link CONTEXT_PLATFORM}).
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
import { type Finding, type PlatformId, SEVERITIES, type Severity } from '../../core/types.js';
import { descriptionState } from '../codex-skills.js';
import { skillLocation } from '../skills.js';
import { codexSeesBlank, isBlank } from './codex-text.js';
import {
  ALL_CONTEXT_AGENTS,
  CONTEXT_PLATFORM,
  type ContextAgent,
  type LoadPlan,
  type SkipCode,
  type SkippedLoad,
} from './types.js';
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
  /**
   * Only findings of this severity or higher mean the skip. Lower ones are advice about a file
   * the agent loads, such as a Copilot instructions file with only a `description`, which VS Code
   * loads on demand, or an AGENTS.md chain that is close to Codex's byte budget.
   */
  readonly minSeverity?: Severity;
}

/** The Copilot surfaces, which share the `copilot` platform. */
const COPILOT_SURFACES = ['copilot-cli', 'copilot-vscode', 'copilot-cloud'] as const;

/** The agents that came after Claude Code, Codex and Cursor, which share several mappings. */
const NEWER_AGENTS = [...COPILOT_SURFACES, 'gemini', 'windsurf', 'cline'] as const;

/** One mapping of `ruleId` to `codes` for each of `agents`. */
function skipsFor(
  agents: readonly ContextAgent[],
  ruleId: string,
  codes: readonly SkipCode[],
): SkipRule[] {
  return agents.map((agent) => ({ ruleId, agent, codes }));
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
  // instr/import-depth also reports import cycles, as information: the file is loaded.
  {
    ruleId: 'instr/import-depth',
    agent: 'claude-code',
    codes: ['import-too-deep'],
    minSeverity: 'warn',
  },
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
    // It also warns near the limit, before anything is cut.
    minSeverity: 'error',
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
  // Its warnings are about server entries, whose effect is not verified.
  { ruleId: 'codex/config-invalid', agent: 'codex', codes: ['invalid-toml'], minSeverity: 'error' },
  // Cursor
  { ruleId: 'cursor/md-file-ignored', agent: 'cursor', codes: ['not-mdc'] },
  { ruleId: 'instr/empty-file', agent: 'cursor', codes: ['blank-file'] },
  { ruleId: 'instr/filename-case', agent: 'cursor', codes: ['case-mismatch'] },
  { ruleId: 'hooks/unknown-event', agent: 'cursor', codes: ['unknown-event'] },
  { ruleId: 'json/invalid-syntax', agent: 'cursor', codes: ['invalid-json'] },
  // GitHub Copilot: the CLI, VS Code and the cloud agent. The cloud agent applies a path-specific
  // file only through `applyTo`; a description-only file (info) is one VS Code loads on demand.
  ...skipsFor(COPILOT_SURFACES, 'copilot/instructions-misplaced', [
    'wrong-location',
    'case-mismatch',
  ]),
  {
    ruleId: 'copilot/apply-to',
    agent: 'copilot-cloud',
    codes: ['no-apply-to'],
    minSeverity: 'warn',
  },
  ...skipsFor(COPILOT_SURFACES, 'json/invalid-syntax', ['invalid-json']),
  // VS Code does not load a skill whose name is invalid or differs from its directory.
  { ruleId: 'skill/name-dir-mismatch', agent: 'copilot-vscode', codes: ['invalid-frontmatter'] },
  { ruleId: 'skill/name-format', agent: 'copilot-vscode', codes: ['invalid-frontmatter'] },
  // Gemini CLI. instr/import-depth also reports import cycles, as information: the file is loaded.
  {
    ruleId: 'instr/import-depth',
    agent: 'gemini',
    codes: ['import-too-deep'],
    minSeverity: 'warn',
  },
  { ruleId: 'instr/import-outside-root', agent: 'gemini', codes: ['import-outside-root'] },
  { ruleId: 'instr/import-unresolved', agent: 'gemini', codes: ['import-unresolved'] },
  { ruleId: 'hooks/unknown-event', agent: 'gemini', codes: ['unknown-event'] },
  { ruleId: 'json/invalid-syntax', agent: 'gemini', codes: ['invalid-json'] },
  { ruleId: 'skill/description-missing', agent: 'gemini', codes: ['no-description'] },
  // A `+++` or `---js` block, or YAML that is not a mapping; the rule leaves out Gemini CLI for
  // YAML that does not parse, which Gemini CLI reads line by line.
  { ruleId: 'skill/frontmatter-invalid', agent: 'gemini', codes: ['invalid-frontmatter'] },
  { ruleId: 'skill/frontmatter-missing', agent: 'gemini', codes: ['no-frontmatter'] },
  // Without `name` the skill is skipped (error); with an empty one Gemini CLI loads it (warn).
  {
    ruleId: 'skill/name-missing',
    agent: 'gemini',
    codes: ['invalid-frontmatter'],
    minSeverity: 'error',
  },
  // Devin Local
  { ruleId: 'hooks/unknown-event', agent: 'windsurf', codes: ['unknown-event'] },
  // Cline drops a skill at the first problem it meets (src/platforms/cline-skills.ts); each rule
  // names Cline only when its problem is that first one.
  { ruleId: 'skill/frontmatter-invalid', agent: 'cline', codes: ['invalid-frontmatter'] },
  { ruleId: 'skill/name-format', agent: 'cline', codes: ['invalid-frontmatter'] },
  { ruleId: 'skill/description-missing', agent: 'cline', codes: ['invalid-frontmatter'] },
  { ruleId: 'skill/field-type', agent: 'cline', codes: ['invalid-frontmatter'] },
  // Copilot, Gemini CLI, Devin Local and Cline
  ...skipsFor(NEWER_AGENTS, 'instr/empty-file', ['blank-file']),
  ...skipsFor(NEWER_AGENTS, 'instr/filename-case', ['case-mismatch']),
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
    agents: ['claude-code', 'codex', 'cursor', ...NEWER_AGENTS],
    reason: 'The agent reads the file; the text arrives garbled.',
  },
  {
    ruleId: 'instr/symlink-materialized',
    agents: ['claude-code', 'codex', 'cursor', ...NEWER_AGENTS],
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
    ruleId: 'codex/ignored-project-key',
    agents: ['codex'],
    reason: 'A key Codex ignores in a project config file, not a file it skips.',
  },
  {
    ruleId: 'settings/plugin-manifest',
    agents: ['claude-code'],
    reason: 'Plugins load once installed; plans list them as a hidden scope.',
  },
  {
    ruleId: 'skill/duplicate-name',
    agents: ['claude-code', 'codex', 'cursor', ...COPILOT_SURFACES, 'gemini', 'windsurf', 'cline'],
    reason: 'Both skills are listed; the finding is about which one a name reaches.',
  },
  {
    ruleId: 'skill/description-missing',
    agents: ['claude-code', 'cursor', ...COPILOT_SURFACES],
    reason:
      'The agent lists the skill without a description; what Copilot does with such a skill is not documented, so its plans mark the skill unverified.',
  },
  {
    ruleId: 'skill/frontmatter-bom',
    agents: ['claude-code'],
    reason: 'Claude Code lists the skill as one without frontmatter.',
  },
  {
    ruleId: 'skill/frontmatter-invalid',
    agents: ['claude-code', 'cursor', ...COPILOT_SURFACES],
    reason:
      'The agent lists the skill without the fields it could not read. The finding never names Copilot, whose handling is not documented.',
  },
  {
    ruleId: 'skill/frontmatter-invalid',
    agents: ['windsurf'],
    reason:
      'The finding names Devin Local only for a skill that is installed or uploaded on its own, about validators or a check agentcheckup could not finish; Devin Local does not document what it does with frontmatter that does not parse.',
  },
  {
    ruleId: 'skill/frontmatter-missing',
    agents: ['claude-code'],
    reason: 'Claude Code lists the skill, named after its directory.',
  },
  {
    ruleId: 'json/invalid-syntax',
    agents: ['windsurf'],
    reason:
      'Devin Local does not document what it does with a file it cannot parse, so the finding is information and the plan lists the file as not analyzed.',
  },
  {
    ruleId: 'gemini/settings-key-ignored',
    agents: ['gemini'],
    reason: 'A setting Gemini CLI ignores, not a file it skips.',
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
  {
    ruleId: 'copilot/apply-to',
    agents: ['copilot-cli', 'copilot-vscode'],
    reason:
      'The finding is about the cloud agent and code review; the CLI and VS Code load the file through its applyTo or description, or when it is attached.',
  },
];

/**
 * Skip codes no rule reports, so their skips carry no `ruleId` and need no allowance: the agent
 * does not read the file here (`not-read`), a setting in the repository turns it off
 * (`disabled`), the agent prefers another file for the same purpose (`shadowed-by-preferred`),
 * or the file's own settings keep it from applying (`never-active`).
 */
export const UNREPORTED_CODES: ReadonlySet<SkipCode> = new Set<SkipCode>([
  'not-read',
  'disabled',
  'shadowed-by-preferred',
  'never-active',
]);

/** Most related locations one instr/codex-size-budget finding lists (MAX_RELATED there). */
export const CODEX_BUDGET_MAX_RELATED = 20;

/** Agents other than Claude Code that read custom agent files (src/platforms/agent-files.ts). */
const OTHER_SUBAGENT_READERS = [
  'codex',
  'cursor',
  'copilot-cli',
  'copilot-vscode',
  'copilot-cloud',
  'gemini',
  'windsurf',
] as const satisfies readonly ContextAgent[];

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
    {
      agent: 'gemini',
      code: 'import-unresolved',
      rule: 'instr/import-unresolved',
      reason:
        'The import rules do not judge files of a session started in a template or example folder: such files resolve imports in the projects they are copied into.',
    },
    {
      agent: 'gemini',
      code: 'import-outside-root',
      rule: 'instr/import-outside-root',
      reason:
        'The import rules do not judge files of a session started in a template or example folder: such files resolve imports in the projects they are copied into.',
    },
    {
      agent: 'cline',
      code: 'blank-file',
      rule: 'instr/empty-file',
      reason:
        'Cline drops a skill without a body, and no rule reports an empty skill. instr/empty-file does not judge skills, nor a blank rule file of a kind it does not judge, such as .clinerules/SKILL.md.',
    },
    {
      agent: 'cline',
      code: 'invalid-frontmatter',
      reason:
        'Cline drops a workflow whose frontmatter does not parse or has a field of the wrong type, and no rule judges workflows. The skill rules report the same for skills, but leave alone a skill bundled in another one or in a template or example folder.',
    },
    {
      agent: 'gemini',
      code: 'import-too-deep',
      rule: 'instr/import-depth',
      reason:
        'instr/import-depth does not judge a chain through a file agentcheckup did not read, nor a chain from a file in a template or example folder; the plan still stops after five hops.',
    },
    {
      agent: 'gemini',
      code: 'blank-file',
      rule: 'instr/empty-file',
      reason:
        'The rules count Gemini CLI as a reader of a file that the settings of its own directory or one above it name in context.fileName; a session started deeper also reads a blank file above it that only its own settings name.',
    },
    {
      agent: 'gemini',
      code: 'invalid-frontmatter',
      rule: 'skill/frontmatter-invalid',
      reason:
        'YAML that does not give name and description as text: Gemini CLI reads them line by line and skips the skill when a line is missing. skill/frontmatter-invalid reports such YAML for other agents and does not name Gemini CLI, and valid YAML has no rule.',
    },
    ...OTHER_SUBAGENT_READERS.map((agent) => ({
      agent,
      code: 'invalid-subagent' as const,
      reason:
        'No rule judges the custom agent files of agents other than Claude Code: `agentcheckup agents` lists a file the agent drops, with the reason (docs/adr/0013). instr/subagent-invalid judges Claude Code alone.',
    })),
    {
      agent: 'codex',
      code: 'invalid-toml',
      reason:
        'No rule judges Codex agent files: `agentcheckup agents` lists one that is not valid TOML (docs/adr/0013). codex/config-invalid judges config.toml alone.',
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
   * rules' findings match that skip. A skip no rule reports ({@link UNREPORTED_CODES}) is such a
   * first reason too: Cline never reads a nested AGENTS.md, so a finding that it is blank or
   * misnamed matches that `not-read` skip.
   */
  firstSkipReason: 'first-skip-reason',
  /**
   * copilot/apply-to also warns about an `excludeAgent` value that is not documented. Such a
   * warning on a file the cloud agent applies through its `applyTo` is not a skip: the cloud
   * plan's `on-path` (or, for an undocumented `applyTo` form, `unknown`) rule entry shows that
   * `applyTo` is readable.
   */
  excludeAgentValue: 'copilot-exclude-agent-value',
  /**
   * skill/description-missing reports an empty `description` too, and names Gemini CLI, which
   * lists such a skill with no description (the finding says so). Allowed when the plan lists the
   * skill and its description is empty.
   */
  emptySkillDescription: 'empty-skill-description',
} as const;

export type AllowanceName =
  | 'skip-without-rule'
  | typeof ALLOWANCES.relatedCap
  | typeof ALLOWANCES.bomOnlyAgentsMd
  | typeof ALLOWANCES.installedSkill
  | typeof ALLOWANCES.firstSkipReason
  | typeof ALLOWANCES.excludeAgentValue
  | typeof ALLOWANCES.emptySkillDescription;

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
  /** Without `frontmatter`, {@link ALLOWANCES.emptySkillDescription} never applies. */
  readonly view: Pick<LoadView, 'index'> & Partial<Pick<LoadView, 'frontmatter'>>;
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

/** True when `severity` is `minimum` or higher; any severity when there is no minimum. */
function atLeast(severity: Severity, minimum: Severity | undefined): boolean {
  return minimum === undefined || SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf(minimum);
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
    const planned = new Set(this.#input.plans.map((plan) => plan.agent));
    const groups = new Map<PlatformId, ContextAgent[]>();
    for (const agent of ALL_CONTEXT_AGENTS) {
      if (!planned.has(agent)) continue;
      const platform = CONTEXT_PLATFORM[agent];
      groups.set(platform, [...(groups.get(platform) ?? []), agent]);
    }
    for (const finding of this.#findings) {
      for (const platform of finding.platforms) {
        const group = groups.get(platform);
        if (group !== undefined) this.#checkFinding(finding, group);
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
      (finding) => finding.ruleId === ruleId && finding.platforms.includes(CONTEXT_PLATFORM[agent]),
    );
  }

  // Plan -> finding ---------------------------------------------------------------------------

  #checkSkip(plan: LoadPlan, skip: SkippedLoad): void {
    const { agent, cwd } = plan;
    const path = this.#real(skip.path);
    const at = { agent, path, cwd, code: skip.code };
    if (skip.ruleId === undefined) {
      if (UNREPORTED_CODES.has(skip.code)) return;
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

  /**
   * A finding of one platform against the plans of its agents (`group`, in report order). The
   * finding means a skip when a mapping of its rule for one of the agents covers its severity;
   * a skip in any plan of the group then matches it.
   */
  #checkFinding(finding: Finding, group: readonly ContextAgent[]): void {
    const { ruleId, path } = finding;
    const mappings = SKIP_RULES.filter(
      (item) => item.ruleId === ruleId && group.includes(item.agent),
    );
    if (mappings.length === 0) {
      if (finding.category !== 'loading') return;
      const known = LOADS_ANYWAY.some(
        (item) => item.ruleId === ruleId && item.agents.some((agent) => group.includes(agent)),
      );
      const agent = group[0];
      if (!known && agent !== undefined) {
        this.#mismatches.push({ kind: 'unmapped-finding', ruleId, agent, path });
      }
      return;
    }
    const applicable = mappings.filter((item) => atLeast(finding.severity, item.minSeverity));
    const first = applicable[0];
    if (first === undefined) return;
    const { agent } = first;

    const plans = this.#input.plans.filter((plan) => group.includes(plan.agent));
    const mapsSkip = (plan: LoadPlan, skip: SkippedLoad): boolean =>
      applicable.some((item) => item.agent === plan.agent && item.codes.includes(skip.code));
    const targets = new Set([
      path,
      ...(applicable.some((item) => item.onHidingFile === true)
        ? finding.related.map((related) => related.path)
        : []),
    ]);
    const skipped = plans.some((plan) =>
      plan.skipped.some(
        (skip) =>
          skip.ruleId === ruleId && mapsSkip(plan, skip) && targets.has(this.#real(skip.path)),
      ),
    );
    if (skipped) return;
    const skippedForAnother = plans.some((plan) =>
      plan.skipped.some(
        (skip) =>
          this.#real(skip.path) === path &&
          ((skip.ruleId === undefined && UNREPORTED_CODES.has(skip.code)) ||
            SKIP_RULES.some(
              (other) =>
                other.ruleId === skip.ruleId &&
                other.agent === plan.agent &&
                other.codes.includes(skip.code),
            )),
      ),
    );
    if (skippedForAnother && this.#allow(ALLOWANCES.firstSkipReason)) return;
    const entries = plans.flatMap((plan) =>
      plan.entries.filter((entry) => this.#real(entry.path) === path),
    );
    if (
      applicable.some((item) => item.truncates === true) &&
      entries.some((entry) => entry.truncated !== undefined)
    ) {
      return;
    }
    if (
      ruleId === 'skill/description-missing' &&
      group.includes('gemini') &&
      entries.length > 0 &&
      this.#emptyDescription(path) &&
      this.#allow(ALLOWANCES.emptySkillDescription)
    ) {
      return;
    }
    if (
      ruleId === 'instr/empty-file' &&
      group.includes('codex') &&
      entries.length > 0 &&
      this.#bomOnly(path) &&
      this.#allow(ALLOWANCES.bomOnlyAgentsMd)
    ) {
      return;
    }
    if (
      ruleId === 'copilot/apply-to' &&
      plans.some(
        (plan) =>
          plan.agent === 'copilot-cloud' &&
          plan.entries.some(
            (entry) =>
              entry.role === 'rule' &&
              (entry.trigger === 'on-path' || entry.trigger === 'unknown') &&
              this.#real(entry.path) === path,
          ),
      ) &&
      this.#allow(ALLOWANCES.excludeAgentValue)
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
      (reached) =>
        skillLocation(reached, caseMismatch)?.platforms.has(CONTEXT_PLATFORM[agent]) !== true,
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

  /** A skill whose frontmatter has a `description` that is empty. */
  #emptyDescription(path: string): boolean {
    const { index, frontmatter } = this.#input.view;
    const artifact = index.get(path);
    if (artifact === undefined || frontmatter === undefined) return false;
    const result = frontmatter(artifact);
    return result.kind === 'valid' && descriptionState(result.data) === 'empty';
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
