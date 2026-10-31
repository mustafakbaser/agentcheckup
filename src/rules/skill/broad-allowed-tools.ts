import { RULESET_VERSION } from '../../core/meta.js';
import type { Artifact, Fix, PlatformId, RuleContext, Span } from '../../core/types.js';
import { yamlReplaceListItems, yamlSetScalar } from '../../fix/edits.js';
import { broadGrant, type Grant, splitToolRules } from '../../platforms/permissions.js';
import { bashRuleMatches, coveredBy, parseToolRule } from '../../platforms/tool-rules.js';
import { defineRule } from '../define.js';
import { targetedReaders } from '../instructions/helpers.js';
import { SOURCES } from '../sources.js';
import { joinNames, plural, quote } from '../shared/format.js';
import { editable } from './fixes.js';
import {
  codeNodes,
  type DerivedRule,
  deriveToolRules,
  joinToolRules,
  simpleCommands,
} from './narrow-tools.js';
import { injectedCommands } from './shell-preprocessing.js';
import {
  loadableSkills,
  placement,
  reached,
  resolveImpacts,
  validFrontmatter,
  type ValidFrontmatter,
} from './shared.js';
import { SKILL_SOURCES } from './sources.js';

export { splitToolRules } from '../../platforms/permissions.js';

const KEY = 'allowed-tools';
const FIX_ID = 'skill/broad-allowed-tools#narrow';
/** The command line shown next to a derived rule is cut after this many characters. */
const MAX_SOURCE_LENGTH = 80;

interface Found {
  readonly rule: string;
  readonly grant: Grant;
  /** Offset of the rule in the value's source text, or -1 when it is written with escapes. */
  readonly at: number;
}

function message(platform: PlatformId, found: readonly Found[], projectSkill: boolean): string {
  const rules = joinNames(found.map((item) => quote(item.rule)));
  const capabilities = joinNames([...new Set(found.map((item) => item.grant.capability))]);
  if (platform === 'copilot') {
    return `\`allowed-tools\` pre-approves ${rules}, so GitHub Copilot ${capabilities} for this skill without asking for confirmation.`;
  }
  if (platform === 'windsurf') {
    return `\`allowed-tools\` auto-approves ${rules}, so Devin Local ${capabilities} without a permission prompt while this skill runs inline.`;
  }
  // Workspace trust does not gate a project skill's allowed-tools, even in a `-p` run.
  const trust = projectSkill ? ', even in a `-p` run in a directory you never trusted' : '';
  return `\`allowed-tools\` pre-approves ${rules} without limits. During the turn that invokes this skill, Claude Code ${capabilities} without asking${trust}.`;
}

// ---------------------------------------------------------------------------------------------
// The fix
// ---------------------------------------------------------------------------------------------

const isBash = (rule: string): boolean => parseToolRule(rule)?.tool === 'Bash';

/** What Claude Code asks about once a removed rule is gone, by tool. */
const ASKS_BEFORE: Readonly<Record<string, string>> = {
  Write: 'writes files',
  Edit: 'edits files',
  PowerShell: 'runs PowerShell commands',
};

function cut(text: string): string {
  return text.length <= MAX_SOURCE_LENGTH ? text : `${text.slice(0, MAX_SOURCE_LENGTH - 1)}…`;
}

/** `Bash(uv run scripts/convert.py *)  ← SKILL.md:42 uv run scripts/convert.py --in a.pdf`. */
function provenance(artifact: Artifact, derived: DerivedRule): string {
  const file = artifact.path.slice(artifact.path.lastIndexOf('/') + 1);
  return `${derived.rule}  ← ${file}:${String(derived.line)} ${cut(derived.source)}`;
}

function consequences(removed: readonly string[]): string[] {
  const notes = ["Claude Code asks before it runs any other command during this skill's turn."];
  const verbs = [
    ...new Set(removed.flatMap((rule) => ASKS_BEFORE[parseToolRule(rule)?.tool ?? ''] ?? [])),
  ];
  if (verbs.length > 0) {
    notes.push(`Claude Code asks before it ${joinNames(verbs)} during this skill's turn.`);
  }
  if (removed.some((rule) => broadGrant(rule)?.platform === 'copilot')) {
    notes.push('GitHub Copilot asks before it runs terminal commands for this skill.');
  }
  if (removed.some((rule) => broadGrant(rule)?.platform === 'windsurf')) {
    notes.push(
      "Devin Local runs shell commands for this skill only as the session's permissions allow.",
    );
  }
  return notes;
}

