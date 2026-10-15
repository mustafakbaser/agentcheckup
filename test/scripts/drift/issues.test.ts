import { describe, expect, it } from 'vitest';
import type {
  ChangedSource,
  DriftReport,
  UnreachableSource,
} from '../../../scripts/drift/baseline.js';
import {
  changedIssueBody,
  changedIssueTitle,
  type Issue,
  LABEL,
  type RunGh,
  syncIssues,
  UNREACHABLE_TITLE,
  unreachableIssueBody,
} from '../../../scripts/drift/issues.js';
import { HOSTILE_ALL } from '../../report/hostile.js';
import { unsafeCodePoints } from '../../report/safety.js';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const RUN = 'https://github.com/mustafakbaser/agentcheckup/actions/runs/123';
const DOCS = 'https://code.claude.com/docs/en/memory';
const CODE = 'https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs';

const CHANGED: ChangedSource = {
  url: DOCS,
  rules: ['instr/claude-md-too-long', 'instr/import-depth'],
  previous: H1,
  current: H2,
};

const GONE: UnreachableSource = {
  url: 'https://docs.example/gone',
  rules: ['mcp/x'],
  reason: 'HTTP 404',
};
const DOWN: UnreachableSource = {
  url: 'https://docs.example/down',
  rules: ['mcp/y'],
  reason: 'HTTP 503',
};

function report(changed: ChangedSource[], unreachable: UnreachableSource[] = []): DriftReport {
  return { version: 1, checked: 10, changed, unreachable, unchanged: 0, uncited: [], skipped: [] };
}

/** A fake `gh` that answers list commands from the given state and records every call. */
function fakeGh(state: { labels?: string[]; issues?: Issue[] } = {}): {
  gh: RunGh;
  calls: string[][];
  writes: () => string[][];
} {
  const calls: string[][] = [];
  const gh: RunGh = (args) => {
    calls.push([...args]);
    if (args[0] === 'label' && args[1] === 'list') {
      return Promise.resolve(JSON.stringify((state.labels ?? [LABEL]).map((name) => ({ name }))));
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      return Promise.resolve(JSON.stringify(state.issues ?? []));
    }
    return Promise.resolve('');
  };
  const writes = (): string[][] => calls.filter((args) => args[1] !== 'list');
  return { gh, calls, writes };
}

function argAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

describe('changedIssueBody', () => {
  it('lists the rules, the hashes and what the maintainer must do', () => {
    const body = changedIssueBody(CHANGED, { runUrl: RUN });
    expect(body.split('\n')[0]).toBe(`<!-- agentcheckup-source-drift url=${DOCS} hash=${H2} -->`);
    expect(body).toContain(`- Source: [https\\://code\\.claude\\.com/docs/en/memory](${DOCS})`);
    expect(body).toContain(`- Baseline hash: \`${H1}\``);
    expect(body).toContain(`- Current hash: \`${H2}\``);
    expect(body).toContain(`- Found by: [workflow run](${RUN})`);
    expect(body).toContain(
      '- [`instr/import-depth`](https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/instr/import-depth.md)',
    );
    expect(body).toContain('Re-read the source');
    expect(body).toContain('`checked` date');
    expect(body).toContain(`\`pnpm drift:update --only ${DOCS}\``);
    expect(body).not.toContain('Commit history');
  });

  it('links the commit history of GitHub files and explains a URL new to the baseline', () => {
    const body = changedIssueBody({ ...CHANGED, url: CODE, previous: null });
    expect(body).toContain(
      '- Commit history: [commits](https://github.com/openai/codex/commits/main/codex-rs/core/src/agents_md.rs)',
    );
    expect(body).toContain('- Baseline hash: none, the URL is not in the baseline yet');
    expect(body).not.toContain('Found by');
  });

  it('never links an unusual URL or rule id', () => {
    const url = 'https://docs.example/a page)(x)<b>--';
    const body = changedIssueBody({ ...CHANGED, url, rules: ['Bad Rule](x)'] });
    expect(body).not.toContain('](https://docs.example/a page');
    expect(body).toContain('url-sha256=');
    expect(body).not.toContain('<b>');
    expect(body).toContain('Bad Rule\\]\\(x\\)');
    expect(body).toContain('`pnpm drift:update --only <url>`');
  });

  it('lists the context loaders as a user, without a rule link', () => {
    const body = changedIssueBody({ ...CHANGED, rules: ['context loaders', 'mcp/x'] });
    expect(body).toContain('## Used by\n\n- context loaders\n- [`mcp/x`]');
    expect(body).toContain('compare it with the load plans in `src/platforms/load`');
  });

  it('has a plain title with the URL', () => {
    expect(changedIssueTitle(DOCS)).toBe(`Source changed: ${DOCS}`);
  });
});

