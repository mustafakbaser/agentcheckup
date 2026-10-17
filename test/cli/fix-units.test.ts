import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  changedFile,
  decide,
  declinedTitles,
  verifyOnDisk,
  withRenames,
  writeGroups,
} from '../../src/cli/fix.js';
import { prefillable, terminalPrompt } from '../../src/cli/prompt.js';
import type {
  AnyRule,
  Artifact,
  FileChange,
  Finding,
  Fix,
  ReportDescriptor,
  RuleContext,
} from '../../src/core/types.js';
import type { FileDiff, PlannedFix } from '../../src/fix/index.js';
import { fixOf, planned, SOURCE, utf16 } from '../fix/helpers.js';

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

function edit(path: string): FileChange {
  return { kind: 'edit', path, edits: [{ offset: 0, length: 0, text: 'x' }] };
}

function plannedOf(id: string, ...changes: FileChange[]): PlannedFix {
  return planned(fixOf(changes, `test/rule#${id}`));
}

const edited = (path: string): FileDiff => ({
  path,
  op: 'edit',
  before: bytes('a\n'),
  after: bytes('b\n'),
});

describe('writeGroups', () => {
  it('writes fixes that share a file as one unit, others apart', () => {
    const a = plannedOf('a', edit('A.md'));
    const b = plannedOf('b', edit('A.md'));
    const c = plannedOf('c', edit('B.md'));
    const groups = writeGroups([a, b, c], [edited('A.md'), edited('B.md')]);
    expect(groups.map((group) => group.fixes)).toEqual([[a, b], [c]]);
    expect(groups.map((group) => group.write.steps)).toEqual([
      [{ kind: 'replace', path: 'A.md', bytes: bytes('b\n') }],
      [{ kind: 'replace', path: 'B.md', bytes: bytes('b\n') }],
    ]);
    expect(new Set(groups.map((group) => group.write.id)).size).toBe(2);
  });

  it('follows rename chains, and replaces only when the bytes change', () => {
    const first = plannedOf('first', { kind: 'rename', from: 'a.md', to: 'b.md' });
    const second = plannedOf('second', { kind: 'rename', from: 'b.md', to: 'c.md' });
    const moved: FileDiff = {
      path: 'c.md',
      op: 'rename',
      from: 'a.md',
      before: bytes('x'),
      after: bytes('x'),
    };
    const [group, ...rest] = writeGroups([first, second], [moved]);
    expect(rest).toEqual([]);
    expect(group?.fixes).toEqual([first, second]);
    expect(group?.write.steps).toEqual([{ kind: 'rename', from: 'a.md', to: 'c.md' }]);

    const renamed = plannedOf(
      'mdc',
      { kind: 'rename', from: 'r/x.md', to: 'r/x.mdc' },
      edit('r/x.mdc'),
    );
    const changed: FileDiff = {
      path: 'r/x.mdc',
      op: 'rename',
      from: 'r/x.md',
      before: bytes('x'),
      after: bytes('---\nx'),
    };
    expect(writeGroups([renamed], [changed])[0]?.write.steps).toEqual([
      { kind: 'rename', from: 'r/x.md', to: 'r/x.mdc' },
      { kind: 'replace', path: 'r/x.mdc', bytes: bytes('---\nx') },
    ]);
  });

  it('moves a file away before another takes its name, and creates after renames', () => {
    const vacate = plannedOf('vacate', { kind: 'rename', from: 'b.md', to: 'c.md' });
    const take = plannedOf('take', { kind: 'rename', from: 'a.md', to: 'b.md' });
    const create = plannedOf('create', { kind: 'create', path: 'a.md', text: 'new\n' });
    const files: FileDiff[] = [
      { path: 'a.md', op: 'create', after: bytes('new\n') },
      { path: 'b.md', op: 'rename', from: 'a.md', before: bytes('1'), after: bytes('1') },
      { path: 'c.md', op: 'rename', from: 'b.md', before: bytes('2'), after: bytes('2') },
    ];
    const groups = writeGroups([take, vacate, create], files);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.write.steps).toEqual([
      { kind: 'rename', from: 'b.md', to: 'c.md' },
      { kind: 'rename', from: 'a.md', to: 'b.md' },
      { kind: 'create', path: 'a.md', bytes: bytes('new\n') },
    ]);
  });

  it('leaves a swap to the writer, which refuses it', () => {
    const swap = plannedOf(
      'swap',
      { kind: 'rename', from: 'a.md', to: 'b.md' },
      { kind: 'rename', from: 'b.md', to: 'a.md' },
    );
    const files: FileDiff[] = [
      { path: 'a.md', op: 'rename', from: 'b.md', before: bytes('b'), after: bytes('b') },
      { path: 'b.md', op: 'rename', from: 'a.md', before: bytes('a'), after: bytes('a') },
    ];
    expect(writeGroups([swap], files)[0]?.write.steps).toEqual([
      { kind: 'rename', from: 'b.md', to: 'a.md' },
      { kind: 'rename', from: 'a.md', to: 'b.md' },
    ]);
  });

  it('writes no file that no fix names, and gives a fix without files an empty unit', () => {
    const lone = plannedOf('lone', edit('A.md'));
    const groups = writeGroups([lone], [edited('Z.md')]);
    expect(groups).toEqual([{ write: { id: '0', steps: [] }, fixes: [lone], files: [] }]);
    expect(writeGroups([], [edited('Z.md')])).toEqual([]);
  });
});