function title(
  path: string,
  replaced: readonly string[],
  count: number,
  removed: readonly string[],
): string {
  const names = (rules: readonly string[]): string =>
    joinNames([...new Set(rules)].map((rule) => quote(rule)));
  if (count === 0) {
    // The narrow rules already in the value allow every command the skill shows.
    return `Remove ${names([...replaced, ...removed])} from "${KEY}" of ${path}; its other rules allow the commands the skill shows`;
  }
  const head = `Replace ${names(replaced)} in "${KEY}" of ${path} with ${plural(count, 'rule')} for the commands the skill shows`;
  return removed.length === 0 ? head : `${head}, and remove ${names(removed)}`;
}

/** True when every command Claude Code runs while rendering the skill is allowed by `rules`. */
function injectedAllowed(commands: readonly string[], rules: readonly string[]): boolean {
  return commands.every((command) => {
    const parts = simpleCommands(command);
    return parts?.every((part) => rules.some((rule) => bashRuleMatches(rule, part))) === true;
  });
}

/**
 * The `#narrow` fix (`review`): each reported Bash entry is replaced in place by Bash rules for
 * the commands the skill's body shows (narrow-tools.ts), and every other reported entry (bare
 * Write, Edit, PowerShell, Copilot's shell and bash, Devin Local's exec) is removed, so the agent
 * asks. Narrow entries and the author's format stay: a string keeps its separator, a list its
 * items. Undefined without a reported Bash entry or a derived command, when a command Claude Code
 * runs while rendering the skill would no longer be allowed, the Markdown was only partly
 * analyzed, the file is reached through a symlink, or the builders cannot write the value
 * exactly.
 */
