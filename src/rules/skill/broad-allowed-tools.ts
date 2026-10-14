import { RULESET_VERSION } from '../../core/meta.js';
import type { PlatformId, Span } from '../../core/types.js';
import { defineRule } from '../define.js';
import { SOURCES } from '../sources.js';
import { joinNames, quote } from '../shared/format.js';
import { loadableSkills, placement, reached, resolveImpacts, validFrontmatter } from './shared.js';
import { SKILL_SOURCES } from './sources.js';

/**
 * Splits an `allowed-tools` string into rules: spaces and commas separate entries, except inside
 * parentheses, so `Bash(git add *), Read` is two entries.
 */
export function splitToolRules(value: string): string[] {
  const rules: string[] = [];
  let current = '';
  let inside = false;
  for (const char of value) {
    if (char === '(') inside = true;
    else if (char === ')') inside = false;
    if (!inside && (char === ',' || /\s/u.test(char))) {
      if (current !== '') rules.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current !== '') rules.push(current);
  return rules;
}

interface Grant {
  readonly platform: PlatformId;
  /** What the agent may do without asking, as a verb phrase. */
  readonly capability: string;
}

/**
 * Rules that match every use of a tool. Claude Code: a bare tool name or `(*)` matches all
 * commands of Bash and PowerShell, and a bare Write or Edit matches every file. Copilot: the
 * docs warn that pre-approving `shell` or `bash` removes the confirmation for terminal commands.
 */
function broadGrant(rule: string): Grant | undefined {
  const open = rule.indexOf('(');
  const tool = open === -1 ? rule : rule.slice(0, open);
  const specifier =
    open === -1 ? undefined : rule.slice(open + 1, rule.endsWith(')') ? -1 : undefined).trim();
  const everything = specifier === undefined || specifier === '*';
  if (tool === 'Bash' && everything) {
    return { platform: 'claude-code', capability: 'runs any shell command' };
  }
  if (tool === 'PowerShell' && everything) {
    return { platform: 'claude-code', capability: 'runs any PowerShell command' };
  }
  if (tool === 'Write' && specifier === undefined) {
    return { platform: 'claude-code', capability: 'writes any file' };
  }
  if (tool === 'Edit' && specifier === undefined) {
    return { platform: 'claude-code', capability: 'edits any file' };
  }
  if ((tool === 'shell' || tool === 'bash') && specifier === undefined) {
    return { platform: 'copilot', capability: 'runs terminal commands' };
  }
  return undefined;
}

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
  // Workspace trust does not gate a project skill's allowed-tools, even in a `-p` run.
  const trust = projectSkill ? ', even in a `-p` run in a directory you never trusted' : '';
  return `\`allowed-tools\` pre-approves ${rules} without limits. During the turn that invokes this skill, Claude Code ${capabilities} without asking${trust}.`;
}

export const broadAllowedToolsRule = defineRule({
  meta: {
    id: 'skill/broad-allowed-tools',
    title: 'Skill pre-approves shell commands or file edits without limits',
    rationale: `\`allowed-tools\` lets the agent use the listed tools without asking. In Claude Code, \`Bash\` or \`Bash(*)\` pre-approves every shell command, \`PowerShell\` every PowerShell command, and a bare \`Write\` or \`Edit\` every file, during the turn that invokes the skill. Workspace trust does not gate the field: Claude Code applies a project skill's \`allowed-tools\` even in a \`-p\` run in a directory that was never trusted, so a cloned repository can grant itself shell access through \`.claude/skills\`.

GitHub Copilot warns that pre-approving \`shell\` or \`bash\` removes the confirmation step for terminal commands and can let attacker-controlled skills or prompt injections run arbitrary commands.

Scope each rule to the commands the skill needs, such as \`Bash(git status *)\`, or leave the tool out so the agent asks.`,
    category: 'risk',
    severity: 'warn',
    appliesTo: ['skill'],
    platforms: ['claude-code', 'copilot'],
    sources: [
      SOURCES.claudeSkills,
      SKILL_SOURCES.claudePermissions,
      SKILL_SOURCES.copilotAddSkills,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of loadableSkills(context)) {
      const frontmatter = validFrontmatter(context, artifact);
      if (frontmatter === undefined) continue;
      const value = frontmatter.data.values['allowed-tools'];
      const entries =
        typeof value === 'string'
          ? [value]
          : Array.isArray(value)
            ? value.filter((item): item is string => typeof item === 'string')
            : [];
      if (entries.length === 0) continue;
      const valueSpan = frontmatter.data.valueSpan('allowed-tools');
      const source =
        valueSpan === undefined
          ? ''
          : artifact.decoded.text.slice(valueSpan.offset, valueSpan.offset + valueSpan.length);
      let cursor = 0;
      const byPlatform = new Map<PlatformId, Found[]>();
      for (const rule of entries.flatMap(splitToolRules)) {
        const at = source.indexOf(rule, cursor);
        if (at !== -1) cursor = at + rule.length;
        const grant = broadGrant(rule);
        if (grant === undefined || reached(context, artifact, [grant.platform]).length === 0)
          continue;
        const list = byPlatform.get(grant.platform) ?? [];
        list.push({ rule, grant, at });
        byPlatform.set(grant.platform, list);
      }
      for (const [platform, found] of byPlatform) {
        const resolved = resolveImpacts(context, artifact, [{ platform, severity: 'warn' }]);
        if (resolved === undefined) continue;
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
        });
      }
    }
  },
});