const ARTIFACT = { path: 'AGENTS.md' } as Artifact;

function fixNamed(id: string, cls: Fix['class'] = 'safe'): Fix {
  return { id: `test/r#${id}`, class: cls, title: id, changes: [edit('AGENTS.md')] };
}

/** A rule that reports one finding per fix, and one finding without a fix. */
function reporting(id: string, fixes: readonly Fix[]): AnyRule {
  return {
    meta: {
      id,
      title: 'Test rule',
      rationale: 'Test rule.',
      category: 'correctness',
      severity: 'warn',
      appliesTo: ['agents-md'],
      platforms: ['codex'],
      sources: [SOURCE],
      since: '2026.10',
    },
    defaultOptions: undefined,
    check(context: RuleContext<undefined>) {
      for (const fix of fixes) context.report({ artifact: ARTIFACT, message: fix.id, fix });
      context.report({ artifact: ARTIFACT, message: 'no fix' });
    },
  };
}

function reportsOf(rule: AnyRule): ReportDescriptor[] {
  const reports: ReportDescriptor[] = [];
  const context = {
    report: (descriptor: ReportDescriptor) => reports.push(descriptor),
  } as unknown as RuleContext<undefined>;
  rule.check(context);
  return reports;
}

describe('decide', () => {
  const kept = fixNamed('kept');
  const swapped = fixNamed('swapped');
  const dropped = fixNamed('dropped');
  const alternative = fixNamed('alternative', 'review');
  const rule = reporting('test/r', [kept, swapped, dropped]);

  it('keeps accepted fixes, swaps in a chosen alternative and drops the rest', () => {
    // Verification demoted `kept` to review: it is still the same fix.
    const keptPlanned = planned({ ...kept, class: 'review' }, 'test/r');
    const swappedPlanned = planned(swapped, 'test/r');
    const accepted = new Map<PlannedFix, Fix>([
      [keptPlanned, keptPlanned.fix],
      [swappedPlanned, alternative],
    ]);
    const decided = decide([rule], accepted, [...accepted.keys()], undefined, ['test/r']);
    expect(decided.ruleIds).toBeUndefined();
    expect(decided.withheld).toEqual([]);
    const [wrapped] = decided.rules;
    expect(wrapped?.meta).toBe(rule.meta);
    expect(reportsOf(wrapped!).map((report) => [report.message, report.fix])).toEqual([
      [kept.id, keptPlanned.fix],
      [swapped.id, alternative],
      [dropped.id, undefined],
      ['no fix', undefined],
    ]);
  });

  it('applies the fixes of a rule it cannot wrap only when every one was accepted as it is', () => {
    const one = planned(fixNamed('one'), 'directive/unused');
    const two = planned(fixNamed('two'), 'directive/unused');
    const known = ['directive/unused', 'test/r'];

    const all = decide(
      [rule],
      new Map([
        [one, one.fix],
        [two, two.fix],
      ]),
      [one, two],
      undefined,
      known,
    );
    expect(all.ruleIds).toBeUndefined();
    expect(all.withheld).toEqual([]);

    const some = decide([rule], new Map([[one, one.fix]]), [one, two], undefined, known);
    expect(some.ruleIds).toEqual(new Set(['test/r']));
    expect(some.withheld).toEqual([one]);

    const named = decide(
      [rule],
      new Map([[one, alternative]]),
      [one],
      new Set(['directive/unused']),
      known,
    );
    expect(named.ruleIds).toEqual(new Set());
    expect(named.withheld).toEqual([one]);
  });
});

