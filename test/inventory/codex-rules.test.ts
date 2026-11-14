import { describe, expect, it } from 'vitest';
import { compareWithBaseline, GATE_CLASSES } from '../../src/core/baseline.js';
import { validateBaseline } from '../../src/core/baseline-input.js';
import { analyze, scanSnapshot } from '../../src/core/engine.js';
import { buildInventory } from '../../src/inventory/build.js';
import type { Inventory } from '../../src/inventory/types.js';
import { MAX_CALLS, MAX_DEPTH, readStarlarkCalls } from '../../src/parse/codex-rules.js';
import { classify } from '../../src/platforms/classify.js';
import { codexRuleGrants } from '../../src/platforms/codex-rules.js';
import { type FileMap, snapshotFrom } from '../helpers/lint.js';
import { noise } from '../rules/json/helpers.js';

const FILE = '.codex/rules/project.rules';

const lines = (...items: string[]): string => `${items.join('\n')}\n`;

function inventoryOf(text: string | Uint8Array, files: FileMap = {}): Inventory {
  return buildInventory(analyze(snapshotFrom({ ...files, [FILE]: text }), {}));
}

const grantsOf = (text: string) =>
  inventoryOf(text).permissions.map(({ key, value, broad, line }) => [key, value, broad, line]);

const TOKEN = ['ghp', '_', noise(36, 11)].join('');

describe('classifying exec-policy files', () => {
  it('reads *.rules directly in a .codex/rules folder, at any depth of the repository', () => {
    expect(classify('.codex/rules/default.rules')?.kind).toBe('codex-rules');
    expect(classify('pkg/.codex/rules/a.rules')?.kind).toBe('codex-rules');
    // Codex does not look into subfolders, nor at other extensions.
    expect(classify('.codex/rules/sub/a.rules')).toBeUndefined();
    expect(classify('.codex/rules/a.star')).toBeUndefined();
    expect(classify('rules/a.rules')).toBeUndefined();
  });
});

describe('exec-policy rules in the inventory', () => {
  it('lists the rules that let Codex act without asking, with their lines', () => {
    expect(
      grantsOf(
        lines(
          '# Project rules',
          'prefix_rule(pattern = ["git", ["status", "diff"]], decision = "allow")',
          'prefix_rule(',
          '    pattern = ["npm", "test"],',
          '    justification = "tests are safe",',
          '    match = ["npm test", ["npm", "test", "--watch"]],',
          '    not_match = ["npm install"],',
          ')',
          'prefix_rule(["bash"])',
          'prefix_rule(pattern = ["rm"], decision = "forbidden")',
          "prefix_rule(pattern = ['curl'], decision = 'prompt')",
          'network_rule(host = "api.acme.dev", protocol = "https", decision = "allow")',
          'network_rule("evil.dev", "https", "deny")',
          'host_executable(name = "git", paths = ["/usr/bin/git", "/opt/git/bin/git"])',
        ),
      ),
    ).toEqual([
      ['rules.host_executable', 'git=/usr/bin/git,/opt/git/bin/git', false, 14],
      ['rules.network_rule', 'https api.acme.dev', false, 12],
      ['rules.prefix_rule', 'bash', true, 9],
      ['rules.prefix_rule', 'git [status|diff]', false, 2],
      ['rules.prefix_rule', 'npm test', false, 3],
    ]);
  });

  it('lists nothing for rules that only ask or block, and for an empty file', () => {
    expect(
      grantsOf(lines('prefix_rule(["rm", "-rf"], "forbidden")', 'prefix_rule(["git"], "prompt")')),
    ).toEqual([]);
    expect(grantsOf('')).toEqual([]);
    expect(grantsOf('# nothing yet\n')).toEqual([]);
    expect(inventoryOf('# nothing yet\n').incomplete).toEqual([]);
  });

  it('marks a file it cannot read without evaluating it incomplete', () => {
    for (const text of [
      'GIT = "git"\nprefix_rule(pattern = [GIT])\n',
      'load("//x.star", "helper")\n',
      'for cmd in ["a"]:\n    prefix_rule([cmd])\n',
      'prefix_rule(pattern = ["git"] + ["push"])\n',
      'prefix_rule(pattern = [r"git"])\n',
      'prefix_rule(pattern = ["""git"""])\n',
      'prefix_rule(pattern = ["git\\x41"])\n',
      'prefix_rule(pattern = ["git"], decision = "maybe")\n',
      'prefix_rule(pattern = [])\n',
      'prefix_rule(pattern = ["git"], unknown = True)\n',
      'prefix_rule(pattern = ["git"], pattern = ["ls"])\n',
      'prefix_rule(decision = "allow", ["git"])\n',
      'prefix_rule(pattern = ["git"], justification = "  ")\n',
      'helper(["git"])\n',
      'prefix_rule(pattern = ["git"]\n',
      'prefix_rule(pattern = ["unterminated])\n',
    ]) {
      const inventory = inventoryOf(text);
      expect(inventory.incomplete, text).toEqual([FILE]);
      expect(inventory.permissions, text).toEqual([]);
    }
  });

  it('marks a file Codex does not read as UTF-8 text incomplete', () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf, ...encode('prefix_rule(["git"])\n'));
    expect(inventoryOf(bom).incomplete).toEqual([FILE]);
    expect(inventoryOf(Uint8Array.of(0x23, 0xff, 0x0a)).incomplete).toEqual([FILE]);
    const utf16 = Uint8Array.of(0xff, 0xfe, 0x23, 0, 0x0a, 0);
    expect(inventoryOf(utf16).incomplete).toEqual([FILE]);
  });

  it('lists a rules file the walk skipped as incomplete', () => {
    const snapshot = snapshotFrom({ 'AGENTS.md': '# A\n' });
    const inventory = buildInventory(
      analyze({ ...snapshot, skipped: [{ path: FILE, reason: 'too-large', size: 9_000_000 }] }, {}),
    );
    expect(inventory.incomplete).toEqual([FILE]);
  });

  it('never shows a credential written into a rule', () => {
    const json = JSON.stringify(
      inventoryOf(
        lines(
          `prefix_rule(pattern = ["curl", "-H", "Authorization: Bearer ${TOKEN}"])`,
          `network_rule(host = "${TOKEN}.example.com", protocol = "https", decision = "allow")`,
        ),
      ),
    );
    expect(json).not.toContain(TOKEN.slice(-16));
  });
});

