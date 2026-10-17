import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bashRuleMatches, coveredBy, parseToolRule } from '../../src/platforms/tool-rules.js';

describe('parseToolRule', () => {
  it('reads a bare tool name and a specifier as written', () => {
    expect(parseToolRule('Bash')).toEqual({ tool: 'Bash' });
    expect(parseToolRule('Bash(git status *)')).toEqual({
      tool: 'Bash',
      specifier: 'git status *',
    });
    expect(parseToolRule('Bash(echo (a))')).toEqual({ tool: 'Bash', specifier: 'echo (a)' });
    expect(parseToolRule('mcp__github__get_issue')).toEqual({ tool: 'mcp__github__get_issue' });
  });

  it('rejects what is not one well-formed rule', () => {
    for (const rule of ['', '(x)', 'Bash(git', 'Bash(x) y', '"*"', 'Bash Read', '9tool']) {
      expect(parseToolRule(rule), rule).toBeUndefined();
    }
  });
});

describe('coveredBy', () => {
  it('proves the documented cases', () => {
    const covered: [string, string][] = [
      ['Bash(git status *)', 'Bash'],
      ['Bash(git status *)', 'Bash(*)'],
      ['Bash', 'Bash(*)'],
      ['Bash(*)', 'Bash'],
      ['Bash(git push *)', 'Bash(git *)'],
      ['Bash(git push)', 'Bash(git *)'],
      ['Bash(git)', 'Bash(git *)'],
      ['Bash(git push *)', 'Bash(git:*)'],
      ['Bash(lsof)', 'Bash(ls*)'],
      ['Bash(ls -la *)', 'Bash(ls*)'],
      ['Bash(npm test)', 'Bash(npm test)'],
      ['Bash(git status *)', 'Bash(git status *)'],
      ['Write(docs/**)', 'Write'],
      ['Edit(src/**)', 'Edit'],
      ['PowerShell(Get-ChildItem *)', 'PowerShell(*)'],
      ['shell(git:*)', 'shell'],
    ];
    for (const [narrow, broad] of covered)
      expect(coveredBy(narrow, broad), `${narrow} ≤ ${broad}`).toBe(true);
  });

  it('fails closed on everything else', () => {
    const uncovered: [string, string][] = [
      ['Bash(git *)', 'Bash(git status *)'],
      ['Bash(npm test; curl x)', 'Bash(npm test)'],
      ['Bash(npm test *)', 'Bash(npm test)'],
      ['Bash(gitx)', 'Bash(git *)'],
      ['Bash(git*)', 'Bash(git *)'],
      ['Bash', 'Bash(git *)'],
      ['Bash(*)', 'Bash(git *)'],
      ['Bash(git log * main)', 'Bash(git *)'],
      ['Bash(git status *)', 'Bash(git * main)'],
      ['Bash(git status *)', 'Bash( * )'],
      ['Bash( git status *)', 'Bash(git *)'],
      ['Bash(git status *)', 'bash'],
      ['Bash(git status *)', 'Shell'],
      ['Write(docs/**)', 'Write(*)'],
      ['Write(docs/a.md)', 'Write(docs/**)'],
      ['WebFetch(domain:a.example.com)', 'WebFetch(domain:example.com)'],
      ['mcp__github__get_issue', 'mcp__github__*'],
      ['mcp__github__get_issue', 'mcp__github'],
      ['Bash(git', 'Bash'],
      ['Bash(git', 'Bash(git'],
      ['Read', 'Bash'],
    ];
    for (const [narrow, broad] of uncovered) {
      expect(coveredBy(narrow, broad), `${narrow} ≤ ${broad}`).toBe(false);
    }
  });

  it('is reflexive and transitive on Bash prefix rules', () => {
    const word = fc.constantFrom('git', 'status', 'npm', 'test', 'run', '-v', 'a.txt');
    const rule = fc
      .tuple(fc.array(word, { minLength: 1, maxLength: 4 }), fc.constantFrom('', ' *', ':*', '*'))
      .map(([words, tail]) => `Bash(${words.join(' ')}${tail})`);
    fc.assert(
      fc.property(rule, rule, rule, (a, b, c) => {
        expect(coveredBy(a, a)).toBe(true);
        if (coveredBy(a, b) && coveredBy(b, c)) expect(coveredBy(a, c)).toBe(true);
        expect(coveredBy(a, 'Bash')).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('never claims a rule covers a command it does not match', () => {
    const word = fc.constantFrom('git', 'status', 'push', 'gitx', '-v');
    const command = fc.array(word, { minLength: 1, maxLength: 3 }).map((words) => words.join(' '));
    const rule = fc
      .tuple(command, fc.constantFrom('', ' *', ':*', '*'))
      .map(([text, tail]) => `Bash(${text}${tail})`);
    fc.assert(
      fc.property(rule, rule, command, (narrow, broad, run) => {
        if (coveredBy(narrow, broad) && bashRuleMatches(narrow, run)) {
          expect(bashRuleMatches(broad, run)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('bashRuleMatches', () => {
  it('matches commands as Claude Code documents', () => {
    expect(bashRuleMatches('Bash', 'rm -rf build')).toBe(true);
    expect(bashRuleMatches('Bash(*)', 'anything')).toBe(true);
    expect(bashRuleMatches('Bash(npm run build)', 'npm run build')).toBe(true);
    expect(bashRuleMatches('Bash(npm run build)', 'npm run build --watch')).toBe(false);
    expect(bashRuleMatches('Bash(npm run *)', 'npm run')).toBe(true);
    expect(bashRuleMatches('Bash(npm run *)', 'npm run test --watch')).toBe(true);
    expect(bashRuleMatches('Bash(npm run *)', 'npm install')).toBe(false);
    expect(bashRuleMatches('Bash(ls *)', 'lsof')).toBe(false);
    expect(bashRuleMatches('Bash(ls*)', 'lsof')).toBe(true);
    expect(bashRuleMatches('Bash(ls:*)', 'ls -la')).toBe(true);
    expect(bashRuleMatches('Bash(git * main)', 'git push main')).toBe(false);
    expect(bashRuleMatches('Read', 'cat x')).toBe(false);
  });
});