function finding(ruleId: string, path: string, fingerprint: string, extra: Partial<Finding> = {}) {
  const position = { line: 1, column: 1 };
  const value: Finding = {
    ruleId,
    severity: 'warn',
    category: 'correctness',
    message: ruleId,
    path,
    range: { start: position, end: position },
    related: [],
    platforms: ['codex'],
    fingerprint,
    ...extra,
  };
  return value;
}

describe('verifyOnDisk', () => {
  it('matches findings by rule and path, and flags fixes whose findings are still there', () => {
    const before = [
      finding('test/a', 'X.md', 'fp1'),
      finding('test/a', 'X.md', 'fp2'),
      finding('test/b', 'Y.md', 'fp3'),
      finding('test/c', 'old.md', 'fp4'),
      finding('test/d', 'X.md', 'fp5', { suppressed: { kind: 'inline', reason: 'r' } }),
    ];
    const after = [
      finding('test/a', 'X.md', 'new1'),
      finding('test/b', 'Y.md', 'new3'),
      finding('test/c', 'new.md', 'new4'),
      finding('test/e', 'Z.md', 'new5', { severity: 'info' }),
    ];
    const resolves = planned(fixOf([edit('X.md')], 'test/a#x'), 'test/a');
    const fixA = { ...resolves, findings: ['fp1'] };
    const fixB = { ...planned(fixOf([edit('Y.md')], 'test/b#y'), 'test/b'), findings: ['fp3'] };
    const unknown = { ...planned(fixOf([edit('Q.md')], 'test/q#q'), 'test/q'), findings: ['?'] };
    const { verification, unverified } = verifyOnDisk(
      { findings: before },
      { findings: after },
      new Map([['old.md', 'new.md']]),
      [fixA, fixB, unknown],
    );
    expect(unverified).toEqual([fixB]);
    expect(verification.resolved).toBe(1);
    expect(verification.remaining).toBe(3);
    expect(verification.introduced.map((item) => item.fingerprint)).toEqual(['new5']);
  });
});

describe('declinedTitles', () => {
  const declined = (title: string, ...findings: string[]): PlannedFix => ({
    ...planned({ ...fixOf([edit('X.md')], 'test/a#x', 'review'), title }, 'test/a'),
    findings,
  });
  const withFix = { fix: fixOf([edit('X.md')], 'test/a#x', 'review') };

  it('finds unchanged findings by fingerprint, edited ones by rule and path', () => {
    const before = [
      finding('test/a', 'X.md', 'fp1'),
      finding('test/a', 'X.md', 'fp2'),
      finding('test/a', 'old.md', 'fp3'),
      finding('test/a', 'Y.md', 'fp4'),
    ];
    const after = [
      finding('test/a', 'X.md', 'fp1', withFix),
      // fp2 moved: matched by rule and path; only as many as were declined there.
      finding('test/a', 'X.md', 'moved2', withFix),
      finding('test/a', 'X.md', 'other', withFix),
      // fp3's file was renamed by a written fix.
      finding('test/a', 'new.md', 'moved3', withFix),
      // fp4 is gone; a finding without a fix is a manual step, not a declined fix.
      finding('test/a', 'Y.md', 'manual'),
    ];
    const titles = declinedTitles(
      [declined('One', 'fp1', 'fp2'), declined('Two', 'fp3', 'fp4'), declined('Later', 'r2')],
      { findings: before },
      { findings: after },
      new Map([['old.md', 'new.md']]),
    );
    expect([...titles]).toEqual([
      ['fp1', 'One'],
      ['moved2', 'One'],
      ['moved3', 'Two'],
    ]);
  });
});

describe('changedFile', () => {
  it('decodes both versions and describes how they are stored', () => {
    const created = changedFile({ path: 'n.md', op: 'create', after: bytes('a\r\nb\r\n') });
    expect(created).toMatchObject({
      op: 'create',
      path: 'n.md',
      after: { text: 'a\r\nb\r\n', state: { encoding: 'utf-8', bom: false, lineEnding: 'crlf' } },
    });
    expect(created.op === 'create' && created.after.state.sha256).toMatch(/^[\da-f]{64}$/);

    const reencoded = changedFile({
      path: 'e.md',
      op: 'edit',
      before: utf16('x\n'),
      after: bytes('x\n'),
    });
    expect(reencoded).toMatchObject({
      op: 'edit',
      before: { text: 'x\n', state: { encoding: 'utf-16le', bom: true } },
      after: { state: { encoding: 'utf-8', bom: false } },
    });

    expect(
      changedFile({
        path: 'b.md',
        op: 'rename',
        from: 'a.md',
        before: bytes(''),
        after: bytes(''),
      }),
    ).toMatchObject({ op: 'rename', path: 'b.md', from: 'a.md' });
  });
});

