import { describe, expect, it } from 'vitest';
import { parseCommand, UsageError } from '../../src/cli/args.js';

describe('parseCommand', () => {
  it('defaults to scanning the current directory', () => {
    expect(parseCommand([])).toEqual({
      kind: 'scan',
      options: {
        path: '.',
        format: 'stylish',
        output: undefined,
        targets: undefined,
        failOn: 'error',
        minScore: undefined,
        config: undefined,
        useConfig: true,
        untrusted: false,
        gitignore: true,
        showSuppressed: false,
        color: undefined,
        baseline: undefined,
        gate: [],
        contextWindow: undefined,
        context: false,
      },
    });
  });

  it('parses every scan option', () => {
    const command = parseCommand([
      'repo',
      '--format',
      'sarif',
      '-o',
      'out.sarif',
      '--targets',
      'codex, claude-code',
      '--fail-on',
      'warn',
      '--min-score',
      '80',
      '--config',
      'ac.json',
      '--no-gitignore',
      '--show-suppressed',
      '--no-color',
    ]);
    expect(command).toMatchObject({
      kind: 'scan',
      options: {
        path: 'repo',
        format: 'sarif',
        output: 'out.sarif',
        targets: ['codex', 'claude-code'],
        failOn: 'warn',
        minScore: 80,
        config: 'ac.json',
        useConfig: true,
        gitignore: false,
        showSuppressed: true,
        color: false,
      },
    });
  });

  it('makes --untrusted ignore the repository config', () => {
    expect(parseCommand(['--untrusted'])).toMatchObject({
      options: { untrusted: true, useConfig: false },
    });
  });

  it('recognizes subcommands and flags', () => {
    expect(parseCommand(['--help'])).toEqual({ kind: 'help' });
    expect(parseCommand(['-v'])).toEqual({ kind: 'version' });
    expect(parseCommand(['rules'])).toEqual({ kind: 'rules', format: 'text' });
    expect(parseCommand(['rules', '--json'])).toEqual({ kind: 'rules', format: 'json' });
    expect(parseCommand(['explain', 'skill/name-format'])).toEqual({
      kind: 'explain',
      ruleId: 'skill/name-format',
    });
  });

  it.each([
    [['--format', 'xml']],
    [['--targets', 'vim']],
    [['--targets', ' , ']],
    [['--fail-on', 'fatal']],
    [['--min-score', '101']],
    [['--min-score', '7.5']],
    [['a', 'b']],
    [['--config', 'x.json', '--no-config']],
    [['--color', '--no-color']],
    [['explain']],
    [['explain', 'a', 'b']],
    [['rules', 'extra']],
  ])('rejects %j with a usage error', (argv) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
  });

  it('rejects unknown flags', () => {
    expect(() => parseCommand(['--nope'])).toThrow(/Unknown option/);
  });

  it('parses --context, --baseline, --gate and --context-window on a scan', () => {
    expect(
      parseCommand([
        '--context',
        '--context-window',
        '200000',
        '--baseline',
        'base.json',
        '--gate',
        'hooks, mcp',
      ]),
    ).toMatchObject({
      kind: 'scan',
      options: {
        context: true,
        contextWindow: 200_000,
        baseline: 'base.json',
        gate: ['hooks', 'mcp'],
      },
    });
    expect(parseCommand(['--baseline', 'b.json', '--gate', 'security'])).toMatchObject({
      options: { gate: ['env', 'hooks', 'mcp', 'mcp-unpinned', 'permissions', 'unicode'] },
    });
    expect(parseCommand(['--baseline', 'b.json', '--gate', 'none'])).toMatchObject({
      options: { gate: [] },
    });
  });

  it.each([
    [['--gate', 'mcp'], /--gate needs --baseline/],
    [['--gate', 'none'], /--gate needs --baseline/],
    [['--baseline', 'b.json', '--gate', 'mcp,typo'], /Unknown gate class "typo"/],
    [['--baseline', 'b.json', '--gate', 'none,mcp'], /"none" cannot be combined/],
    [['--baseline', 'b.json', '--gate', 'mcp,,hooks'], /Empty gate class/],
    [['--context-window', '1000'], /--context-window needs --context/],
    [['--agent', 'codex'], /--agent works only with the context command/],
    [['--cwd', 'packages'], /--cwd works only with the context command/],
    [['--matrix'], /--matrix works only with the context command/],
  ])('rejects scan flags %j', (argv, message) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
    expect(() => parseCommand(argv)).toThrow(message);
  });
});

