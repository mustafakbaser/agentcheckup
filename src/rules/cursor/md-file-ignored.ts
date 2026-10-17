import { editableFile } from '../../core/directive-fixes.js';
import { RULESET_VERSION } from '../../core/meta.js';
import { dirnamePosix } from '../../core/paths.js';
import type { Artifact, FileChange, Fix, ReportDescriptor, RuleContext } from '../../core/types.js';
import { prependFrontmatter, renameFile, yamlInsertKey, yamlSetScalar } from '../../fix/edits.js';
import { pathProblem } from '../../fix/paths.js';
import { isRulesReadme } from '../../platforms/cursor-rules.js';
import type { FrontmatterResult } from '../../parse/types.js';
import { defineRule } from '../define.js';
import { joinNames, quote } from '../shared/format.js';
import { basename, joinPath } from '../instructions/helpers.js';
import { SOURCES } from '../sources.js';
import {
  editAt,
  isLinked,
  linkedGuidance,
  LinkReferences,
  mergeEdits,
  pathTaken,
} from './fixes.js';
import {
  alwaysApplyBoolean,
  GLOB_ALIASES,
  globsFromAlias,
  isSet,
  isStringList,
  KNOWN_FIELDS,
  SUGGESTIONS,
} from './repair.js';
import { globsInput } from './rule-never-applied.js';
import { CURSOR_SOURCES } from './sources.js';

const ID = 'cursor/md-file-ignored';

type ValidFrontmatter = Extract<FrontmatterResult, { kind: 'valid' }>;
type Context = Pick<RuleContext<undefined>, 'frontmatter' | 'snapshot'>;

const ALWAYS_APPLY_NOTE =
  'With "alwaysApply: true", Cursor adds this rule to every conversation. To load it only when it is relevant, replace it with "globs" or a "description".';
const DEVIN_NOTE = 'Devin Local in Windsurf reads the file under either name.';

/** What the fix does besides the rename, or the manual step that replaces the fix. */
type Plan =
  | {
      readonly ok: true;
      readonly variant: 'rename' | 'always-apply' | 'globs' | 'rename-unchecked';
      /** Edits to the file's text, before the rename. */
      readonly edits: readonly FileChange[];
      /** Clauses for the title after "Rename a to b". */
      readonly steps: readonly string[];
      readonly notes: readonly string[];
    }
  | { readonly ok: false; readonly guidance: string };

const manual = (guidance: string): Plan => ({ ok: false, guidance });

/** Adds `alwaysApply: true` to a frontmatter block that sets no activation field. */
function addAlwaysApply(artifact: Artifact, frontmatter: ValidFrontmatter): FileChange | undefined {
  return Object.hasOwn(frontmatter.data.values, 'alwaysApply')
    ? yamlSetScalar(artifact, frontmatter, 'alwaysApply', true)
    : yamlInsertKey(artifact, frontmatter, 'alwaysApply', true);
}

/**
 * The edits that let Cursor read valid frontmatter after the rename. A field the fix cannot
 * correct would raise a cursor/rule-frontmatter warning on the renamed file, so it leaves the
 * file to the user.
 */
function planValid(artifact: Artifact, frontmatter: ValidFrontmatter): Plan {
  const { values, keys } = frontmatter.data;
  const edits: FileChange[] = [];
  const steps: string[] = [];
  const notes: string[] = [];
  let variant: 'rename' | 'globs' = 'rename';
  let activation =
    (Object.hasOwn(values, 'alwaysApply') && values['alwaysApply'] !== null) ||
    isSet(values['description']) ||
    isSet(values['globs']);

  for (const key of keys) {
    if (KNOWN_FIELDS.has(key) || !Object.hasOwn(SUGGESTIONS, key)) continue;
    if (!GLOB_ALIASES.includes(key)) {
      return manual(`rename "${key}" to "${SUGGESTIONS[key] ?? ''}", then rename the file`);
    }
    const repair = globsFromAlias(artifact, frontmatter, key);
    if (!repair.ok) return manual(`${repair.guidance}, then rename the file`);
    edits.push(repair.change);
    steps.push(`rename "${key}" to "globs"`);
    notes.push(
      `Cursor does not read "${key}"; it attaches the rule to the files that "globs" matches.`,
    );
    variant = 'globs';
    activation = true;
  }

  const alwaysApply = values['alwaysApply'];
  if (alwaysApply !== undefined && alwaysApply !== null && typeof alwaysApply !== 'boolean') {
    const repair = alwaysApplyBoolean(artifact, frontmatter);
    if (!repair.ok) return manual(`${repair.guidance}, then rename the file`);
    edits.push(repair.change);
    steps.push('write "alwaysApply" as the boolean true');
  }
  const description = values['description'];
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return manual('write "description" as text, then rename the file');
  }
  const globs = values['globs'];
  if (globs !== undefined && globs !== null && typeof globs !== 'string' && !isStringList(globs)) {
    return manual('write "globs" as one comma-separated string of patterns, then rename the file');
  }

  if (activation) return { ok: true, variant, edits, steps, notes };
  const added = addAlwaysApply(artifact, frontmatter);
  if (added === undefined) {
    return manual('add "alwaysApply: true", "globs" or a "description" by hand');
  }
  return {
    ok: true,
    variant: 'always-apply',
    edits: [added],
    steps: ['add "alwaysApply: true"'],
    notes: [ALWAYS_APPLY_NOTE],
  };
}

