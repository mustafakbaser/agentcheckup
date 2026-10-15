import { describe, expect, it } from 'vitest';
import { MAX_FINDINGS_PER_FILE } from '../../../src/rules/json/access.js';
import { existsBelow, scriptMissingRule } from '../../../src/rules/hooks/script-missing.js';
import { timeoutUnitsRule } from '../../../src/rules/hooks/timeout-units.js';
import { unknownEventRule } from '../../../src/rules/hooks/unknown-event.js';
import { findings, lint, snapshotFrom } from '../../helpers/lint.js';
import { json } from '../json/helpers.js';

function settings(commands: readonly string[]): string {
  return json({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: commands.map((command) => ({ type: 'command', command })) },
      ],
    },
  });
}

describe('hooks rules on hostile input', () => {
  it('checks many missing relative scripts against a large tree quickly', () => {
    // 50,000 listed paths, half of them sharing one file name, and 40 settings files with 500
    // hooks each. Scanning every path for every hook took seconds; the index takes milliseconds.
    const paths: string[] = [];
    for (let i = 0; i < 25_000; i++) paths.push(`src/m${String(i)}/x.sh`, `lib/f${String(i)}.ts`);
    const files: Record<string, string> = {};
    for (let p = 0; p < 40; p++) {
      const commands = Array.from({ length: 500 }, (_, i) =>
        i % 2 === 0 ? `bash scripts/check-${String(p)}-${String(i)}.sh` : `bash d${String(i)}/x.sh`,
      );
      files[`pkg${String(p)}/.claude/settings.json`] = settings(commands);
    }
    const started = performance.now();
    const result = findings(lint(files, { rules: [scriptMissingRule], paths }));
    expect(performance.now() - started).toBeLessThan(15_000);
    // 250 distinct missing scripts per file, capped at 100 plus one summary; the shared "x.sh"
    // name is too common to rule out, so those hooks are not reported.
    expect(result).toHaveLength(40 * (MAX_FINDINGS_PER_FILE + 1));
    expect(result.every((finding) => !finding.message.includes('x.sh'))).toBe(true);
  });

  it('answers "may exist" when a name is too common or the budget is spent', () => {
    const shared = Array.from({ length: 3_000 }, (_, i) => `d${String(i)}/x.sh`);
    const snapshot = snapshotFrom({}, { paths: [...shared, 'a/b/unique.sh'] });
    expect(existsBelow(snapshot, '', 'x.sh')).toBe(true);
    expect(existsBelow(snapshot, '', 'b/unique.sh')).toBe(true);
    expect(existsBelow(snapshot, 'other', 'b/unique.sh')).toBe(false);
    expect(existsBelow(snapshot, '', 'missing.sh')).toBe(false);
    expect(existsBelow(snapshot, '', '../escape.sh')).toBe(true);
  });

  it('caps findings per file and summarizes the rest', () => {
    const events = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [`OnEvent${String(i)}`, []]),
    );
    const unknown = findings(
      lint({ '.claude/settings.json': json({ hooks: events }) }, { rules: [unknownEventRule] }),
    );
    expect(unknown).toHaveLength(MAX_FINDINGS_PER_FILE + 1);
    expect(unknown[unknown.length - 1]?.message).toBe(
      'Only the first 100 unknown hook event names in this file are listed; 150 more from here on are not.',
    );
    const timeouts = json({
      hooks: {
        PreToolUse: [
          {
            hooks: Array.from({ length: 120 }, () => ({
              type: 'command',
              command: 'x',
              timeout: 5000,
            })),
          },
        ],
      },
    });
    const capped = findings(
      lint({ '.claude/settings.json': timeouts }, { rules: [timeoutUnitsRule] }),
    );
    expect(capped).toHaveLength(MAX_FINDINGS_PER_FILE + 1);
    expect(capped[capped.length - 1]?.message).toBe(
      'Only the first 100 hook timeouts in the wrong unit in this file are listed; 20 more from here on are not.',
    );
  });
});
