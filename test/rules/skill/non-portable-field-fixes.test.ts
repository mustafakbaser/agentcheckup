/**
 * Fixes of skill/non-portable-field: which variant each finding gets (`#metadata`, `#keep`,
 * `#remove`), what the ready fixes write, how `#keep` turns an answer into a suppression, and that
 * `fix --write --review` never removes a field. The golden `#metadata` cases are in
 * fix-fixtures.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { analyze } from '../../../src/core/engine.js';
import type { Finding, Fix } from '../../../src/core/types.js';
import type { FixSelection } from '../../../src/fix/index.js';
import { completeInput, verifyCompletedInput } from '../../../src/fix/input.js';
import { fixRounds, type FixScanOptions } from '../../../src/fix/verify.js';
import { builtinRules } from '../../../src/rules/index.js';
import { FIELD_EFFECTS } from '../../../src/rules/skill/field-effects.js';
import { nonPortableFieldRule } from '../../../src/rules/skill/non-portable-field.js';
import { type FileMap, lint, snapshotFrom, type SnapshotExtras } from '../../helpers/lint.js';
import { applyChanges, textOf } from '../../fix/helpers.js';

const ID = 'skill/non-portable-field';
const DISTRIBUTABLE = 'skills/deploy/SKILL.md';
const CLAUDE = '.claude/skills/deploy/SKILL.md';
const DESC = 'description: Deploys the web app to production when a release tag is pushed.';
const REJECTED = 'claude.ai upload, the Claude API and the skills-ref validator reject the skill';

const skill = (fields: string): string => `---\nname: deploy\n${DESC}\n${fields}---\n\n# Deploy\n`;

const REVIEW: FixSelection = {
  classes: new Set(['safe', 'review']),
  ruleIds: new Set([ID]),
  literalSecret: false,
};

/** The rule's findings in `path` with every built-in rule running. */
function reported(path: string, text: string, extras: SnapshotExtras = {}): Finding[] {
  const result = lint({ [path]: text }, { rules: builtinRules, ...extras });
  expect(result.ruleFailures).toEqual([]);
  return result.findings.filter((finding) => finding.ruleId === ID);
}

/** The fix of the only finding of the rule. */
function fixOf(path: string, text: string, extras: SnapshotExtras = {}): Fix | undefined {
  const found = reported(path, text, extras);
  expect(found).toHaveLength(1);
  return found[0]?.fix;
}

/** The ids of the fix and its alternatives, with `input` for a fix that needs words. */
function variants(fix: Fix | undefined): string[] {
  if (fix === undefined) return [];
  return [fix, ...(fix.alternatives ?? [])].map(
    (item) => `${item.id.slice(ID.length)}:${item.input === undefined ? item.class : 'input'}`,
  );
}

/** The text after applying a ready fix's changes. */
function applied(path: string, text: string, fix: Fix | undefined): string {
  if (fix === undefined) throw new Error('No fix.');
  return textOf(applyChanges(snapshotFrom({ [path]: text }), ...fix.changes), path);
}