describe('terminalPrompt', () => {
  it('asks on the output and reads one line, then undefined once input ends', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString();
    });
    const prompt = terminalPrompt(input, output);
    expect(prompt.isTTY).toBe(false);

    const answer = prompt.ask('Apply? ');
    input.write('yes\n');
    expect(await answer).toBe('yes');
    expect(written).toContain('Apply? ');

    const pending = prompt.ask('Again? ');
    input.end();
    expect(await pending).toBeUndefined();
    expect(await prompt.ask('More? ')).toBeUndefined();
    prompt.close();
  });

  it('stops on Ctrl+C in a terminal, and closes without having asked', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const prompt = terminalPrompt(input, new PassThrough());
    expect(prompt.isTTY).toBe(true);
    const answer = prompt.ask('Apply? ');
    input.write('\u0003');
    expect(await answer).toBeUndefined();

    const unused = terminalPrompt(new PassThrough(), new PassThrough());
    unused.close();
    const closing = terminalPrompt(new PassThrough(), new PassThrough());
    const pending = closing.ask('Apply? ');
    closing.close();
    expect(await pending).toBeUndefined();
  });

  it('prefills the input line in a terminal with plain text only', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString();
    });
    const prompt = terminalPrompt(input, output);

    const kept = prompt.ask('reason › ', { initial: 'Use when ' });
    input.write('the user asks\r');
    expect(await kept).toBe('Use when the user asks');
    expect(written).toContain('Use when the user asks');

    // An escape sequence or a line break is never written to the terminal as a prefill.
    written = '';
    const refused = prompt.ask('reason › ', { initial: '\u001b]0;title\u0007x' });
    input.write('typed\r');
    expect(await refused).toBe('typed');
    expect(written).not.toContain('\u001b]0;');
    const multiline = prompt.ask('reason › ', { initial: 'a\nb' });
    input.write('\r');
    expect(await multiline).toBe('');
    prompt.close();
  });

  it('never prefills without a terminal', async () => {
    const input = new PassThrough();
    const prompt = terminalPrompt(input, new PassThrough());
    const answer = prompt.ask('reason › ', { initial: 'Use when ' });
    input.write('typed\n');
    expect(await answer).toBe('typed');
    prompt.close();
  });
});

describe('prefillable', () => {
  it('takes one line of plain text, trailing space included', () => {
    expect(prefillable('Use when ')).toBe(true);
    expect(prefillable('Bash(git add *) Read')).toBe(true);
    for (const text of ['', '  ', 'a\nb', 'a\rb', '\u001b[31m', 'a‮b', 'a​b']) {
      expect(prefillable(text), JSON.stringify(text)).toBe(false);
    }
  });
});

describe('withRenames', () => {
  const globs = {
    field: 'cursor-globs',
    question: 'Globs?',
    label: 'globs',
    target: { kind: 'frontmatter', path: 'a.md', key: 'globs' },
  } as const;
  const completed = fixOf([edit('a.md')], 'test/rule#globs', 'review');

  it('keeps the renames of the replaced fix that move the answered file, in order', () => {
    const replaced = fixOf(
      [
        { kind: 'rename', from: 'a.md', to: 'b.md' },
        edit('b.md'),
        { kind: 'rename', from: 'other.md', to: 'x.md' },
        { kind: 'rename', from: 'b.md', to: 'c.mdc' },
      ],
      'test/rule#rename',
    );
    expect(withRenames(replaced, globs, completed).changes).toEqual([
      edit('a.md'),
      { kind: 'rename', from: 'a.md', to: 'b.md' },
      { kind: 'rename', from: 'b.md', to: 'c.mdc' },
    ]);
  });

  it('leaves the completed fix alone when the replaced fix moves nothing it answers', () => {
    const replaced = fixOf([edit('a.md')], 'test/rule#edit');
    expect(withRenames(replaced, globs, completed)).toBe(completed);
  });
});
