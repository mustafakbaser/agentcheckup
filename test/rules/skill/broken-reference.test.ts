import { describe, expect, it } from 'vitest';
import {
  brokenReferenceRule,
  relativeLinkPath,
} from '../../../src/rules/skill/broken-reference.js';
import { findings, lint, type LintOptions } from '../../helpers/lint.js';

const ID = 'skill/broken-reference';
const SKILL = 'skills/pdf/SKILL.md';
const FRONTMATTER = '---\nname: pdf\ndescription: PDF tools.\n---\n';

function check(body: string, options: Partial<LintOptions> = {}, path = SKILL) {
  const result = lint({ [path]: FRONTMATTER + body }, { rules: [brokenReferenceRule], ...options });
  findings(result, ID);
  return result.findings.map((f) => ({
    severity: f.severity,
    platforms: f.platforms,
    message: f.message,
    range: f.range,
  }));
}

describe('skill/broken-reference', () => {
  it('reports a link to a missing file', () => {
    expect(check('See [the API](references/api.md) for details.\n')).toEqual([
      {
        severity: 'error',
        platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini', 'windsurf', 'cline'],
        message:
          'Linked file "references/api.md" does not exist, so an agent that follows the link finds nothing.',
        range: { start: { line: 5, column: 5 }, end: { line: 5, column: 33 } },
      },
    ]);
  });

  it('accepts links to files and directories that exist', () => {
    const paths = [
      'skills/pdf/references/api.md',
      'skills/pdf/scripts/run.sh',
      'skills/pdf/my file.md',
      'skills/pdf/kılavuz.md',
    ];
    expect(
      check(
        '[a](references/api.md) [b](./references/api.md#usage) [c](references/api.md?raw=1)\n[d](scripts/) [e](my%20file.md) [f](<my file.md>) [g](kılavuz.md) [h](./SKILL.md) [i](.)\n',
        { paths },
      ),
    ).toEqual([]);
  });

  it('checks images and link definitions', () => {
    expect(
      check('![diagram](assets/flow.png)\n\n[ref]: docs/ref.md\n').map((f) => f.message),
    ).toEqual([
      'Linked file "assets/flow.png" does not exist, so an agent that follows the link finds nothing.',
      'Linked file "docs/ref.md" does not exist, so an agent that follows the link finds nothing.',
    ]);
  });

  it('ignores links that are not relative file paths', () => {
    expect(
      check(
        [
          '[web](https://example.com/x.md) [mail](mailto:a@b.c) [anchor](#usage) [abs](/etc/x.md)',
          '[home](~/notes.md) [tpl](${CLAUDE_SKILL_DIR}/x.md) [ph](path/to/<name>.md) [glob](docs/*.md)',
          '[win](C:\\docs\\x.md) [proto](//cdn.example.com/x.js) [empty]() [query](?x=1) [bad](%E0%A4%A.md)',
          '`[code](missing.md)`',
          '',
          '```md',
          '[fenced](missing.md)',
          '```',
        ].join('\n') + '\n',
      ),
    ).toEqual([]);
  });

  it('warns about links that leave the skill directory', () => {
    expect(check('[style](../shared/style.md)\n', { paths: ['skills/shared/style.md'] })).toEqual([
      {
        severity: 'warn',
        platforms: ['claude-code', 'codex', 'cursor', 'copilot', 'gemini', 'windsurf', 'cline'],
        message:
          'Link "../shared/style.md" leaves the skill directory, so it breaks when the skill is installed or uploaded on its own.',
        range: { start: { line: 5, column: 1 }, end: { line: 5, column: 28 } },
      },
    ]);
    // Climbing above the scan root: existence is unknown, leaving the skill directory is not.
    expect(check('[x](../../../outside.md)\n')[0]?.severity).toBe('warn');
  });

  it('warns about leaving the skill directory only for skills uploaded on their own', () => {
    const body = '[agents](../../../AGENTS.md)\n';
    expect(check(body, { paths: ['AGENTS.md'] }, '.agents/skills/publish/SKILL.md')).toEqual([]);
    expect(
      check(
        '[ref](../../references/x.md)\n',
        { paths: ['plugin/references/x.md', 'plugin/.claude-plugin/plugin.json'] },
        'plugin/skills/x/SKILL.md',
      ),
    ).toEqual([]);
    // A missing target is reported wherever the skill lives.
    expect(check(body, {}, '.agents/skills/publish/SKILL.md')[0]?.severity).toBe('error');
  });

  it('accepts repository-root paths, which agents running in the repository resolve', () => {
    const body = '[authz](dev_docs/key_concepts/api_authorization.mdx)\n';
    const paths = ['dev_docs/key_concepts/api_authorization.mdx'];
    expect(check(body, { paths }, '.agents/skills/api-authz/SKILL.md')).toEqual([]);
    expect(check(body, { paths })).toEqual([
      expect.objectContaining({
        severity: 'info',
        message:
          'Linked file "dev_docs/key_concepts/api_authorization.mdx" exists only relative to the repository root, not to the skill directory. The link breaks when the skill is installed or uploaded on its own.',
      }),
    ]);
    expect(check(body, {}, '.agents/skills/api-authz/SKILL.md')[0]?.severity).toBe('error');
  });

  it('accepts links that resolve from the real file of a symlinked SKILL.md', () => {
    const text = `${FRONTMATTER}[owner](cs-owner.md) [team](../../team/CLAUDE.md)\n`;
    const result = lint(
      { '.gemini/skills/pm/SKILL.md': text },
      {
        rules: [brokenReferenceRule],
        symlinks: { '.gemini/skills/pm/SKILL.md': 'agents/product/pm.md' },
        paths: ['agents/product/cs-owner.md', 'team/CLAUDE.md'],
      },
    );
    expect(findings(result, ID)).toEqual([]);
  });

  it('gives the case hint for a symlinked SKILL.md from its real directory', () => {
    const result = lint(
      { '.gemini/skills/pm/SKILL.md': `${FRONTMATTER}[template](template.md)\n` },
      {
        rules: [brokenReferenceRule],
        symlinks: { '.gemini/skills/pm/SKILL.md': 'agents/personas/README.md' },
        paths: ['agents/personas/TEMPLATE.md'],
      },
    );
    expect(findings(result, ID).map((finding) => finding.message)).toEqual([
      'Linked file "template.md" does not exist; "agents/personas/TEMPLATE.md" differs only in letter case. The link works on macOS and Windows but not on Linux.',
    ]);
  });

  it('accepts links into another skill of the collection', () => {
    const paths = ['skills/figma/SKILL.md', 'skills/figma/references/api.md'];
    expect(
      check('[figma](../figma/SKILL.md) [api](../figma/references/api.md)\n', { paths }),
    ).toEqual([]);
    expect(check('[x](../figma/references/missing.md)\n', { paths })[0]?.severity).toBe('error');
  });

  it('ignores placeholder targets in examples', () => {
    expect(
      check('Cite as [Smith 2025](url) or ![chart](URL) or [file](path/to/file.md).\n'),
    ).toEqual([]);
    expect(check('[guide](docs/path/to/x.md) [lic](LICENSE)\n')).toEqual([]);
  });

  it('reports a missing file outside the skill directory as an error', () => {
    expect(check('[style](../shared/style.md)\n')[0]?.message).toBe(
      'Linked file "../shared/style.md" does not exist (the path leaves the skill directory), so an agent that follows the link finds nothing.',
    );
  });

  it('explains letter-case and backslash mistakes', () => {
    expect(
      check('[api](References/API.md)\n', { paths: ['skills/pdf/references/api.md'] })[0]?.message,
    ).toBe(
      'Linked file "References/API.md" does not exist; "skills/pdf/references/api.md" differs only in letter case. The link works on macOS and Windows but not on Linux.',
    );
    expect(check('[up](../PDF/x.md)\n', { paths: ['skills/pdf/x.md'] })[0]?.message).toBe(
      'Linked file "../PDF/x.md" does not exist; "skills/pdf/x.md" differs only in letter case. The link works on macOS and Windows but not on Linux.',
    );
    expect(
      check('[run](scripts\\run.sh)\n', { paths: ['skills/pdf/scripts/run.sh'] })[0]?.message,
    ).toBe(
      'Linked file "scripts\\run.sh" uses backslashes, so agents on Linux and macOS find no file. Write "scripts/run.sh".',
    );
  });

  it('does not report paths whose existence is unknown', () => {
    expect(
      check('[dep](node_modules/x/README.md)\n', {
        opaqueDirectories: ['skills/pdf/node_modules/'],
      }),
    ).toEqual([]);
    expect(check('[env](.env.example)\n', { ignoredFiles: ['skills/pdf/.env.example'] })).toEqual(
      [],
    );
  });

  it('resolves links from a skill at the scan root', () => {
    expect(check('[a](docs/a.md)\n', { paths: ['docs/a.md'] }, 'SKILL.md')).toEqual([]);
    expect(check('[a](docs/b.md)\n', {}, 'SKILL.md')).toHaveLength(1);
    expect(check('[up](../a.md)\n', {}, 'SKILL.md')[0]?.severity).toBe('warn');
  });

  it('checks the body of a skill without frontmatter and with CRLF line endings', () => {
    const result = lint(
      { [SKILL]: '# PDF\r\n\r\nSee [x](missing.md).\r\n' },
      { rules: [brokenReferenceRule] },
    );
    expect(findings(result, ID).map((f) => f.range)).toEqual([
      { start: { line: 3, column: 5 }, end: { line: 3, column: 20 } },
    ]);
  });

  it('reports only for targeted platforms that read the skill', () => {
    const result = lint(
      { '.claude/skills/pdf/SKILL.md': `${FRONTMATTER}[x](missing.md)\n` },
      { rules: [brokenReferenceRule], targets: ['codex', 'claude-code'] },
    );
    expect(result.findings.map((f) => f.platforms)).toEqual([['claude-code']]);
  });
});

describe('relativeLinkPath', () => {
  it('decodes, strips queries and fragments, and rejects non-paths', () => {
    expect(relativeLinkPath(' a%20b.md#x ')).toBe('a b.md');
    expect(relativeLinkPath('a.md?b#c')).toBe('a.md');
    expect(relativeLinkPath('x%00y.md')).toBeUndefined();
    expect(relativeLinkPath('%ZZ')).toBeUndefined();
    expect(relativeLinkPath('#only')).toBeUndefined();
  });
});
