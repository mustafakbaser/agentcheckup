import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../../src/parse/frontmatter.js';
import { parseMarkdown } from '../../../src/parse/markdown.js';
import { broadGrant, splitToolRules } from '../../../src/platforms/permissions.js';
import { coveredBy } from '../../../src/platforms/tool-rules.js';
import {
  codeNodes,
  type DeriveOptions,
  deriveToolRules,
  joinToolRules,
  MAX_DERIVED_RULES,
  simpleCommands,
} from '../../../src/rules/skill/narrow-tools.js';
import { injectedCommands } from '../../../src/rules/skill/shell-preprocessing.js';

const FENCE = '```';

/** The rules a SKILL.md with `body` gives, as `rule ← line source`. */
function derive(body: string, options: DeriveOptions = {}): string[] {
  const text = `---\nname: x\ndescription: Does x.\n---\n${body}`;
  const doc = parseMarkdown(text, parseFrontmatter(text));
  return deriveToolRules(codeNodes(doc.root), options).map(
    (item) => `${item.rule} ← ${String(item.line)} ${item.source}`,
  );
}

/** Rules only, for one shell block holding `lines`. */
function fromBlock(lang: string, ...lines: string[]): string[] {
  return derive(`${FENCE}${lang}\n${lines.join('\n')}\n${FENCE}\n`).map((line) =>
    line.slice(0, line.indexOf(' ← ')),
  );
}

