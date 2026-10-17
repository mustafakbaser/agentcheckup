/**
 * What a task tells an agent to do, per rule. A template is trusted text that ships with
 * agentcheckup: it never quotes the repository. Rules without a template get
 * {@link genericTemplate}, built from the rule's rationale and the finding's manual step.
 *
 * Style: `why`, `do` and `constraints` are lower-case fragments. The Markdown output joins `do`
 * and `constraints` with "; " on one line each, as in docs/tasks.md.
 *
 * Guard rules keep a task open while one of their errors or warnings is on the task's file, so
 * an agent cannot close a task by breaking the file another way (deleting the frontmatter to
 * silence a description finding, writing invalid YAML, adding hidden characters).
 */
import { ruleDocsUrl } from '../core/meta.js';
import type { RuleMeta } from '../core/types.js';
import { markdownToPlain, truncate } from '../report/text.js';

/** The part of the file a task shows: a frontmatter value, or the body's heading outline. */
export type ExcerptSpec =
  { readonly kind: 'value'; readonly key: string } | { readonly kind: 'outline' };

export interface TaskTemplate {
  readonly why: string;
  readonly do: readonly string[];
  readonly constraints: readonly string[];
  readonly examples: readonly string[];
  /** What to ask the user before writing. Omitted when the agent may go ahead. */
  readonly askUser?: string;
  readonly guardRules: readonly string[];
  readonly excerpt?: ExcerptSpec;
}

/** Added to every task's constraints: a suppression is the user's decision. */
export const NO_SUPPRESSION = 'do not add agentcheckup-disable comments';

/** Every task: hidden characters written by an agent keep the task open. */
const BASE_GUARDS = ['risk/hidden-unicode'] as const;

/** Edits to a skill's frontmatter must leave it present and valid. */
const SKILL_FRONTMATTER_GUARDS = [
  'skill/frontmatter-missing',
  'skill/frontmatter-invalid',
  'skill/field-type',
  'skill/yaml-portability',
  ...BASE_GUARDS,
] as const;

const DESCRIPTION_GUARDS = [
  ...SKILL_FRONTMATTER_GUARDS,
  'skill/description-missing',
  'skill/description-too-long',
] as const;

const SKILL_BODY_GUARDS = [
  'skill/frontmatter-missing',
  'skill/frontmatter-invalid',
  'skill/broken-reference',
  ...BASE_GUARDS,
] as const;

const INSTRUCTION_GUARDS = ['instr/empty-file', 'instr/import-unresolved', ...BASE_GUARDS] as const;

const DESCRIPTION_CONSTRAINTS = [
  'one line, ≤ 1,024 characters, no XML tags',
  'change only `description`',
  'keep the frontmatter valid YAML: put the value in double quotes when it contains ": " or " #"',
] as const;

const SIZE_CONSTRAINTS = [
  'keep every project-specific command, path and convention, moved or in place',
  'do not use `@path` imports to shorten the file: imported files load at session start too',
] as const;

const SIZE_ASK =
  'show the user what you plan to cut or move, and ask before you write; deleting instructions changes how agents work in this repository';

