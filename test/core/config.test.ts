import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import {
  CONFIG_JSON_SCHEMA,
  ConfigError,
  configJsonSchema,
  resolveConfig,
  SEVERITY_SETTINGS,
  validateConfig,
} from '../../src/core/config.js';
import { DIRECTIVE_RULES } from '../../src/core/directive-rules.js';
import { scanSnapshot } from '../../src/core/engine.js';
import { PLATFORM_IDS, type RuleMeta } from '../../src/core/types.js';
import { builtinRules } from '../../src/rules/index.js';
import { snapshotFrom } from '../helpers/lint.js';

describe('resolveConfig', () => {
  it('accepts an empty config', () => {
    const config = resolveConfig({});
    expect(config.targets).toBeUndefined();
    expect(config.isIgnored('AGENTS.md')).toBe(false);
    expect(config.ruleSetting('skill/name-format', 'SKILL.md')).toBeUndefined();
  });

  it('resolves severities, options and per-path overrides', () => {
    const config = resolveConfig({
      targets: ['codex', 'claude-code'],
      rules: {
        'instr/claude-md-too-long': ['warn', { maxLines: 300 }],
        'skill/name-format': 'error',
      },
      overrides: [{ files: ['examples/**'], rules: { 'skill/name-format': 'off' } }],
    });
    expect(config.targets).toEqual(['codex', 'claude-code']);
    expect(config.ruleSetting('instr/claude-md-too-long', 'CLAUDE.md')).toEqual({
      severity: 'warn',
      options: { maxLines: 300 },
    });
    expect(config.ruleSetting('skill/name-format', 'skills/a/SKILL.md')).toEqual({
      severity: 'error',
    });
    expect(config.ruleSetting('skill/name-format', 'examples/a/SKILL.md')).toEqual({
      severity: 'off',
    });
    expect(config.referencedRuleIds).toEqual(['instr/claude-md-too-long', 'skill/name-format']);
  });

  it('keeps base options when an override changes only severity', () => {
    const config = resolveConfig({
      rules: { 'instr/claude-md-too-long': ['warn', { maxLines: 300 }] },
      overrides: [{ files: ['docs/**'], rules: { 'instr/claude-md-too-long': 'info' } }],
    });
    expect(config.ruleSetting('instr/claude-md-too-long', 'docs/CLAUDE.md')).toEqual({
      severity: 'info',
      options: { maxLines: 300 },
    });
  });

  it('matches ignore globs including dotfiles', () => {
    const config = resolveConfig({ ignore: ['fixtures/**', '**/.cursor/rules/legacy-*.mdc'] });
    expect(config.isIgnored('fixtures/AGENTS.md')).toBe(true);
    expect(config.isIgnored('app/.cursor/rules/legacy-old.mdc')).toBe(true);
    expect(config.isIgnored('AGENTS.md')).toBe(false);
  });

  it('never resolves inherited properties or pollutes prototypes', () => {
    const raw = JSON.parse('{"rules": {"__proto__": ["warn", {"polluted": true}]}}') as unknown;
    const config = resolveConfig(raw);
    expect(config.ruleSetting('toString', 'a')).toBeUndefined();
    expect(config.ruleSetting('constructor', 'a')).toBeUndefined();
    expect(config.ruleSetting('map', 'a')).toBeUndefined();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it.each([
    [{ unknownKey: true }],
    [{ targets: ['vim'] }],
    [{ targets: [] }],
    [{ rules: { 'a/b': 'fatal' } }],
    [{ rules: { 'a/b': ['warn', 'not-an-object'] } }],
    [{ overrides: [{ files: [], rules: {} }] }],
    [{ overrides: [{ files: ['x'], rules: { 'a/b': ['warn', {}] } }] }],
    ['not an object'],
  ])('rejects invalid config %j with a readable error', (raw) => {
    expect(() => resolveConfig(raw)).toThrow(ConfigError);
  });

  it('explains every problem, with its location', () => {
    const { issues } = validateConfig({
      targets: ['codex', 'vim'],
      rules: { 'a/b': 'fatal' },
      overrides: [{ files: [], rules: { 'c/d': ['warn', {}] }, extra: 1 }],
      bogus: true,
    });
    expect(issues).toEqual([
      'targets[1]: unknown platform "vim". Use one of: claude-code, codex, cursor, copilot, gemini, windsurf, cline.',
      'rules["a/b"]: expected one of "off", "info", "warn", "error", or [severity, options], got "fatal".',
      'overrides[0]: unknown field "extra".',
      'overrides[0].files: needs at least 1 entry.',
      'overrides[0].rules["c/d"]: overrides set severity only; expected one of "off", "info", "warn", "error", got an array.',
      'unknown field "bogus". Allowed: $schema, targets, rules, ignore, overrides.',
    ]);
  });
});

describe('CONFIG_JSON_SCHEMA', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(CONFIG_JSON_SCHEMA);

  it('is a valid draft 2020-12 schema for the documented fields', () => {
    expect(Object.keys(CONFIG_JSON_SCHEMA.properties)).toEqual([
      '$schema',
      'targets',
      'rules',
      'ignore',
      'overrides',
    ]);
    expect(validate({ targets: ['codex'], rules: { 'a/b': ['warn', { x: 1 }] } })).toBe(true);
  });

  // The hand-written validator and the published schema must agree on every document.
  const severity = fc.constantFrom(...SEVERITY_SETTINGS, 'fatal', '');
  const ruleId = fc.constantFrom('a/b', 'skill/name-format', '__proto__', 'constructor', '');
  const setting = fc.oneof(
    severity,
    fc.tuple(severity, fc.oneof(fc.object(), fc.constant([]), fc.constant('x'))),
    fc.tuple(severity),
    fc.integer(),
  );
  const config = fc.record(
    {
      $schema: fc.oneof(fc.string(), fc.integer()),
      targets: fc.array(fc.constantFrom(...PLATFORM_IDS, 'vim'), { maxLength: 3 }),
      rules: fc.dictionary(ruleId, setting, { maxKeys: 3 }),
      ignore: fc.array(fc.oneof(fc.string(), fc.integer()), { maxLength: 2 }),
      overrides: fc.array(
        fc.record(
          {
            files: fc.array(fc.oneof(fc.string(), fc.integer()), { maxLength: 2 }),
            rules: fc.dictionary(ruleId, fc.oneof(severity, fc.integer()), { maxKeys: 2 }),
            extra: fc.integer(),
          },
          { requiredKeys: [] },
        ),
        { maxLength: 2 },
      ),
      unknown: fc.integer(),
    },
    { requiredKeys: [] },
  );

  it('accepts exactly the documents the validator accepts', () => {
    fc.assert(
      fc.property(fc.oneof(config, fc.anything()), (document) => {
        // JSON.stringify returns undefined for undefined, functions and symbols.
        const text = JSON.stringify(document) as string | undefined;
        const json: unknown = JSON.parse(text ?? 'null');
        const accepted = validateConfig(json).config !== undefined;
        expect(validate(json)).toBe(accepted);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('rule options', () => {
  const metas: RuleMeta[] = [...builtinRules.map((rule) => rule.meta), ...DIRECTIVE_RULES];

  it('accepts the options a rule declares, with values of their type', () => {
    const { config, issues } = validateConfig(
      {
        rules: {
          'instr/claude-md-too-long': ['warn', { maxLines: 300 }],
          'instr/codex-size-budget': ['error', { maxBytes: 65_536 }],
          'skill/body-too-long': ['info', {}],
          'skill/name-format': ['error', {}],
          'unknown/rule': ['warn', { anything: true }],
        },
      },
      metas,
    );
    expect(issues).toEqual([]);
    expect(config).toBeDefined();
  });

  it.each([
    ['"many"', 'many'],
    ['-5', -5],
    ['0', 0],
    ['1.5', 1.5],
    ['true', true],
    ['null', null],
    ['9007199254740992', 2 ** 53],
  ])('rejects maxLines %s, naming the rule, the option and the type', (shown, value) => {
    const { config, issues } = validateConfig(
      { rules: { 'instr/claude-md-too-long': ['warn', { maxLines: value }] } },
      metas,
    );
    expect(config).toBeUndefined();
    expect(issues).toEqual([
      `rules["instr/claude-md-too-long"].maxLines: expected a positive integer, got ${shown}.`,
    ]);
  });

  it('rejects options a rule does not take', () => {
    const { issues } = validateConfig(
      {
        rules: {
          'skill/body-too-long': ['info', { maxLine: 3 }],
          'skill/name-format': ['error', { x: 1 }],
        },
      },
      metas,
    );
    expect(issues).toEqual([
      'rules["skill/body-too-long"]: unknown option "maxLine". skill/body-too-long takes "maxLines".',
      'rules["skill/name-format"]: unknown option "x". skill/name-format takes no options.',
    ]);
  });

  it('lists unknown rule ids with the other issues, and never alone', () => {
    expect(validateConfig({ rules: { 'instr/claude-md-too-lng': 'warn' } }, metas).issues).toEqual(
      [],
    );
    const { issues } = validateConfig(
      {
        rules: { 'instr/claude-md-too-lng': 'warn', 'skill/name-format': ['warn', { x: 1 }] },
        overrides: [{ files: ['a/**'], rules: { 'zz/unknown': 'off' } }],
      },
      metas,
    );
    expect(issues).toEqual([
      'rules["skill/name-format"]: unknown option "x". skill/name-format takes no options.',
      'rules["instr/claude-md-too-lng"]: unknown rule (alone, only a warning). Did you mean "instr/claude-md-too-long"?',
      'rules["zz/unknown"]: unknown rule (alone, only a warning).',
    ]);
  });

  it('throws a ConfigError with one line per issue', () => {
    let thrown: unknown;
    try {
      resolveConfig(
        { rules: { 'instr/claude-md-too-long': ['warn', { maxLines: 'many\nInjected' }] } },
        'agentcheckup.config.json',
        metas,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).lines).toEqual([
      'Invalid agentcheckup.config.json:',
      '  - rules["instr/claude-md-too-long"].maxLines: expected a positive integer, got "many\nInjected".',
    ]);
  });

  it('is checked by the engine before any rule runs, for a configuration built another way', () => {
    const config = resolveConfig({
      rules: { 'instr/claude-md-too-long': ['warn', { maxLines: 0 }] },
    });
    const snapshot = snapshotFrom({ 'CLAUDE.md': '# x\n' });
    expect(() => scanSnapshot(snapshot, { rules: builtinRules, config })).toThrow(ConfigError);
    // A valid option runs as before.
    const valid = resolveConfig({
      rules: { 'instr/claude-md-too-long': ['warn', { maxLines: 1 }] },
    });
    expect(scanSnapshot(snapshot, { rules: builtinRules, config: valid }).ruleFailures).toEqual([]);
  });

  describe('configJsonSchema', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(configJsonSchema(metas));
    const value = fc.oneof(
      fc.integer({ min: -2, max: 400 }),
      fc.constant(1.5),
      fc.constant('many'),
      fc.constant(2 ** 53),
      fc.boolean(),
    );
    const options = fc.dictionary(fc.constantFrom('maxLines', 'maxBytes', 'other'), value, {
      maxKeys: 2,
    });
    const severity = fc.constantFrom(...SEVERITY_SETTINGS, 'fatal');
    const ruleId = fc.constantFrom(
      'instr/claude-md-too-long',
      'instr/codex-size-budget',
      'skill/body-too-long',
      'skill/name-format',
      'unknown/rule',
    );
    const setting = fc.oneof(severity, fc.tuple(severity, options));

    it('accepts exactly the documents the validator accepts with the rules', () => {
      fc.assert(
        fc.property(
          fc.record({ rules: fc.dictionary(ruleId, setting, { maxKeys: 3 }) }),
          (document) => {
            const json: unknown = JSON.parse(JSON.stringify(document));
            const accepted = validateConfig(json, metas).config !== undefined;
            expect(validate(json)).toBe(accepted);
          },
        ),
        { numRuns: 2000 },
      );
    });
  });
});
