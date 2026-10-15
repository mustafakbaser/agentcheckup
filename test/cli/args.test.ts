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
});