function plan(context: Context, artifact: Artifact, renamed: string): Plan {
  const frontmatter = context.frontmatter(artifact);
  switch (frontmatter.kind) {
    case 'absent': {
      const change = prependFrontmatter(artifact, frontmatter, [
        { key: 'alwaysApply', value: true },
      ]);
      if (change === undefined) return manual('add frontmatter by hand');
      return {
        ok: true,
        variant: 'always-apply',
        edits: [change],
        steps: ['add "alwaysApply: true"'],
        notes: [ALWAYS_APPLY_NOTE],
      };
    }
    case 'valid':
      return planValid(artifact, frontmatter);
    case 'invalid':
      return {
        ok: true,
        variant: 'rename-unchecked',
        edits: [],
        steps: [],
        notes: [
          "The frontmatter is not valid YAML, so agentcheckup cannot tell whether it sets description, globs or alwaysApply. Cursor's editor writes such blocks, but how Cursor reads them is not documented: check the rule after the rename.",
        ],
      };
    case 'unclosed':
      return manual(
        `close the frontmatter with a "---" line, then rename the file to ${quote(renamed)}`,
      );
    case 'unsupported':
      return manual(
        `replace the frontmatter with YAML between "---" lines, then rename the file to ${quote(renamed)}`,
      );
  }
}

function fixFor(
  context: Context,
  artifact: Artifact,
  renamed: string,
  references: LinkReferences,
): Pick<ReportDescriptor, 'fix' | 'guidance'> {
  if (isLinked(artifact)) {
    return { guidance: linkedGuidance(artifact, `rename the file to ${quote(renamed)}`) };
  }
  const target = joinPath(dirnamePosix(artifact.path), renamed);
  const problem = pathProblem(target);
  if (problem !== undefined) {
    return { guidance: `choose another name ending in .mdc by hand: ${problem}` };
  }
  if (pathTaken(context.snapshot, target)) {
    return {
      guidance: `${quote(renamed)}, or a name that differs from it only in letter case, already exists: merge the two files by hand`,
    };
  }
  const outcome = plan(context, artifact, renamed);
  if (!outcome.ok) return { guidance: outcome.guidance };
  const changes: FileChange[] = [renameFile(artifact, target)];
  if (outcome.edits.length > 0) {
    const merged = mergeEdits(artifact, outcome.edits);
    if (merged === undefined) {
      return { guidance: 'correct the frontmatter and rename the file by hand' };
    }
    changes.push(editAt(target, merged));
  }
  const reference = references.note(artifact.path);
  const notes = [DEVIN_NOTE, ...(reference === undefined ? [] : [reference])];
  const fix: Fix = {
    id: `${ID}#${outcome.variant}`,
    class: outcome.variant === 'rename' ? 'safe' : 'review',
    title: `Rename ${artifact.path} to ${renamed}${outcome.steps.length > 0 ? ` and ${joinNames(outcome.steps)}` : ''}`,
    changes,
    notes: [...outcome.notes, ...notes],
    // Instead of "alwaysApply: true", the files the rule is for.
    ...(outcome.variant === 'always-apply' && editableFile(artifact)
      ? { alternatives: [askGlobs(artifact, renamed, notes)] }
      : {}),
  };
  return { fix };
}

/**
 * The alternative to `alwaysApply: true` that needs the user's words (`#ask-globs`): `fix -i`
 * asks for globs, writes them into the file as it is, then renames it as the fix it replaces does
 * (an input alternative keeps the renames of that fix).
 */
function askGlobs(artifact: Artifact, renamed: string, notes: readonly string[]): Fix {
  return {
    id: `${ID}#ask-globs`,
    class: 'review',
    title: `Rename ${artifact.path} to ${renamed} and add "globs"`,
    changes: [],
    notes,
    input: globsInput(artifact.path),
  };
}

export const mdFileIgnoredRule = defineRule({
  meta: {
    id: ID,
    title: 'Cursor ignores .md files in .cursor/rules',
    rationale: [
      'Cursor loads project rules from `.cursor/rules` only when they use the `.mdc` extension. Its documentation says a plain `.md` file there "is ignored by the rules system" because it has no frontmatter to set `description`, `globs` and `alwaysApply`. Devin Local, the default agent in Windsurf (now Devin Desktop), does read `.md` files in `.cursor/rules`, so the same file applies in Windsurf and not in Cursor.',
      'A `README.md` in the directory is treated as documentation and is not reported.',
      'Rename the file to `.mdc` and add frontmatter, or move plain Markdown instructions to `AGENTS.md`.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: ['cursor-rule-md'],
    platforms: ['cursor'],
    sources: [SOURCES.cursorRules, CURSOR_SOURCES.devinCliRules],
    since: RULESET_VERSION,
    fix: {
      classes: ['safe', 'review'],
      summary:
        'Renames the file to .mdc. Safe when its frontmatter already sets description, globs or alwaysApply; otherwise for review, adding "alwaysApply: true" or renaming "paths" or "applyTo" to "globs". Instead of "alwaysApply: true", `agentcheckup fix -i` can ask for "globs".',
    },
  },
  defaultOptions: undefined,
  check(context) {
    const references = new LinkReferences(context, context.allArtifacts, (path) => {
      const lower = path.toLowerCase();
      return lower.endsWith('.md') && lower.includes('.cursor/rules/');
    });
    for (const artifact of context.artifacts) {
      if (isRulesReadme(artifact.path)) continue;
      const name = basename(artifact.path);
      const renamed = `${name.slice(0, -'.md'.length)}.mdc`;
      context.report({
        artifact,
        message: `Cursor loads only .mdc files from .cursor/rules, so it ignores ${quote(name)}. Rename it to ${quote(renamed)} and add frontmatter with description, globs or alwaysApply.`,
        ...fixFor(context, artifact, renamed, references),
      });
    }
  },
});