const TEMPLATES: Readonly<Record<string, TaskTemplate>> = {
  'skill/description-quality': {
    why: 'agents pick a skill by matching the request against its name and description.',
    do: [
      'keep the meaning',
      'say in one sentence what the skill does, with words from the skill body',
      'end with one sentence starting "Use when" that names the requests and keywords that should trigger the skill',
    ],
    constraints: DESCRIPTION_CONSTRAINTS,
    examples: ['Use when the user asks to deploy, ship, promote or roll back the API.'],
    guardRules: DESCRIPTION_GUARDS,
    excerpt: { kind: 'value', key: 'description' },
  },
  'skill/description-missing': {
    why: 'agents decide when to use a skill from its description; Codex skips a skill without one, and Claude Code matches requests against the first line of the body instead.',
    do: [
      'read SKILL.md',
      'add or fill `description` in the frontmatter: one sentence on what the skill does, then one starting "Use when" with the requests that should trigger it',
    ],
    constraints: DESCRIPTION_CONSTRAINTS,
    examples: [
      'description: "Formats SQL migrations to the team style. Use when the user writes, reviews or renames a migration."',
    ],
    guardRules: DESCRIPTION_GUARDS,
  },
  'skill/description-too-long': {
    why: 'skill upload rejects a description over 1,024 characters, and Claude Code cuts its skill listing at 1,536 characters together with `when_to_use`.',
    do: [
      'put the main use case and the "Use when" clause first',
      'shorten the rest to the length the message names',
      'move details into the skill body',
    ],
    constraints: [
      'one line, no XML tags',
      'change only `description`, `when_to_use` and the body of this file',
      'keep the frontmatter valid YAML',
    ],
    examples: [],
    guardRules: DESCRIPTION_GUARDS,
    excerpt: { kind: 'value', key: 'description' },
  },
  'skill/body-too-long': {
    why: 'agents load the whole SKILL.md body when the skill runs; Claude Code keeps it in context on later turns and re-attaches only the first 5,000 tokens after compaction.',
    do: [
      'pick the largest reference sections (API details, long examples, tables) from the outline',
      'move each into a new Markdown file next to SKILL.md, heading included, without changing its text',
      'leave the heading in SKILL.md with one line that links to the new file',
      'keep the start of the body and the steps every run needs in SKILL.md',
    ],
    constraints: [
      'you may create new `.md` files in the skill directory; do not overwrite, rename or delete files',
      'move text verbatim: do not summarize, translate or drop it',
      'keep sections with `!` commands, `$ARGUMENTS` or HTML comments in SKILL.md',
      'do not change the frontmatter',
    ],
    examples: ['For the API reference, see [api-reference.md](api-reference.md).'],
    askUser:
      'list the sections you plan to move and their new file names, and ask before you write',
    guardRules: SKILL_BODY_GUARDS,
    excerpt: { kind: 'outline' },
  },
  'skill/non-portable-field': {
    why: 'agents that do not document a frontmatter field ignore it, so the skill behaves differently from one agent to another, and skill upload rejects fields outside the Agent Skills specification.',
    do: [
      'move a custom key that no agent documents under `metadata:`, with its value as a quoted string',
      'for a field an agent documents (such as `user-invocable` or `paths`), ask the user whether to keep it or remove it',
    ],
    constraints: [
      'change only the frontmatter of this file',
      'never remove `disable-model-invocation`, `disallowed-tools` or `hooks`: without them the model may do more',
      'keep the frontmatter valid YAML',
    ],
    examples: ['metadata:\n  team: "payments"'],
    askUser:
      'name each documented field the message lists and the agents that ignore it, and ask whether to keep or remove it',
    guardRules: SKILL_FRONTMATTER_GUARDS,
  },
  'skill/broad-allowed-tools': {
    why: '`allowed-tools` lets the skill use these tools without asking; a bare `Bash` grants every shell command and a bare `Write` or `Edit` every file.',
    do: [
      'read the skill body and list the commands it tells the agent to run',
      'replace each broad entry with narrow rules for those commands, such as `Bash(git status *)`',
      'remove bare `Write`, `Edit` and shell entries the body does not need, so the agent asks first',
    ],
    constraints: [
      'only narrow: every new rule must be covered by an entry you replace',
      'never add a tool or command that is not granted now',
      'no rules for sudo, curl, wget, rm, ssh or an interpreter with inline code (`bash -c`, `python -c`)',
      "keep the author's format: a space-separated string stays a string, a YAML list stays a list",
      'change only `allowed-tools`',
    ],
    examples: ['Bash(git status *) Bash(npm run test *) Read'],
    askUser: 'show the user the new `allowed-tools` value and ask before you write',
    guardRules: SKILL_FRONTMATTER_GUARDS,
    excerpt: { kind: 'value', key: 'allowed-tools' },
  },
  'skill/broken-reference': {
    why: 'an agent that follows a broken link finds nothing, and a link that leaves the skill directory breaks when the skill is installed on its own.',
    do: [
      'for each link the problem names, look for the file it means inside the skill directory',
      'when you find it, write the link relative to SKILL.md, with `/` between directories and the exact letter case',
      'when no file matches, ask the user',
    ],
    constraints: [
      'change only link targets in this file',
      'do not create files unless the user asks',
    ],
    examples: ['[forms](reference/forms.md)'],
    askUser:
      'when no file matches a link, ask whether to remove the link (keeping its text), where the file is, or whether to create it',
    guardRules: [...SKILL_BODY_GUARDS],
  },
  'instr/import-unresolved': {
    why: 'Claude Code and Gemini CLI load nothing for an `@path` import whose file does not exist, and Gemini CLI inserts an "Import failed" comment instead.',
    do: [
      'look for the file the import means; the hint names candidates when there are any',
      'correct the path after `@`, relative to this file',
      'when no file matches, ask the user',
    ],
    constraints: [
      'change only the import line',
      'do not create the missing file unless the user asks',
    ],
    examples: ['@docs/setup.md'],
    askUser: 'when no file matches, ask whether to remove the import or where the file is',
    guardRules: ['instr/import-depth', 'instr/import-outside-root', ...BASE_GUARDS],
  },
  'instr/claude-md-too-long': {
    why: 'Claude Code loads every CLAUDE.md on the path at session start; its documentation recommends under 200 lines, because longer files use more context and reduce adherence.',
    do: [
      'cut duplicated, outdated and generic advice',
      'move instructions that matter for one part of the codebase into a path-scoped rule in `.claude/rules/` (with `paths:` frontmatter) or a skill',
      'keep what every session needs in CLAUDE.md',
    ],
    constraints: [
      ...SIZE_CONSTRAINTS,
      'you may create files in `.claude/rules/`; do not rename or delete files',
    ],
    examples: ['---\npaths:\n  - "src/api/**/*.ts"\n---'],
    askUser: SIZE_ASK,
    guardRules: INSTRUCTION_GUARDS,
  },
  'instr/codex-size-budget': {
    why: 'Codex reads at most 32,768 bytes of AGENTS.md text from the root down to the working directory, by default, and cuts or drops everything past it.',
    do: [
      'cut duplicated, outdated and generic advice',
      'move instructions for one part of the repository into an AGENTS.md in that directory',
      'keep what applies everywhere in the root file',
    ],
    constraints: [
      ...SIZE_CONSTRAINTS,
      'you may create AGENTS.md files in subdirectories; do not rename or delete files',
    ],
    examples: [],
    askUser: SIZE_ASK,
    guardRules: INSTRUCTION_GUARDS,
  },
  'instr/windsurf-rule-too-long': {
    why: 'Cascade, the older agent of Devin Desktop (formerly Windsurf), limits each workspace rule file to 12,000 characters.',
    do: [
      'split the rule into several rule files, each with its own activation mode',
      'or move reference material into files the rule points to',
    ],
    constraints: [
      ...SIZE_CONSTRAINTS,
      'you may create rule files next to this one; do not rename or delete files',
    ],
    examples: [],
    askUser: SIZE_ASK,
    guardRules: INSTRUCTION_GUARDS,
  },
  'cursor/rule-never-applied': {
    why: 'Cursor applies a rule without `alwaysApply`, `globs` or `description` only when someone @-mentions it.',
    do: [
      'read the rule body',
      'when it is about certain files, set `globs` to their patterns as one comma-separated string',
      'otherwise write a one-sentence `description` that says when the rule is relevant',
      'set `alwaysApply: true` only when the user wants the rule in every conversation',
    ],
    constraints: [
      'change only the frontmatter of this file',
      'keep the frontmatter valid YAML; add it between `---` lines on line 1 when the file has none',
    ],
    examples: ['globs: src/**/*.tsx, src/**/*.css', 'description: React component conventions'],
    askUser:
      'when the body does not make clear which files the rule is for, ask, and ask before you set `alwaysApply: true`',
    guardRules: ['cursor/rule-frontmatter', ...BASE_GUARDS],
  },
  'skill/field-type': {
    why: 'the Agent Skills specification fixes the type of each field, and its validator and skill upload reject a skill whose `metadata`, `compatibility`, `license` or `allowed-tools` has another type.',
    do: [
      'write the field the problem names in the type it asks for, keeping its content',
      '`metadata`: indented "key: value" lines with quoted text values; `allowed-tools`: one line of tool names separated by spaces',
    ],
    constraints: [
      'change only that field',
      'never add a tool to `allowed-tools`',
      'keep the frontmatter valid YAML',
    ],
    examples: ['metadata:\n  version: "1.2"\n  owner: "platform-team"'],
    guardRules: SKILL_FRONTMATTER_GUARDS,
  },
  'instr/claude-rule-frontmatter': {
    why: 'Claude Code ignores rule frontmatter it cannot read, so the rule loads in every session instead of only for the files in `paths`.',
    do: [
      'make the frontmatter valid YAML',
      'rename `globs` or `applyTo` to `paths`',
      'write `paths` as a list of quoted glob patterns, and "\\[" for a literal bracket',
    ],
    constraints: ['keep every pattern', 'change only the frontmatter of this file'],
    examples: ['paths:\n  - "src/**/*.ts"\n  - "test/**/*.ts"'],
    guardRules: [...BASE_GUARDS],
  },
  'skill/frontmatter-invalid': {
    why: 'when the frontmatter is not valid YAML, Claude Code loads the skill with no fields set and Codex skips it.',
    do: [
      'make the block between the `---` lines parse as YAML: quote values that contain ": " or start with `[`, `{`, `@` or a backtick, and keep one line per repeated key',
      'keep every value',
    ],
    constraints: ['change only the frontmatter of this file'],
    examples: ['description: "Converts PDFs: text, tables and forms."'],
    guardRules: SKILL_FRONTMATTER_GUARDS,
  },
  'instr/vague-directive': {
    why: 'generic advice such as "Write clean code" tells an agent nothing about this project and costs context in every session.',
    do: [
      'replace the sentence with the concrete command, convention or path it stands for, taken from the repository',
      'or delete it when nothing concrete applies',
    ],
    constraints: ['change only that sentence'],
    examples: ['Run `pnpm test` before you commit.'],
    guardRules: INSTRUCTION_GUARDS,
  },
  'instr/empty-file': {
    why: 'an empty instruction file gives agents nothing, and an empty CLAUDE.md still stops Claude Code from reading AGENTS.md.',
    do: ['ask the user what the file should hold, or whether to delete it'],
    constraints: ['do not delete the file yourself'],
    examples: [],
    askUser: 'ask what the file should contain, or whether the user wants to delete it',
    guardRules: [...BASE_GUARDS],
  },
  'directive/missing-reason': {
    why: 'a suppression directive without rule ids or a reason has no effect.',
    do: ['add the rule ids and a reason after ` -- `, in the words the user gives you'],
    constraints: ['do not invent a reason', 'change only the directive'],
    examples: ['<!-- agentcheckup-disable-next-line instr/import-unresolved -- generated file -->'],
    askUser: "ask why the finding is suppressed; use the user's reason",
    guardRules: [...BASE_GUARDS],
  },
};