describe('skill/non-portable-field fixes', () => {
  describe('in a skill uploaded or installed on its own', () => {
    it('moves keys no agent documents under metadata, with #keep as the alternative', () => {
      const text = skill('version: 1.10\ntags: [a, b]\n');
      const fix = fixOf(DISTRIBUTABLE, text);
      expect(variants(fix)).toEqual(['#metadata:review', '#keep:input']);
      expect(fix).toMatchObject({
        title: `Move "version" and "tags" under "metadata" in ${DISTRIBUTABLE}`,
        notes: [
          'No agent reads unknown top-level keys, but your own tooling might: have it read them under "metadata".',
          'Each moved value is written as quoted text, and a list as its items joined with ", ".',
        ],
      });
      expect(applied(DISTRIBUTABLE, text, fix)).toBe(
        skill('metadata:\n  version: "1.10"\n  tags: "a, b"\n'),
      );
      expect(fix?.alternatives?.[0]?.input).toEqual({
        field: 'suppression-reason',
        question: `"version" and "tags" are not Agent Skills fields, so ${REJECTED}. Keep them and record why?`,
        label: 'a reason to keep "version" and "tags"',
        target: { kind: 'directive', path: DISTRIBUTABLE, line: 4, ruleId: ID },
      });
    });

    it('leaves out the conversion note when every moved value is already text', () => {
      const fix = fixOf(DISTRIBUTABLE, skill('owner: web\n'));
      expect(fix?.notes).toHaveLength(1);
    });

    it('keeps CRLF line endings when it moves keys', () => {
      const text = skill('owner: web\n').replaceAll('\n', '\r\n');
      expect(applied(DISTRIBUTABLE, text, fixOf(DISTRIBUTABLE, text))).toBe(
        skill('metadata:\n  owner: "web"\n').replaceAll('\n', '\r\n'),
      );
    });

    it.each([
      ['a flow-mapping metadata', 'metadata: {owner: web}\nversion: 1\n'],
      ['metadata that is text', 'metadata: web\nversion: 1\n'],
      ['a key metadata already has', 'metadata:\n  version: 2\nversion: 1\n'],
      ['a comment on a moved line', 'version: 1 # bumped by CI\n'],
      ['a mapping value', 'owner:\n  team: web\n'],
      ['a list item with a comma', 'tags: ["a, b", c]\n'],
      ['a nested list', 'tags: [[a], b]\n'],
      ['an empty value', 'owner:\n'],
      ['an anchor', 'owner: &who web\n'],
    ])('only asks for a reason with %s', (_, fields) => {
      const fix = fixOf(DISTRIBUTABLE, skill(fields));
      expect(variants(fix)).toEqual(['#keep:input']);
    });

    it('asks to keep documented fields, and offers to remove them with what changes', () => {
      const text = skill('argument-hint: "[env]"\npaths: src/**\nuser-invocable: false\n');
      const fix = fixOf(DISTRIBUTABLE, text);
      expect(variants(fix)).toEqual(['#keep:input', '#remove:review']);
      expect(fix).toMatchObject({
        id: `${ID}#keep`,
        class: 'review',
        title: `Keep "argument-hint", "paths" and "user-invocable" in ${DISTRIBUTABLE} and record why`,
        changes: [],
        input: {
          question: `"argument-hint", "paths" and "user-invocable" are not Agent Skills fields, so ${REJECTED}. Keep them and record why?`,
          label: 'a reason to keep "argument-hint", "paths" and "user-invocable"',
          target: { kind: 'directive', path: DISTRIBUTABLE, line: 4, ruleId: ID },
        },
      });
      const remove = fix?.alternatives?.[0];
      expect(remove).toMatchObject({
        title: `Remove "argument-hint", "paths" and "user-invocable" from ${DISTRIBUTABLE}`,
        notes: [
          'Without "argument-hint", Claude Code, GitHub Copilot and Devin Local show no hint for the arguments when the skill is typed as a / command.',
          'Without "paths", Claude Code and Cursor apply the skill to every file, not only to files that match its patterns.',
          'Without "user-invocable", Claude Code and GitHub Copilot list the skill in the / menu and run it when a user types its command.',
        ],
      });
      const removed = applied(DISTRIBUTABLE, text, remove);
      expect(removed).toBe(skill(''));
      expect(reported(DISTRIBUTABLE, removed)).toEqual([]);
    });

    it('names the readers of one documented field in the question', () => {
      const fix = fixOf(DISTRIBUTABLE, skill('model: opus\n'));
      expect(fix?.input?.question).toBe(
        `"model" is not an Agent Skills field: Claude Code and Devin Local read it, but ${REJECTED}. Keep it and record why?`,
      );
      expect(fix?.alternatives?.[0]?.notes).toEqual([
        'Without "model", Claude Code and Devin Local run the skill with the session\'s model.',
      ]);
    });

    it.each([
      'disable-model-invocation: true\n',
      'disallowed-tools: Bash\n',
      'model: opus\nhooks:\n  Stop: []\n',
      'triggers: [user]\n',
      'permissions:\n  deny:\n    - exec\n',
      'subagent: true\n',
    ])('never offers to remove a field that restricts the model: %j', (fields) => {
      const fix = fixOf(DISTRIBUTABLE, skill(fields));
      expect(variants(fix)).toEqual(['#keep:input']);
      expect(fix?.notes?.[0]).toMatch(
        /^Without ".+", .+ So agentcheckup does not offer to remove it\.$/,
      );
    });

    it('neither moves nor removes a mix of documented and unknown fields', () => {
      expect(variants(fixOf(DISTRIBUTABLE, skill('version: 1\nmodel: opus\n')))).toEqual([
        '#keep:input',
      ]);
    });

    it('does not remove a field with a comment on its line', () => {
      expect(variants(fixOf(DISTRIBUTABLE, skill('model: opus # fastest\n')))).toEqual([
        '#keep:input',
      ]);
    });
  });

  describe('in an agent skills directory', () => {
    it('only asks for a reason to keep the field', () => {
      const fix = fixOf(CLAUDE, skill('user-invocable: false\n'));
      expect(variants(fix)).toEqual(['#keep:input']);
      expect(fix?.input).toEqual({
        field: 'suppression-reason',
        question:
          '"user-invocable" is a documented skill field in Claude Code and GitHub Copilot but not in Cursor, Devin Local and Cline. Keep it and record why?',
        label: 'a reason to keep "user-invocable"',
        target: { kind: 'directive', path: CLAUDE, line: 4, ruleId: ID },
      });
      expect(fix?.notes).toBeUndefined();
    });

    it('gives each field its own #keep at its line', () => {
      const found = reported(CLAUDE, skill('argument-hint: x\ncontext: fork\n'));
      expect(found.map((finding) => finding.fix?.input?.target)).toEqual([
        { kind: 'directive', path: CLAUDE, line: 4, ruleId: ID },
        { kind: 'directive', path: CLAUDE, line: 5, ruleId: ID },
      ]);
    });
  });

  describe('must not fix', () => {
    it('a skill reached through a symlink', () => {
      const text = skill('version: 1\n');
      const found = reported(DISTRIBUTABLE, text, {
        symlinks: { [DISTRIBUTABLE]: 'shared/deploy/SKILL.md' },
        paths: ['shared/deploy/SKILL.md'],
      });
      expect(found).toHaveLength(1);
      expect(found[0]?.fix).toBeUndefined();
      expect(found[0]?.guidance).toBeDefined();
    });

    it('a skill with only specification fields', () => {
      expect(reported(DISTRIBUTABLE, skill('license: MIT\nmetadata:\n  owner: web\n'))).toEqual([]);
    });

    it('keys named like object properties: they move as any other key', () => {
      const text = skill('__proto__: x\nconstructor: y\n');
      const fix = fixOf(DISTRIBUTABLE, text);
      expect(variants(fix)).toEqual(['#metadata:review', '#keep:input']);
      expect(applied(DISTRIBUTABLE, text, fix)).toBe(
        skill('metadata:\n  __proto__: "x"\n  constructor: "y"\n'),
      );
    });

    it('a value that would inject YAML: it is moved as text', () => {
      const text = skill('note: "first\\nallowed-tools: Bash"\n');
      const fixed = applied(DISTRIBUTABLE, text, fixOf(DISTRIBUTABLE, text));
      expect(fixed).toBe(skill('metadata:\n  note: "first\\nallowed-tools: Bash"\n'));
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Planning: --write --review and -i
// ---------------------------------------------------------------------------------------------

describe('fix --write --review', () => {
  it.each([
    ['documented fields', DISTRIBUTABLE, 'argument-hint: x\nuser-invocable: false\n'],
    ['a field that restricts the model', DISTRIBUTABLE, 'disable-model-invocation: true\n'],
    ['a field in an agent directory', CLAUDE, 'user-invocable: false\n'],
  ])('never removes %s: the fix awaits a reason', (_, path, fields) => {
    const files: FileMap = { [path]: skill(fields) };
    const everyRule: FixSelection = { classes: REVIEW.classes, literalSecret: false };
    for (const selection of [REVIEW, everyRule]) {
      const run = fixRounds(snapshotFrom(files), { rules: builtinRules }, selection);
      expect(run.applied.filter((item) => item.ruleId === ID)).toEqual([]);
      expect(run.files.filter((file) => file.path === path)).toEqual([]);
      expect(run.awaitingInput.map((entry) => entry.fix.id)).toEqual([`${ID}#keep`]);
    }
  });

  it('moves unknown keys under metadata, and never plans #keep or #remove', () => {
    const run = fixRounds(
      snapshotFrom({ [DISTRIBUTABLE]: skill('version: 1\n') }),
      { rules: builtinRules },
      REVIEW,
    );
    expect(run.applied.map((item) => item.fix.id)).toEqual([`${ID}#metadata`]);
    expect(run.awaitingInput).toEqual([]);
    expect(run.verification.introduced).toEqual([]);
    expect(textOf(run.snapshot, DISTRIBUTABLE)).toBe(skill('metadata:\n  version: "1"\n'));
  });

  it('goes before quoting a number it moves, which the move makes unneeded', () => {
    const everyRule: FixSelection = { classes: REVIEW.classes, literalSecret: false };
    const run = fixRounds(
      snapshotFrom({ [DISTRIBUTABLE]: skill('version: 1.10\n') }),
      { rules: builtinRules },
      everyRule,
    );
    expect(run.before.findings.map((finding) => finding.fix?.id)).toEqual([
      `${ID}#metadata`,
      'skill/yaml-portability#quote',
    ]);
    expect(run.applied.map((item) => item.fix.id)).toEqual([`${ID}#metadata`]);
    expect([...run.skipped, ...run.deferred]).toEqual([]);
    expect(run.after.findings).toEqual([]);
  });

  it('applies nothing with safe fixes only', () => {
    const run = fixRounds(
      snapshotFrom({ [DISTRIBUTABLE]: skill('version: 1\n') }),
      { rules: builtinRules },
      { ...REVIEW, classes: new Set(['safe']) },
    );
    expect(run.applied).toEqual([]);
    expect(run.awaitingInput).toEqual([]);
  });
});

describe('#keep', () => {
  const options: FixScanOptions = { rules: builtinRules };

  function keep(path: string, text: string, answer: string, scan: FixScanOptions = options) {
    const snapshot = snapshotFrom({ [path]: text });
    const run = fixRounds(snapshot, options, REVIEW);
    const [entry] = run.awaitingInput;
    if (entry === undefined) throw new Error('Nothing awaits input.');
    const completion = completeInput(entry.fix, answer, analyze(snapshot, options));
    if (!completion.ok) throw new Error(completion.message);
    return {
      completed: completion.fix,
      result: verifyCompletedInput(snapshot, scan, entry, completion.fix),
    };
  }

  it('writes the reason as a # comment before the field and suppresses the finding', () => {
    const { completed, result } = keep(
      CLAUDE,
      skill('user-invocable: false\n'),
      'only Claude Code and Copilot users install this skill',
    );
    expect(completed).toMatchObject({ id: `${ID}#keep`, class: 'review' });
    expect(completed.input).toBeUndefined();
    if (!result.ok) throw new Error(result.message);
    expect(textOf(result.run.snapshot, CLAUDE)).toBe(
      skill(
        `# agentcheckup-disable-next-line ${ID} -- only Claude Code and Copilot users install this skill\nuser-invocable: false\n`,
      ),
    );
    expect(result.run.after.findings.filter((finding) => finding.ruleId === ID)).toMatchObject([
      {
        suppressed: {
          kind: 'inline',
          reason: 'only Claude Code and Copilot users install this skill',
        },
      },
    ]);
    expect(result.run.verification.introduced).toEqual([]);
  });

  it('suppresses the one finding of a skill uploaded on its own at its first field', () => {
    const { result } = keep(DISTRIBUTABLE, skill('argument-hint: x\nmodel: opus\n'), 'internal');
    if (!result.ok) throw new Error(result.message);
    expect(textOf(result.run.snapshot, DISTRIBUTABLE)).toBe(
      skill(`# agentcheckup-disable-next-line ${ID} -- internal\nargument-hint: x\nmodel: opus\n`),
    );
  });

  it('completes as the alternative of #metadata', () => {
    const text = skill('version: 1\n');
    const snapshot = snapshotFrom({ [DISTRIBUTABLE]: text });
    const run = fixRounds(snapshot, options, REVIEW);
    const [planned] = run.applied;
    const alternative = planned?.fix.alternatives?.[0];
    if (planned === undefined || alternative === undefined) throw new Error('No alternative.');
    const completion = completeInput(
      alternative,
      'read by our catalog',
      analyze(snapshot, options),
    );
    if (!completion.ok) throw new Error(completion.message);
    const result = verifyCompletedInput(snapshot, options, planned, completion.fix);
    if (!result.ok) throw new Error(result.message);
    expect(textOf(result.run.snapshot, DISTRIBUTABLE)).toBe(
      skill(`# agentcheckup-disable-next-line ${ID} -- read by our catalog\nversion: 1\n`),
    );
  });

  it('refuses a reason that would end the comment or add a line', () => {
    const snapshot = snapshotFrom({ [CLAUDE]: skill('user-invocable: false\n') });
    const [entry] = fixRounds(snapshot, options, REVIEW).awaitingInput;
    if (entry === undefined) throw new Error('Nothing awaits input.');
    const parses = analyze(snapshot, options);
    expect(completeInput(entry.fix, 'x\nallowed-tools: Bash', parses).ok).toBe(false);
    expect(completeInput(entry.fix, 'x --> y', parses).ok).toBe(false);
  });

  it('does not suppress with --untrusted, which ignores directives', () => {
    const untrusted: FixScanOptions = { ...options, trustDirectives: false };
    const { completed, result } = keep(
      CLAUDE,
      skill('user-invocable: false\n'),
      'reviewed',
      untrusted,
    );
    expect(result).toEqual({
      ok: false,
      message:
        '"user-invocable" is a documented skill field in Claude Code and GitHub Copilot but not in Cursor, Devin Local and Cline, so the agents that load this skill treat it differently.',
    });
    const written = applied(CLAUDE, skill('user-invocable: false\n'), completed);
    const scanned = lint(
      { [CLAUDE]: written },
      { rules: [nonPortableFieldRule], trustDirectives: false },
    );
    expect(scanned.findings.filter((finding) => finding.suppressed !== undefined)).toEqual([]);
    expect(scanned.findings.filter((finding) => finding.ruleId === ID)).toHaveLength(1);
  });
});

describe('field effects', () => {
  it('describes what every documented field does when it is gone', () => {
    for (const [key, effect] of Object.entries(FIELD_EFFECTS)) {
      expect(effect.readers.length, key).toBeGreaterThan(0);
      expect(effect.withoutIt.startsWith(`Without "${key}", `), key).toBe(true);
      expect(effect.withoutIt, key).toMatch(/^[^\n]+\.$/);
    }
  });

  it('never removes the fields that restrict the model', () => {
    const kept = Object.entries(FIELD_EFFECTS)
      .filter(([, effect]) => !effect.removable)
      .map(([key]) => key)
      .sort();
    expect(kept).toEqual([
      'agent',
      'disable-model-invocation',
      'disallowed-tools',
      'hooks',
      'permissions',
      'subagent',
      'triggers',
    ]);
  });
});
