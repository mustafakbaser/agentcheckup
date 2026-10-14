import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Tests must not depend on the developer's locale or timezone.
    env: { TZ: 'UTC', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' },
    restoreMocks: true,
    // Performance tests assert their own budgets (up to 15 s for hostile inputs). The default
    // 5 s timeout would cut them short on slow CI runners before their budget applies.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