/** Rule ids with a template of their own, sorted. */
export const TEMPLATE_RULE_IDS: readonly string[] = Object.keys(TEMPLATES).sort();

export function templateOf(ruleId: string): TaskTemplate | undefined {
  return Object.hasOwn(TEMPLATES, ruleId) ? TEMPLATES[ruleId] : undefined;
}

/** Longest `why` taken from a rationale, in code points. */
const MAX_WHY = 400;

/**
 * The first paragraph of a rule's rationale as plain text, cut after the last sentence that
 * fits in {@link MAX_WHY} code points.
 */
function whyOf(meta: RuleMeta): string {
  const first = markdownToPlain(meta.rationale.split('\n\n')[0] ?? '').replaceAll('\n', ' ');
  if (first.length <= MAX_WHY) return first;
  const cut = truncate(first, MAX_WHY, '');
  const end = cut.lastIndexOf('. ');
  return end > 0 ? cut.slice(0, end + 1) : `${cut}…`;
}

/**
 * The template of a rule without one: why from the rationale, and steps that point at the
 * finding's manual step (the task's `hint`) and the rule's documentation.
 */
export function genericTemplate(meta: RuleMeta, hasHint: boolean): TaskTemplate {
  const docs = `the rule's documentation explains the problem: ${ruleDocsUrl(meta.id)}`;
  return {
    why: whyOf(meta),
    do: hasHint ? ['resolve the problem in this file as the hint describes', docs] : [docs],
    constraints: [],
    examples: [],
    // A manual step can call for creating, renaming or deleting files, which the preamble
    // forbids unless the task says so: the user decides.
    askUser:
      'whether to create, rename or delete a file or directory, before you do it because of the hint',
    guardRules: [...BASE_GUARDS],
  };
}

/** Guard rules of a rule's tasks, with or without a template. */
export function guardRulesOf(ruleId: string): readonly string[] {
  return templateOf(ruleId)?.guardRules ?? BASE_GUARDS;
}