function narrowFix(
  context: RuleContext<undefined>,
  artifact: Artifact,
  frontmatter: ValidFrontmatter,
  broad: ReadonlySet<string>,
): Fix | undefined {
  if (!editable(artifact)) return undefined;
  const value = frontmatter.data.values[KEY];
  const items: readonly string[] | undefined =
    typeof value === 'string'
      ? [value]
      : Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
        ? value
        : undefined;
  if (items === undefined) return undefined;
  const rules = items.flatMap(splitToolRules);
  const replaced = rules.filter((rule) => broad.has(rule) && isBash(rule));
  const removed = rules.filter((rule) => broad.has(rule) && !isBash(rule));
  if (replaced.length === 0) return undefined;

  const markdown = context.markdown(artifact);
  if (!markdown.analysis.complete) return undefined;
  const injected = injectedCommands(artifact.decoded.text, markdown.root);
  // An inline command starts after its `!`.
  const offsets = new Set(injected.map((command) => command.span.offset + 1));
  const derived = deriveToolRules(codeNodes(markdown.root), { injected: offsets });
  if (derived.length === 0) return undefined;
  const kept = rules.filter((rule) => !broad.has(rule));
  const additions = derived.filter((item) => !kept.some((rule) => coveredBy(item.rule, rule)));

  let inserted = false;
  const next = items.map((item) => {
    const own = splitToolRules(item);
    const rewritten = own.flatMap((rule) => {
      if (!broad.has(rule)) return [rule];
      if (!isBash(rule) || inserted) return [];
      inserted = true;
      return additions.map((addition) => addition.rule);
    });
    return { item, own, rewritten };
  });
  const all = next.flatMap((entry) => entry.rewritten);
  const commands = injected.map((command) => command.command);
  if (all.length === 0 || !injectedAllowed(commands, all)) return undefined;

  let change;
  if (typeof value === 'string') {
    const joined = joinToolRules(value, all);
    const resplit = splitToolRules(joined);
    if (resplit.length !== all.length || resplit.some((rule, index) => rule !== all[index])) {
      return undefined;
    }
    change = yamlSetScalar(artifact, frontmatter, KEY, joined);
  } else {
    change = yamlReplaceListItems(
      artifact,
      frontmatter,
      KEY,
      next.map(({ item, own, rewritten }) => {
        if (rewritten.length === own.length && rewritten.every((rule, i) => rule === own[i])) {
          return [item];
        }
        if (own.length === 1 || rewritten.length === 0) return rewritten;
        return [joinToolRules(item, rewritten)];
      }),
    );
  }
  if (change === undefined) return undefined;
  return {
    id: FIX_ID,
    class: 'review',
    title: title(artifact.path, replaced, additions.length, removed),
    changes: [change],
    notes: [
      ...additions.map((addition) => provenance(artifact, addition)),
      ...consequences(removed),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------------------------

export const broadAllowedToolsRule = defineRule({
  meta: {
    id: 'skill/broad-allowed-tools',
    title: 'Skill pre-approves shell commands or file edits without limits',
    rationale: `\`allowed-tools\` lets the agent use the listed tools without asking. In Claude Code, \`Bash\` or \`Bash(*)\` pre-approves every shell command, \`PowerShell\` every PowerShell command, and a bare \`Write\` or \`Edit\` every file, during the turn that invokes the skill. Workspace trust does not gate the field: Claude Code applies a project skill's \`allowed-tools\` even in a \`-p\` run in a directory that was never trusted, so a cloned repository can grant itself shell access through \`.claude/skills\`.

GitHub Copilot warns that pre-approving \`shell\` or \`bash\` removes the confirmation step for terminal commands and can let attacker-controlled skills or prompt injections run arbitrary commands.

Devin Local auto-approves the tools in a skill's \`allowed-tools\` while the skill runs inline, without a permission prompt; the field does not restrict which tools the skill can use. It reads its own tool names there, and \`exec\` is every shell command. That holds for the skills it imports from \`.claude/skills\` and \`.github/skills\` as well as for its own.

Scope each rule to the commands the skill needs, such as \`Bash(git status *)\`, or leave the tool out so the agent asks.`,
    category: 'risk',
    severity: 'warn',
    appliesTo: ['skill'],
    platforms: ['claude-code', 'copilot', 'windsurf'],
    sources: [
      SOURCES.claudeSkills,
      SKILL_SOURCES.claudePermissions,
      SKILL_SOURCES.copilotAddSkills,
      SOURCES.devinCliSkillsCreate,
      SOURCES.devinCliSkills,
      SOURCES.devinCliChangelog,
    ],
    since: RULESET_VERSION,
    fix: {
      classes: ['review'],
      summary:
        "Replaces `Bash` with rules for the commands in the skill's shell code blocks, such as `Bash(git status *)`, and removes bare `Write`, `Edit`, `PowerShell`, `shell`, `bash` and `exec`. Keeps a string or a list as it is. Offered only when it finds a command; each new rule is listed with its source line.",
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const frontmatter = validFrontmatter(context, artifact);
      if (frontmatter === undefined) continue;
      const value = frontmatter.data.values[KEY];
      const entries =
        typeof value === 'string'
          ? [value]
          : Array.isArray(value)
            ? value.filter((item): item is string => typeof item === 'string')
            : [];
      if (entries.length === 0) continue;
      const valueSpan = frontmatter.data.valueSpan(KEY);
      const source =
        valueSpan === undefined
          ? ''
          : artifact.decoded.text.slice(valueSpan.offset, valueSpan.offset + valueSpan.length);
      let cursor = 0;
      const byPlatform = new Map<PlatformId, Found[]>();
      const devin = targetedReaders(context, artifact).includes('windsurf');
      for (const rule of entries.flatMap(splitToolRules)) {
        const at = source.indexOf(rule, cursor);
        if (at !== -1) cursor = at + rule.length;
        const grant = broadGrant(rule);
        if (grant === undefined || reached(context, artifact, [grant.platform]).length === 0)
          continue;
        // Devin Local does not read a skill whose source `read_config_from` turns off.
        if (grant.platform === 'windsurf' && !devin) continue;
        const list = byPlatform.get(grant.platform) ?? [];
        list.push({ rule, grant, at });
        byPlatform.set(grant.platform, list);
      }
      const reports: {
        platform: PlatformId;
        found: Found[];
        resolved: NonNullable<ReturnType<typeof resolveImpacts>>;
      }[] = [];
      for (const [platform, found] of byPlatform) {
        const resolved = resolveImpacts(context, artifact, [{ platform, severity: 'warn' }]);
        if (resolved !== undefined) reports.push({ platform, found, resolved });
      }
      if (reports.length === 0) continue;
      const broad = new Set(reports.flatMap((report) => report.found.map((item) => item.rule)));
      const fix = narrowFix(context, artifact, frontmatter, broad);
      for (const { platform, found, resolved } of reports) {
        const single = found.length === 1 ? found[0] : undefined;
        const span: Span | undefined =
          valueSpan === undefined
            ? undefined
            : single !== undefined && single.at !== -1
              ? { offset: valueSpan.offset + single.at, length: single.rule.length }
              : valueSpan;
        context.report({
          artifact,
          message: message(platform, found, placement(context, artifact).claudeProject),
          severity: resolved.severity,
          platforms: resolved.platforms,
          ...(span === undefined ? {} : { span }),
          ...(fix === undefined ? {} : { fix }),
          guidance:
            platform === 'copilot'
              ? 'remove the shell tool from "allowed-tools" so that GitHub Copilot asks before it runs commands'
              : platform === 'windsurf'
                ? 'remove "exec" from "allowed-tools" so that Devin Local asks before it runs commands'
                : 'limit each rule in "allowed-tools" to the commands or files the skill needs, such as "Bash(git status *)", or remove it so that Claude Code asks',
        });
      }
    }
  },
});