describe('the gate over exec-policy rules', () => {
  function hits(before: FileMap, after: FileMap) {
    const baseline = validateBaseline(
      JSON.parse(JSON.stringify(scanSnapshot(snapshotFrom(before), { rules: [] }))),
    );
    if (!baseline.ok) throw new Error(baseline.message);
    const head = scanSnapshot(snapshotFrom(after), { rules: [] });
    return compareWithBaseline(head, baseline.baseline, { gate: GATE_CLASSES }).diff.gate.hits.map(
      (hit) => [hit.class, hit.id, hit.summary],
    );
  }

  it('trips permissions for an added allow rule, and not for an unchanged file', () => {
    const before = { [FILE]: 'prefix_rule(["git", "status"])\n' };
    const after = { [FILE]: 'prefix_rule(["git", "status"])\nprefix_rule(["bash"])\n' };
    expect(hits(before, after)).toEqual([
      [
        'permissions',
        `perm:${FILE}#rules.prefix_rule=bash`,
        'rules.prefix_rule adds bash (broad: runs any command of a shell or interpreter without asking)',
      ],
    ]);
    expect(hits(before, before)).toEqual([]);
    // A rule that only blocks is not a permission.
    expect(hits(before, { [FILE]: `${before[FILE]}prefix_rule(["rm"], "forbidden")\n` })).toEqual(
      [],
    );
  });

  it('fails closed on a new rules file it cannot read', () => {
    expect(hits({}, { [FILE]: 'X = "git"\nprefix_rule([X])\n' })).toEqual([
      [
        'permissions',
        FILE,
        `New permission config ${FILE} is not analyzed, so its permissions cannot be checked`,
      ],
    ]);
  });
});

describe('reading literal calls', () => {
  it('stops at a limit on deeply nested lists and on very many calls', () => {
    const deep = `prefix_rule(${'['.repeat(MAX_DEPTH + 1)}"x"${']'.repeat(MAX_DEPTH + 1)})`;
    expect(readStarlarkCalls(deep)).toMatchObject({ ok: false, reason: 'limit' });
    const many = 'prefix_rule(["a"])\n'.repeat(MAX_CALLS + 1);
    expect(readStarlarkCalls(many)).toMatchObject({ ok: false, reason: 'limit' });
    expect(readStarlarkCalls('prefix_rule(["a"])\n'.repeat(MAX_CALLS))).toMatchObject({
      ok: true,
    });
  });

  it('reads escapes, comments, semicolons and trailing commas', () => {
    expect(
      codexRuleGrants(
        'prefix_rule(pattern = ["echo", "a\\"b c",], ) ; prefix_rule(["ls"]) # done\n',
      ),
    ).toMatchObject({
      ok: true,
      grants: [{ value: 'echo "a\\"b c"' }, { value: 'ls' }],
    });
  });

  it('returns in linear time on hostile input', () => {
    const started = performance.now();
    for (const [text, ok] of [
      ['['.repeat(200_000), false],
      ['prefix_rule('.repeat(50_000), false],
      [`prefix_rule(["${'\\\\'.repeat(100_000)}"])`, true],
      [`prefix_rule(["${'a'.repeat(500_000)}`, false],
      ['#'.repeat(500_000), true],
    ] as const) {
      expect(readStarlarkCalls(text).ok).toBe(ok);
    }
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