describe('unreachableIssueBody', () => {
  it('lists each source with its reason and rules', () => {
    const body = unreachableIssueBody([GONE], { runUrl: RUN });
    expect(body.startsWith('<!-- agentcheckup-source-drift unreachable set=')).toBe(true);
    expect(body).toContain(
      '| [https\\://docs\\.example/gone](https://docs.example/gone) | HTTP 404 | `mcp/x` |',
    );
    expect(body).toContain(`- Found by: [workflow run](${RUN})`);
    expect(body).toContain('pnpm drift:update');
  });

  it('sanitizes reasons that come from the network', () => {
    const body = unreachableIssueBody([{ ...GONE, reason: HOSTILE_ALL }]);
    const row = body.split('\n').find((line) => line.startsWith('| [https'));
    expect(row).toBeDefined();
    expect(row).not.toContain('<');
    expect(row).not.toMatch(/@[\p{L}\p{N}]/u);
    expect(row).not.toMatch(/(?<!&)#\d/);
    expect(row).not.toMatch(/(?<!\\)!\[/);
    expect(unsafeCodePoints(body, { newline: true, tab: true })).toEqual([]);
  });

  it('stays within the issue size limit', () => {
    const many = Array.from({ length: 2_000 }, (_, index) => ({
      ...GONE,
      url: `https://docs.example/${'x'.repeat(40)}/${String(index)}`,
      reason: 'network error: ECONNREFUSED',
    }));
    const body = unreachableIssueBody(many);
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain(' more not shown.');
  });
});

describe('syncIssues', () => {
  it('creates the label when it is missing', async () => {
    const { gh, writes } = fakeGh({ labels: ['bug'] });
    expect(await syncIssues(report([]), gh)).toEqual([`created label ${LABEL}`]);
    expect(writes()[0]?.slice(0, 3)).toEqual(['label', 'create', LABEL]);
  });

  it('searches open issues with the label only', async () => {
    const { gh, calls } = fakeGh();
    await syncIssues(report([]), gh);
    const list = calls.find((args) => args[0] === 'issue' && args[1] === 'list');
    expect(argAfter(list!, '--label')).toBe(LABEL);
    expect(argAfter(list!, '--state')).toBe('open');
  });

  it('opens one labeled issue per changed source', async () => {
    const other = { ...CHANGED, url: CODE };
    const { gh, writes } = fakeGh();
    const log = await syncIssues(report([CHANGED, other]), gh, { runUrl: RUN });
    const creates = writes();
    expect(creates).toHaveLength(2);
    expect(creates.map((args) => argAfter(args, '--title'))).toEqual([
      changedIssueTitle(DOCS),
      changedIssueTitle(CODE),
    ]);
    expect(creates.every((args) => argAfter(args, '--label') === LABEL)).toBe(true);
    expect(argAfter(creates[0]!, '--body')).toBe(changedIssueBody(CHANGED, { runUrl: RUN }));
    expect(log).toEqual([`opened an issue for ${DOCS}`, `opened an issue for ${CODE}`]);
  });

  it('does nothing on a re-run when the open issue already reports the same content', async () => {
    const existing = {
      number: 7,
      title: 'renamed by a maintainer',
      body: changedIssueBody(CHANGED),
    };
    const { gh, writes } = fakeGh({ issues: [existing] });
    expect(await syncIssues(report([CHANGED]), gh)).toEqual([`#7 already reports ${DOCS}`]);
    expect(writes()).toEqual([]);
  });

  it('updates and comments when the source changed again', async () => {
    const existing = {
      number: 7,
      title: changedIssueTitle(DOCS),
      body: changedIssueBody({ ...CHANGED, current: H1 }),
    };
    const { gh, writes } = fakeGh({ issues: [existing] });
    const log = await syncIssues(report([CHANGED]), gh);
    expect(writes().map((args) => args.slice(0, 3))).toEqual([
      ['issue', 'edit', '7'],
      ['issue', 'comment', '7'],
    ]);
    expect(argAfter(writes()[0]!, '--body')).toBe(changedIssueBody(CHANGED));
    expect(argAfter(writes()[1]!, '--body')).toContain(`(it was \`${H1}\`)`);
    expect(log).toEqual([`updated #7 for ${DOCS}`]);
  });

  it('does not match an issue for another URL with the same prefix', async () => {
    const longer = { ...CHANGED, url: `${DOCS}-and-more` };
    const existing = { number: 3, title: 't', body: changedIssueBody(longer) };
    const { gh, writes } = fakeGh({ issues: [existing] });
    await syncIssues(report([CHANGED]), gh);
    expect(writes().map((args) => args.slice(0, 2))).toEqual([['issue', 'create']]);
  });

  it('opens one issue for all unreachable sources', async () => {
    const { gh, writes } = fakeGh();
    const log = await syncIssues(report([], [GONE, DOWN]), gh);
    expect(writes()).toHaveLength(1);
    expect(argAfter(writes()[0]!, '--title')).toBe(UNREACHABLE_TITLE);
    expect(argAfter(writes()[0]!, '--label')).toBe(LABEL);
    expect(log).toEqual(['opened an issue for 2 unreachable sources']);
  });

  it('leaves the unreachable issue alone when nothing changed', async () => {
    const existing = { number: 9, title: UNREACHABLE_TITLE, body: unreachableIssueBody([GONE]) };
    const { gh, writes } = fakeGh({ issues: [existing] });
    expect(await syncIssues(report([], [GONE]), gh)).toEqual([
      '#9 already lists the unreachable sources',
    ]);
    expect(writes()).toEqual([]);
  });

  it('edits the unreachable issue silently when only a reason changed', async () => {
    const existing = { number: 9, title: UNREACHABLE_TITLE, body: unreachableIssueBody([GONE]) };
    const { gh, writes } = fakeGh({ issues: [existing] });
    await syncIssues(report([], [{ ...GONE, reason: 'HTTP 410' }]), gh);
    expect(writes().map((args) => args.slice(0, 3))).toEqual([['issue', 'edit', '9']]);
  });

  it('edits and comments when the set of unreachable sources changed', async () => {
    const existing = { number: 9, title: UNREACHABLE_TITLE, body: unreachableIssueBody([GONE]) };
    const { gh, writes } = fakeGh({ issues: [existing] });
    await syncIssues(report([], [GONE, DOWN]), gh);
    expect(writes().map((args) => args.slice(0, 3))).toEqual([
      ['issue', 'edit', '9'],
      ['issue', 'comment', '9'],
    ]);
  });

  it('closes the unreachable issue when every source can be fetched again', async () => {
    const existing = { number: 9, title: UNREACHABLE_TITLE, body: unreachableIssueBody([GONE]) };
    const { gh, writes } = fakeGh({ issues: [existing] });
    const log = await syncIssues(report([]), gh, { runUrl: RUN });
    expect(writes()).toEqual([
      [
        'issue',
        'close',
        '9',
        '--comment',
        `Every cited source could be fetched in [this run](${RUN}).`,
      ],
    ]);
    expect(log).toEqual(['closed #9: every source can be fetched']);
  });

  it('does nothing when there is nothing to report', async () => {
    const { gh, writes } = fakeGh();
    expect(await syncIssues(report([]), gh)).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('fails on an unexpected issue list', async () => {
    const gh: RunGh = (args) =>
      Promise.resolve(args[0] === 'label' ? '[]' : args[1] === 'list' ? '[{"number":"x"}]' : '');
    await expect(syncIssues(report([]), gh)).rejects.toThrow('unexpected issue');
  });
});