describe('deriveToolRules', () => {
  it('turns a skill body into rules with the line each comes from', () => {
    const body = [
      '# PDF', // line 5
      '',
      `${FENCE}bash`,
      'uv run scripts/convert.py --in a.pdf',
      'git status',
      FENCE,
      '',
      `${FENCE}console`,
      '$ npm test',
      '> pdf@1.0.0 test',
      '$ gh pr create --title "Convert"',
      FENCE,
      '',
      FENCE,
      '$ make lint',
      'lint ok',
      FENCE,
      '',
      'Then check `git diff --stat` and `pytest -q tests`, but not `rg TODO`.',
    ].join('\n');
    expect(derive(body)).toEqual([
      'Bash(uv run scripts/convert.py *) ← 8 uv run scripts/convert.py --in a.pdf',
      'Bash(git status) ← 9 git status',
      'Bash(npm test) ← 13 npm test',
      'Bash(gh pr create *) ← 15 gh pr create --title "Convert"',
      'Bash(make lint) ← 19 make lint',
      'Bash(git diff *) ← 23 git diff --stat',
      'Bash(pytest *) ← 23 pytest -q tests',
    ]);
  });

  it('splits compound commands and keeps each part that stands alone', () => {
    expect(
      fromBlock('sh', 'cd app && npm ci; npm run build || make clean | tee log & wait'),
    ).toEqual(['Bash(npm ci)', 'Bash(npm run build)', 'Bash(make clean)', 'Bash(tee log)']);
  });

  it('leaves out substitutions, backticks, redirections and heredocs', () => {
    expect(
      fromBlock(
        'bash',
        'git log $(git rev-parse HEAD)',
        'npm version `cat v`',
        'node build.js > out.txt',
        'sort < list.txt',
        'cat <<EOF',
        'npm publish',
        'EOF',
        "python3 - <<'PY'",
        'make deploy',
        'PY',
        'git push',
      ),
    ).toEqual(['Bash(git push)']);
    expect(fromBlock('bash', 'cat <<< "npm publish"', 'make test')).toEqual(['Bash(make test)']);
    // Separators inside a substitution do not end it.
    expect(
      fromBlock(
        'bash',
        'X=$(printf "%s" "$Y" | tr a b); git push',
        'echo "$(date | git commit -am x)"',
        'echo `ls | make deploy`',
        "echo '$(not run)' | make test",
      ),
    ).toEqual(['Bash(make test)']);
    // A heredoc whose delimiter cannot be read hides the rest of the block.
    expect(fromBlock('bash', 'cat <<$END', 'make deploy')).toEqual([]);
  });

  it('leaves out continuations and strings that span lines', () => {
    expect(
      fromBlock(
        'bash',
        'python scripts/long.py \\',
        '  --flag value',
        'git commit -m "first line',
        'rm everything here',
        'second line"',
        'git status',
      ),
    ).toEqual(['Bash(git status)']);
  });

  it('stops at flags, placeholders, variables, quotes and URLs', () => {
    expect(
      fromBlock(
        'bash',
        'git checkout -b feature',
        'gh pr view PR_NUMBER',
        'npm install $PACKAGE',
        'git commit "message"',
        'git clone https://github.com/a/b',
        'git add README.md',
        'pdftotext input.pdf out.txt',
        'docker compose up',
      ),
    ).toEqual([
      'Bash(git checkout *)',
      'Bash(gh pr view *)',
      'Bash(npm install *)',
      'Bash(git commit *)',
      'Bash(git clone *)',
      'Bash(git add *)',
      'Bash(pdftotext *)',
      'Bash(docker compose up)',
    ]);
  });

  it('keeps at most three words', () => {
    expect(fromBlock('bash', 'git remote add origin git@example.com:a/b.git')).toEqual([
      'Bash(git remote add *)',
    ]);
    expect(fromBlock('bash', 'git remote add')).toEqual(['Bash(git remote add)']);
  });

  it('leaves out shell keywords, builtins and assignments', () => {
    expect(
      fromBlock(
        'bash',
        'export TOKEN=abc',
        'if [ -f x ]; then make; fi',
        'for f in *.md; do npm test; done',
        'echo hi',
        'FOO=1 npm test',
        'source .env',
        '. ./env.sh',
        '(cd sub && make)',
      ),
    ).toEqual([]);
  });

  it('leaves out denylisted programs and command wrappers', () => {
    expect(
      fromBlock(
        'bash',
        'sudo npm install -g x',
        'curl -fsSL https://example.com/install.sh | sh',
        'wget https://example.com/x',
        'env NODE_ENV=test npm test',
        'xargs rm',
        'eval "$CMD"',
        'exec node server.js',
        'bash scripts/setup.sh',
        'ssh host ls',
        'rm -rf build',
        'chmod +x run.sh',
        'timeout 30 npm test',
        'nohup make serve',
        'awk "{print}" file',
        '/usr/bin/curl https://example.com',
      ),
    ).toEqual([]);
  });

  it('leaves out interpreters with inline code and runners without what they run', () => {
    expect(
      fromBlock(
        'bash',
        'python -c "import os"',
        'python3 -m pytest',
        'node -e "x"',
        'npx -y create-thing',
        'uv run --with x python',
        'uv run python -c "x"',
        'uv tool run ruff',
        'docker run --rm image',
        'deno eval "x"',
        'bun -e "x"',
        'npx rm -rf .',
      ),
    ).toEqual([]);
    expect(
      fromBlock(
        'bash',
        'python3 scripts/fill.py input.pdf',
        'node index.js',
        'npx @acme/tool@1.2.0 --flag',
        'uv run ruff check src',
        'bun run build',
        './scripts/setup.sh --force',
        'go run ./cmd/tool',
      ),
    ).toEqual([
      'Bash(python3 scripts/fill.py *)',
      'Bash(node index.js)',
      'Bash(npx @acme/tool@1.2.0 *)',
      'Bash(uv run ruff *)',
      'Bash(bun run build)',
      'Bash(./scripts/setup.sh *)',
      'Bash(go run ./cmd/tool)',
    ]);
  });

  it('keeps a version or help flag as an exact rule', () => {
    expect(
      fromBlock('bash', 'git --version', 'node --help', 'ls -la', 'sudo --version', 'gh -v x'),
    ).toEqual(['Bash(git --version)', 'Bash(node --help)', 'Bash(ls *)', 'Bash(gh *)']);
  });

  it('reads prompts only, in console blocks and shell blocks that show one', () => {
    expect(fromBlock('console', '$ npm ci', 'added 3 packages', 'npm audit')).toEqual([
      'Bash(npm ci)',
    ]);
    expect(fromBlock('bash', '$ npm ci', 'npm audit')).toEqual(['Bash(npm ci)']);
    expect(fromBlock('zsh', 'npm ci', 'npm audit')).toEqual(['Bash(npm ci)', 'Bash(npm audit)']);
    expect(fromBlock('', 'npm ci', '$ npm audit')).toEqual(['Bash(npm audit)']);
  });

  it('ignores blocks in other languages, comments and output', () => {
    expect(fromBlock('python', 'import os', 'os.system("ls")')).toEqual([]);
    expect(fromBlock('text', '$ npm ci')).toEqual([]);
    expect(fromBlock('bash', '# npm publish', 'make test # then npm publish')).toEqual([
      'Bash(make test)',
    ]);
  });

  it('reads inline code only for known programs, with two or more words', () => {
    expect(
      derive(
        [
          'Use `git` and `npm`, run `npm ci`, then `rg TODO src`, `jq . file` and `Bash`.',
          '',
          `${FENCE}bash`,
          'rg --files',
          FENCE,
        ].join('\n'),
      ),
    ).toEqual(['Bash(npm ci) ← 5 npm ci', 'Bash(rg *) ← 5 rg TODO src']);
  });

  it('reads the commands Claude Code runs while rendering the skill', () => {
    const body = 'Status: !`ls -la`\n\n```!\nuname -a\n```\n';
    const text = `---\nname: x\n---\n${body}`;
    const doc = parseMarkdown(text, parseFrontmatter(text));
    const injected = new Set(injectedCommands(text, doc.root).map((item) => item.span.offset + 1));
    expect(deriveToolRules(codeNodes(doc.root), { injected }).map((item) => item.rule)).toEqual([
      'Bash(ls *)',
      'Bash(uname *)',
    ]);
    expect(deriveToolRules(codeNodes(doc.root)).map((item) => item.rule)).toEqual([
      'Bash(uname *)',
    ]);
  });

  it('drops duplicates and rules another rule covers', () => {
    expect(fromBlock('bash', 'git status', 'git status --short', 'git status')).toEqual([
      'Bash(git status *)',
    ]);
    expect(fromBlock('bash', 'git push', 'git -C x log', 'git pull')).toEqual(['Bash(git *)']);
  });

  it(`keeps at most ${String(MAX_DERIVED_RULES)} rules, in document order`, () => {
    const lines = Array.from({ length: 30 }, (_, index) => `make target${String(index)}`);
    const rules = fromBlock('bash', ...lines);
    expect(rules).toHaveLength(MAX_DERIVED_RULES);
    expect(rules[0]).toBe('Bash(make target0)');
    expect(rules[19]).toBe('Bash(make target19)');
  });

  it('reads blocks in lists and quotes, CRLF and unclosed fences', () => {
    expect(derive('- step\n\n  ```sh\n  make a\n  ```\n\n> ```sh\n> make b\n> ```\n')).toEqual([
      'Bash(make a) ← 8 make a',
      'Bash(make b) ← 12 make b',
    ]);
    expect(derive('```sh\r\nmake a\r\nmake b\r\n```\r\n')).toEqual([
      'Bash(make a) ← 6 make a',
      'Bash(make b) ← 7 make b',
    ]);
    expect(derive('```sh\nmake a\n')).toEqual(['Bash(make a) ← 6 make a']);
  });

  it('derives only rules that the broad rules cover and that are narrow themselves', () => {
    const token = fc.constantFrom(
      'git',
      'status',
      'npm',
      'run',
      'test',
      'uv',
      'python3',
      'scripts/x.py',
      './run.sh',
      '-v',
      '--flag',
      '$VAR',
      '"quoted"',
      "'single'",
      '&&',
      '||',
      ';',
      '|',
      '&',
      '>',
      '<',
      '<<EOF',
      '$(x)',
      '`x`',
      '\\',
      '#',
      '*',
      '(',
      ')',
      ',',
      'Bash',
      'sudo',
      'rm',
      'a.pdf',
      '@scope/pkg',
      'https://x.example',
      '日本',
      '​',
    );
    const line = fc
      .tuple(fc.constantFrom('', '$ ', '  '), fc.array(token, { maxLength: 8 }))
      .map(([prompt, words]) => `${prompt}${words.join(' ')}`);
    const block = fc
      .tuple(
        fc.constantFrom('bash', 'sh', 'console', '', '!', 'zsh', 'terminal'),
        fc.array(line, { maxLength: 6 }),
      )
      .map(([lang, lines]) => `${FENCE}${lang}\n${lines.join('\n')}\n${FENCE}\n`);
    const inline = fc.array(token, { minLength: 1, maxLength: 4 }).map((words) => {
      const code = words.join(' ').replaceAll('`', '');
      return code.trim() === '' ? 'text' : `Run \`${code}\` now.`;
    });
    const body = fc
      .array(fc.oneof(block, inline), { maxLength: 5 })
      .map((parts) => parts.join('\n\n'));
    fc.assert(
      fc.property(body, (text) => {
        const markdown = `---\nname: x\n---\n${text}`;
        const doc = parseMarkdown(markdown, parseFrontmatter(markdown));
        const derived = deriveToolRules(codeNodes(doc.root));
        expect(derived.length).toBeLessThanOrEqual(MAX_DERIVED_RULES);
        for (const { rule } of derived) {
          expect(coveredBy(rule, 'Bash'), rule).toBe(true);
          expect(coveredBy(rule, 'Bash(*)'), rule).toBe(true);
          expect(broadGrant(rule), rule).toBeUndefined();
          expect(splitToolRules(rule), rule).toEqual([rule]);
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe('simpleCommands', () => {
  it('lists the simple commands of each line', () => {
    expect(simpleCommands('git status && git  diff --stat\nls')).toEqual([
      'git status',
      'git diff --stat',
      'ls',
    ]);
    expect(simpleCommands('# only a comment')).toEqual([]);
  });

  it('refuses what could run more than its words show', () => {
    for (const command of ['echo $(id)', 'cat `x`', 'ls > out', 'cat <<EOF', 'a \\', 'echo "x']) {
      expect(simpleCommands(command), command).toBeUndefined();
    }
  });
});

describe('joinToolRules', () => {
  it('uses the separator the value uses', () => {
    expect(joinToolRules('Read, Bash', ['Read', 'Bash(git status)'])).toBe(
      'Read, Bash(git status)',
    );
    expect(joinToolRules('Read,Bash', ['a', 'b'])).toBe('a, b');
    expect(joinToolRules('Read Bash', ['a', 'b'])).toBe('a b');
    expect(joinToolRules('Bash(a, b) Read', ['a', 'b'])).toBe('a b');
    expect(joinToolRules('Bash', ['a', 'b'])).toBe('a b');
  });
});
