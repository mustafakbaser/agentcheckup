import { describe, expect, it } from 'vitest';
import { localFileNotIgnoredRule } from '../../../src/rules/settings/local-file-not-ignored.js';
import { findings, lint } from '../../helpers/lint.js';

describe('settings/local-file-not-ignored on large trees', () => {
  it('stays linear in the number of directories', () => {
    // 4,000 directories with CLAUDE.local.md and AGENTS.md: comparing every file with every
    // other artifact took 725 ms; one pass over the artifacts takes a few.
    const files: Record<string, string> = {};
    for (let i = 0; i < 4_000; i++) {
      files[`d${String(i)}/CLAUDE.local.md`] = 'x';
      files[`d${String(i)}/AGENTS.md`] = 'y';
    }
    files['d7/CLAUDE.md'] = 'z';
    const started = performance.now();
    const result = findings(
      lint(files, { rules: [localFileNotIgnoredRule], trustDirectives: false }),
    );
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(result).toHaveLength(4_000);
    const withAgents = result.filter((finding) => finding.message.includes('AGENTS.md next to it'));
    expect(withAgents).toHaveLength(3_999);
  });
});