describe('parseCommand: context', () => {
  it('defaults to the text plans of every modeled target at the root', () => {
    expect(parseCommand(['context'])).toEqual({
      kind: 'context',
      options: {
        path: '.',
        format: 'text',
        output: undefined,
        config: undefined,
        useConfig: true,
        untrusted: false,
        gitignore: true,
        color: undefined,
        baseline: undefined,
        gate: [],
        contextWindow: undefined,
        agents: undefined,
        cwd: '',
        matrix: false,
      },
    });
  });

  it('parses every context option', () => {
    expect(
      parseCommand([
        'context',
        'repo',
        '--agent',
        'cursor, claude-code,cursor',
        '--cwd',
        './packages//api/',
        '--context-window',
        '1000000',
        '--format',
        'markdown',
        '-o',
        'plans.md',
        '--baseline',
        'base.json',
        '--gate',
        'mcp-unpinned',
        '--untrusted',
        '--no-gitignore',
        '--color',
      ]),
    ).toEqual({
      kind: 'context',
      options: {
        path: 'repo',
        format: 'markdown',
        output: 'plans.md',
        config: undefined,
        useConfig: false,
        untrusted: true,
        gitignore: false,
        color: true,
        baseline: 'base.json',
        gate: ['mcp-unpinned'],
        contextWindow: 1_000_000,
        // In CONTEXT_AGENTS order, without repeats.
        agents: ['claude-code', 'cursor'],
        cwd: 'packages/api',
        matrix: false,
      },
    });
  });

  it('accepts --matrix at the root, given as "." or not at all', () => {
    expect(parseCommand(['context', '--matrix'])).toMatchObject({
      options: { matrix: true, cwd: '' },
    });
    expect(parseCommand(['context', '--matrix', '--cwd', '.'])).toMatchObject({
      options: { matrix: true, cwd: '' },
    });
  });

  it('normalizes --cwd with either separator', () => {
    expect(parseCommand(['context', '--cwd', 'a\\b\\.\\c'])).toMatchObject({
      options: { cwd: 'a/b/c' },
    });
  });

  it('shows the context help and the version', () => {
    expect(parseCommand(['context', '--help'])).toEqual({ kind: 'help', topic: 'context' });
    expect(parseCommand(['context', '-h', '--agent', 'nope'])).toEqual({
      kind: 'help',
      topic: 'context',
    });
    expect(parseCommand(['context', '--version'])).toEqual({ kind: 'version' });
  });

  it.each([
    [['context', '--agent', 'copilot'], /does not model what copilot loads yet/],
    [['context', '--agent', 'vim'], /Unknown agent "vim"/],
    [['context', '--agent', ' , '], /--agent needs at least one agent/],
    [['context', '--cwd', '../other'], /"\.\." is not allowed/],
    [['context', '--cwd', 'packages/../../x'], /"\.\." is not allowed/],
    [['context', '--cwd', '/etc'], /not an absolute path/],
    [['context', '--cwd', '\\\\server\\share'], /not an absolute path/],
    [['context', '--cwd', 'C:\\repo'], /not an absolute path/],
    [['context', '--cwd', 'a\u0000b'], /NUL/],
    [['context', '--matrix', '--cwd', 'packages'], /--matrix covers the whole repository/],
    [['context', '--context-window', '0'], /positive whole number/],
    [['context', '--context-window=-5'], /positive whole number/],
    [['context', '--context-window', '1.5'], /positive whole number/],
    [['context', '--context-window', '1e6'], /positive whole number/],
    [['context', '--context-window', '99999999999999999'], /positive whole number/],
    [['context', '--format', 'stylish'], /--format must be one of: text, json, markdown/],
    [['context', '--format', 'sarif'], /--format must be one of/],
    [['context', '--targets', 'codex'], /--targets does not apply to the context command/],
    [['context', '--fail-on', 'warn'], /--fail-on does not apply/],
    [['context', '--min-score', '50'], /--min-score does not apply/],
    [['context', '--show-suppressed'], /--show-suppressed does not apply/],
    [['context', '--context'], /--context does not apply/],
    [['context', '--gate', 'mcp'], /--gate needs --baseline/],
    [['context', 'a', 'b'], /at most one path/],
    [['context', '--config', 'x.json', '--no-config'], /cannot be combined/],
    [['context', '--color', '--no-color'], /cannot be combined/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
    expect(() => parseCommand(argv)).toThrow(message);
  });
});
