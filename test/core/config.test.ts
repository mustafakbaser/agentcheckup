import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import {
  CONFIG_JSON_SCHEMA,
  ConfigError,
  resolveConfig,
  SEVERITY_SETTINGS,
  validateConfig,
} from '../../src/core/config.js';
import { PLATFORM_IDS } from '../../src/core/types.js';

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
