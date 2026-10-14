import { describe, expect, it } from 'vitest';
import { instructionsMisplacedRule } from '../../../src/rules/copilot/instructions-misplaced.js';
import { findings, lint } from '../../helpers/lint.js';

const RULE = 'copilot/instructions-misplaced';
const rules = [instructionsMisplacedRule];
const WHOLE_FILE = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };
const PATH_FILE = '---\napplyTo: "**/*.ts"\n---\nUse strict TypeScript.\n';

describe('copilot/instructions-misplaced', () => {
  describe('copilot-instructions.md', () => {
    it('reports a file elsewhere in .github as an error', () => {
      const result = lint(
        { '.github/instructions/copilot-instructions.md': 'Use pnpm.\n' },
        { rules },
      );
      expect(findings(result, RULE)).toEqual([
        {
          ruleId: RULE,
          severity: 'error',
          path: '.github/instructions/copilot-instructions.md',
          message:
            'GitHub Copilot reads repository-wide instructions only from .github/copilot-instructions.md, so it does not load this file. Move it there.',
          range: WHOLE_FILE,
        },
      ]);
    });

    it('warns about a letter-case variant', () => {
      const result = lint({ '.github/Copilot-Instructions.md': 'x' }, { rules });
      expect(findings(result, RULE)).toEqual([
        expect.objectContaining({
          severity: 'warn',
          message:
            '".github/Copilot-Instructions.md" matches ".github/copilot-instructions.md" only when letter case is ignored. GitHub.com and Linux treat file names as case-sensitive, so GitHub Copilot does not load it there.',
        }),
      ]);
    });

    it('warns about a .github folder in a subdirectory', () => {
      const result = lint({ 'packages/web/.github/copilot-instructions.md': 'x' }, { rules });
      expect(findings(result, RULE)).toEqual([
        expect.objectContaining({
          severity: 'warn',
          message:
            'On GitHub.com, GitHub Copilot reads .github/copilot-instructions.md only at the repository root, so it does not load this file. VS Code loads it only when you open "packages/web" as the workspace folder.',
        }),
      ]);
    });

    it.each([
      ['the expected location', '.github/copilot-instructions.md', []],
      ['a copy outside .github', 'copilot-instructions.md', []],
      ['a document elsewhere', 'docs/copilot-instructions.md', []],
      [
        'a subdirectory that is its own repository',
        'vendor/tool/.github/copilot-instructions.md',
        ['vendor/tool/.git'],
      ],
      ['a project template', 'src/ExtensionTemplate/App/.github/copilot-instructions.md', []],
    ])('does not report %s', (_label, path, paths) => {
      expect(findings(lint({ [path]: 'x' }, { rules, paths }), RULE)).toEqual([]);
    });
  });

  describe('*.instructions.md', () => {
    it('warns about a file in .github outside instructions/, naming the VS Code setting', () => {
      const result = lint({ '.github/review-tools/review.instructions.md': PATH_FILE }, { rules });
      expect(findings(result, RULE)).toEqual([
        {
          ruleId: RULE,
          severity: 'warn',
          path: '.github/review-tools/review.instructions.md',
          message:
            "GitHub Copilot reads path-specific instructions only from .github/instructions, so it does not load this file. Only VS Code's deprecated chat.instructionsFilesLocations setting can add another directory, for its Local harness.",
          range: WHOLE_FILE,
        },
      ]);
    });

    it('warns about letter case and nested .github folders', () => {
      const result = lint(
        {
          '.github/Instructions/ts.instructions.md': PATH_FILE,
          'apps/web/.github/instructions/ts.instructions.md': PATH_FILE,
        },
        { rules },
      );
      expect(findings(result, RULE).map((finding) => [finding.path, finding.message])).toEqual([
        [
          '.github/Instructions/ts.instructions.md',
          '".github/Instructions/ts.instructions.md" is inside ".github/instructions" only when letter case is ignored. GitHub.com and Linux treat file names as case-sensitive, so GitHub Copilot does not load it there.',
        ],
        [
          'apps/web/.github/instructions/ts.instructions.md',
          'On GitHub.com, GitHub Copilot reads .github/instructions only at the repository root, so it does not load this file. VS Code loads it only when you open "apps/web" as the workspace folder.',
        ],
      ]);
    });

    it.each([
      ['the expected location', '.github/instructions/ts.instructions.md'],
      [
        'a subfolder of the expected location',
        '.github/instructions/frontend/react.instructions.md',
      ],
      ['a collection outside .github', 'instructions/a11y.instructions.md'],
      ['a document elsewhere', 'docs/ts.instructions.md'],
      ['an agentic workflow import', '.github/workflows/shared/area.instructions.md'],
      ['an example project', 'examples/app/.github/instructions/ts.instructions.md'],
      ['a fixture', 'test/fixtures/repo/.github/instructions/ts.instructions.md'],
    ])('does not report %s', (_label, path) => {
      expect(findings(lint({ [path]: PATH_FILE }, { rules }), RULE)).toEqual([]);
    });

    it('does not report a file that a symlink in .github/instructions reaches', () => {
      const result = lint(
        {
          '.agents/standards/ts.instructions.md': PATH_FILE,
          '.github/instructions/ts.instructions.md': PATH_FILE,
        },
        {
          rules,
          symlinks: {
            '.github/instructions/ts.instructions.md': '.agents/standards/ts.instructions.md',
          },
        },
      );
      expect(findings(result, RULE)).toEqual([]);
    });

    it('judges a misplaced symlink by the path inside .github', () => {
      const result = lint(
        {
          'shared/ts.instructions.md': PATH_FILE,
          '.github/ts.instructions.md': PATH_FILE,
        },
        { rules, symlinks: { '.github/ts.instructions.md': 'shared/ts.instructions.md' } },
      );
      expect(findings(result, RULE).map((finding) => [finding.path, finding.severity])).toEqual([
        ['shared/ts.instructions.md', 'warn'],
      ]);
    });
  });

  it('does not run when Copilot is not targeted', () => {
    const result = lint(
      { '.github/instructions/copilot-instructions.md': 'x' },
      { rules, targets: ['cursor'] },
    );
    expect(findings(result, RULE)).toEqual([]);
  });
});
