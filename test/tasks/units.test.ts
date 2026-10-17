import { describe, expect, it } from 'vitest';
import { anchorOf, buildTasks } from '../../src/tasks/build.js';
import { forYouReason } from '../../src/tasks/for-you.js';
import { redactSecrets } from '../../src/tasks/redact.js';
import { agentcheckupCommand, codeSpan, shellWord, tildeFence } from '../../src/tasks/text.js';
import { GITHUB_TOKEN, scanOf } from './fixture.js';

describe('codeSpan', () => {
  it('delimits text with more backticks than any run inside', () => {
    expect(codeSpan('a/b.md')).toBe('`a/b.md`');
    expect(codeSpan('a`b')).toBe('``a`b``');
    expect(codeSpan('`a')).toBe('`` `a ``');
    expect(codeSpan('a```')).toBe('```` a``` ````');
  });

  it('renders line breaks and hidden characters visibly', () => {
    expect(codeSpan('a\nb\u001B[0m‮c')).toBe('`a⏎b<U+001B>[0m<U+202E>c`');
  });
});

describe('tildeFence', () => {
  it('is at least four tildes and longer than any run inside', () => {
    expect(tildeFence('plain')).toBe('~~~~');
    expect(tildeFence('a ~~~~~ b')).toBe('~~~~~~');
  });
});

describe('shellWord', () => {
  it('keeps a plain path and quotes everything else', () => {
    expect(shellWord('')).toBe('');
    expect(shellWord('packages/web')).toBe('packages/web');
    expect(shellWord('../other-repo')).toBe('../other-repo');
    expect(shellWord('my repo')).toBe("'my repo'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
    expect(shellWord('$(rm -rf ~)')).toBe("'$(rm -rf ~)'");
    expect(shellWord('~/repo')).toBe("'~/repo'");
  });

  it('never lets a path read as an option', () => {
    expect(shellWord('--output=x')).toBe("'./--output=x'");
  });

  it('builds pinned commands', () => {
    expect(agentcheckupCommand('1.0.0', 'tasks', "'my repo'", ['--check'])).toBe(
      "npx agentcheckup@1.0.0 tasks 'my repo' --check",
    );
  });
});

describe('forYouReason', () => {
  it('leaves credentials, hidden content and security configuration to the user', () => {
    expect(forYouReason('mcp/literal-secret', 'mcp-json')).toBe('credential');
    expect(forYouReason('risk/hidden-comment', 'skill')).toBe('hidden-content');
    expect(forYouReason('risk/remote-script-execution', 'agents-md')).toBe('security');
    expect(forYouReason('skill/shell-preprocessing', 'skill')).toBe('security');
    expect(forYouReason('json/invalid-syntax', 'claude-settings')).toBe('security');
    expect(forYouReason('instr/import-unresolved', undefined)).toBe('security');
  });

  it('hands other findings in Markdown files to an agent', () => {
    expect(forYouReason('skill/description-quality', 'skill')).toBeUndefined();
    expect(forYouReason('directive/missing-reason', 'agents-md')).toBeUndefined();
  });
});

describe('redactSecrets', () => {
  it('replaces every credential and says so', () => {
    expect(redactSecrets(`a ${GITHUB_TOKEN} b ${GITHUB_TOKEN}`)).toEqual({
      text: 'a ghp_…(40 chars) b ghp_…(40 chars)',
      redacted: true,
    });
    expect(redactSecrets('nothing here')).toEqual({ text: 'nothing here', redacted: false });
  });
});

describe('anchorOf', () => {
  it('points at the line without an artifact or valid frontmatter', () => {
    const scan = scanOf({ 'AGENTS.md': '# Project\n\nWrite clean code.\n' });
    const [finding] = scan.findings;
    if (finding === undefined) throw new Error('no finding');
    expect(anchorOf(finding, undefined, scan.analysis)).toEqual({ kind: 'line' });
    const artifact = scan.analysis.index.get('AGENTS.md');
    expect(anchorOf(finding, artifact, scan.analysis)).toEqual({ kind: 'line' });
  });

  it('points at the body for a finding below valid frontmatter', () => {
    const scan = scanOf({
      '.claude/skills/deploy/SKILL.md':
        '---\nname: deploy\ndescription: Deploys the API. Use when the user asks to deploy.\n---\n# Deploy\n\nSee [the runbook](runbook.md).\n',
    });
    const finding = scan.findings.find(
      (candidate) => candidate.ruleId === 'skill/broken-reference',
    );
    if (finding === undefined) throw new Error('no finding');
    const artifact = scan.analysis.index.get('.claude/skills/deploy/SKILL.md');
    expect(anchorOf(finding, artifact, scan.analysis)).toEqual({ kind: 'line' });
  });
});

describe('the outline of a long skill body', () => {
  it('counts the text before the first heading and reads headings without their syntax', () => {
    const body = ['Intro line.', '', '## The `deploy` **command**', ''];
    for (let i = 0; i < 520; i++) body.push(`Step ${i}.`);
    body.push('', `## Token ${GITHUB_TOKEN} [link](x.md)`, '', 'End.');
    const scan = scanOf({
      '.claude/skills/guide/SKILL.md': `---\nname: guide\ndescription: Explains the guide. Use when the user asks about it.\n---\n${body.join('\n')}\n`,
    });
    const task = buildTasks(scan).tasks.find(
      (candidate) => candidate.ruleId === 'skill/body-too-long',
    );
    expect(task?.excerpt).toEqual({
      kind: 'outline',
      text: [
        '(before the first heading: 2 lines)',
        '## The deploy command (523 lines, from line 7)',
        '## Token ghp_…(40 chars) link (3 lines, from line 530)',
      ].join('\n'),
      truncated: false,
      redacted: true,
    });
  });

  it('is cut after 40 headings', () => {
    const body: string[] = [];
    for (let i = 0; i < 60; i++)
      body.push(`## Part ${i}`, '', ...Array.from({ length: 9 }, () => 'Text.'));
    const scan = scanOf({
      '.claude/skills/guide/SKILL.md': `---\nname: guide\ndescription: Explains the guide. Use when the user asks about it.\n---\n${body.join('\n')}\n`,
    });
    const task = buildTasks(scan).tasks.find(
      (candidate) => candidate.ruleId === 'skill/body-too-long',
    );
    expect(task?.excerpt?.text.split('\n')).toHaveLength(40);
    expect(task?.excerpt?.truncated).toBe(true);
  });
});
