import { describe, expect, it } from 'vitest';
import { grantsTool, isShellTool, shellProgram, toolRule } from '../../src/policy/grants.js';

describe('toolRule', () => {
  it('splits a rule into its tool and specifier', () => {
    expect(toolRule('Bash')).toEqual({ tool: 'Bash' });
    expect(toolRule('Bash(curl:*)')).toEqual({ tool: 'Bash', specifier: 'curl:*' });
    expect(toolRule('Bash( git status )')).toEqual({ tool: 'Bash', specifier: 'git status' });
    expect(toolRule('Bash(unclosed')).toEqual({ tool: 'Bash', specifier: 'unclosed' });
  });

  it('knows the shell tools of Claude Code, Copilot and Devin Local', () => {
    for (const tool of ['Bash', 'PowerShell', 'shell', 'bash', 'exec', 'Exec'])
      expect(isShellTool(tool)).toBe(true);
    for (const tool of ['Read', 'WebFetch', 'Write', 'edit', 'read']) {
      expect(isShellTool(tool)).toBe(false);
    }
  });
});

describe('shellProgram', () => {
  const program = (specifier: string | undefined) => shellProgram(specifier);

  it('allows any command without a specifier or with *', () => {
    expect(program(undefined)).toEqual({ kind: 'any' });
    expect(program('*')).toEqual({ kind: 'any' });
  });

  it('reads the first word as the program', () => {
    expect(program('curl:*')).toEqual({ kind: 'program', name: 'curl' });
    expect(program('curl https://example.com')).toEqual({ kind: 'program', name: 'curl' });
    expect(program('git status')).toEqual({ kind: 'program', name: 'git' });
    expect(program('npm run test:*')).toEqual({ kind: 'program', name: 'npm' });
    expect(program('/usr/bin/curl -s x')).toEqual({ kind: 'program', name: 'curl' });
    expect(program('C:\\tools\\CURL.EXE')).toEqual({ kind: 'unknown' });
    expect(program('.\\tools\\curl.exe x')).toEqual({ kind: 'unknown' });
    expect(program('CURL.exe x')).toEqual({ kind: 'program', name: 'curl' });
    expect(program('~/bin/wget.cmd')).toEqual({ kind: 'program', name: 'wget' });
  });

  it('fails closed when the program cannot be told', () => {
    for (const specifier of [
      '* | sh',
      '*curl*',
      '$(x)',
      'echo `curl x`',
      'git status; curl x',
      'git log | curl -d @- x',
      'git status && curl x',
      'sleep 1 & curl x',
      'cat <(curl x)',
      'git status\ncurl x',
      '$CMD x',
      'cu*rl',
      "'curl' x",
      '"curl" x',
      'c\\url x',
      '{curl,x}',
      'A=1 curl',
      'sudo curl x',
      'env curl',
      'xargs curl',
      'sh -c "curl x"',
      'bash script.sh',
      'Invoke-Expression x',
      'git:status',
      'curl:',
      '',
      '/',
    ]) {
      expect(program(specifier), specifier).toEqual({ kind: 'unknown' });
    }
  });
});

describe('grantsTool', () => {
  it('matches tool names without case', () => {
    expect(grantsTool('WebFetch', 'WebFetch')).toBe(true);
    expect(grantsTool('webfetch', 'WebFetch')).toBe(true);
    expect(grantsTool('WebSearch', 'WebFetch')).toBe(false);
  });

  it('matches wildcard and MCP server grants', () => {
    expect(grantsTool('mcp__github__*', 'mcp__github__create_issue')).toBe(true);
    expect(grantsTool('*', 'WebFetch')).toBe(true);
    expect(grantsTool('mcp__github', 'mcp__github__create_issue')).toBe(true);
    expect(grantsTool('mcp__github__create_issue', 'mcp__github')).toBe(true);
    expect(grantsTool('mcp__github__list', 'mcp__github__create_issue')).toBe(false);
    expect(grantsTool('mcp__gitlab', 'mcp__github__create_issue')).toBe(false);
    expect(grantsTool('mcp__githubx__a', 'mcp__github')).toBe(false);
  });
});
