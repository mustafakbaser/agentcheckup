// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import regexp from 'eslint-plugin-regexp';
import tseslint from 'typescript-eslint';

/** Modules that must stay free of I/O so they can run in a browser playground or an LSP. */
const PURE_MODULES = [
  'src/core/**',
  'src/parse/**',
  'src/platforms/**',
  'src/inventory/**',
  'src/policy/**',
  'src/rules/**',
  'src/report/**',
  'src/fix/**',
  'src/tasks/**',
];

export default defineConfig(
  globalIgnores(['dist/', 'coverage/', 'test/fixtures/', '.claude/worktrees/']),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  regexp.configs['flat/recommended'],

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // agentcheckup runs every rule over untrusted text: catastrophic backtracking is a security bug.
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-super-linear-move': 'error',
      'regexp/no-misleading-unicode-character': 'error',

      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all' },
      ],

      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'prefer-const': 'error',

      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'gray-matter',
              message: 'gray-matter evaluates ---js frontmatter. Use src/parse/frontmatter.ts.',
            },
            {
              name: 'js-yaml',
              message: 'Use the `yaml` package through src/parse/frontmatter.ts.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='localeCompare']",
          message:
            'Locale-dependent ordering makes output differ between machines. Compare by code point.',
        },
        {
          selector: 'CallExpression[callee.property.name=/^toLocale(Lower|Upper)Case$/]',
          message: 'Locale-dependent casing breaks in tr-TR (I/ı). Use toLowerCase/toUpperCase.',
        },
        {
          selector: "NewExpression[callee.name='RegExp'], CallExpression[callee.name='RegExp']",
          message:
            'Dynamic regular expressions bypass the backtracking checks. Use a regex literal or string operations.',
        },
      ],
    },
  },

  {
    files: PURE_MODULES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex:
                '^(node:)?(fs|fs/promises|child_process|net|http|https|os|process|worker_threads)$',
              message:
                'This module must stay free of I/O. Do file access in src/io and pass data in.',
            },
          ],
          paths: [
            { name: 'gray-matter', message: 'Use src/parse/frontmatter.ts.' },
            { name: 'js-yaml', message: 'Use src/parse/frontmatter.ts.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Pure modules must not read process state. Pass it in.' },
      ],
    },
  },

  {
    files: ['**/*.test.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },

  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
