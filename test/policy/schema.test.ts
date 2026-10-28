import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HOOK_PLATFORMS } from '../../src/platforms/hooks.js';
import { CONTEXT_AGENTS } from '../../src/platforms/load/types.js';
import { parsePolicy } from '../../src/policy/parse.js';
import { POLICY_JSON_SCHEMA } from '../../src/policy/schema.js';
import { FORBID_NAMES } from '../../src/policy/types.js';

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(POLICY_JSON_SCHEMA);

const accepted = (document: unknown): boolean => 'policy' in parsePolicy(document);

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/policy/${name}`, import.meta.url), 'utf8'));

describe('POLICY_JSON_SCHEMA', () => {
  it('is a valid draft 2020-12 schema for the documented fields', () => {
    expect(Object.keys(POLICY_JSON_SCHEMA.properties)).toEqual([
      '$schema',
      'policyVersion',
      'name',
      'mode',
      'existing',
      'mcp',
      'forbid',
      'permissions',
      'hooks',
      'budgets',
      'models',
    ]);
    for (const name of ['example.json', 'strict.json']) {
      expect(validate(fixture(name))).toBe(true);
      expect(accepted(fixture(name))).toBe(true);
    }
  });

  it('is the published schemas/policy.schema.json', () => {
    const published = JSON.parse(
      readFileSync(new URL('../../schemas/policy.schema.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    const { $id, title, ...rest } = published;
    expect($id).toBe(
      'https://raw.githubusercontent.com/mustafakbaser/agentcheckup/main/schemas/policy.schema.json',
    );
    expect(title).toBe('agentcheckup organization policy');
    expect(rest).toEqual(JSON.parse(JSON.stringify(POLICY_JSON_SCHEMA)));
  });

  // The hand-written validator and the published schema must agree on every document.
  const digest = 'a'.repeat(64);
  const entryText = fc.oneof(
    fc.constantFrom(
      'npm:foo',
      'npm:@scope/name',
      'npm:@scope/name@1.2.3',
      'npm:foo@v1.2.3',
      'npm:foo@=1.2.3-rc.1+b.2',
      'npm:foo@^1.2.0',
      'npm:foo@latest',
      'npm:foo@1.2',
      'npm:',
      'npm:.foo',
      'npm:@/x',
      'npm:Foo',
      'pypi:mcp-server-fetch',
      'pypi:Foo_Bar==1.0',
      'pypi:foo==1.0.post1.dev2',
      'pypi:foo==1.0rc1',
      'pypi:foo>=1',
      'pypi:foo==1.*',
      'pypi:foo-',
      'pypi:',
      'oci:ubuntu',
      'oci:ghcr.io/acme/mcp-db',
      'oci:ghcr.io/acme/mcp:latest',
      'oci:localhost:5000/x',
      'oci:localhost:5000',
      `oci:x@sha256:${digest}`,
      'oci:x@sha256:abc',
      'oci:Upper',
      'oci:a__b/c-d.e',
      'https://mcp.acme.internal',
      'https://*.acme.dev',
      'https://*.acme.dev:8443',
      'https://mcp.*.acme.dev',
      'https://*.',
      'https://*',
      'https://x/',
      'https://x:65535',
      'https://x:65536',
      'https://x:0',
      'https://x:08',
      'http://[::1]:8080',
      'http://[zz]',
      'ws://a-b.c',
      'wss://a.b',
      'ftp://x',
      'https://user@x',
      'HTTPS://x',
      'https://-x',
      'https://x-',
      'https://',
      'github',
      '',
    ),
    fc.string(),
    fc.string({ unit: 'binary', maxLength: 12 }),
    fc.string().map((text) => `npm:${text}`),
    fc.string().map((text) => `pypi:${text}`),
    fc.string().map((text) => `oci:${text}`),
    fc.string().map((text) => `https://${text}`),
    fc.integer(),
  );
  const event = fc.constantFrom(
    'PreToolUse',
    'preToolUse',
    'BeforeTool',
    'stop',
    'Stop',
    'Interrupt',
    'beforeShellExecution',
    '',
  );
  const requirement = fc.record(
    {
      agent: fc.constantFrom(...HOOK_PLATFORMS, 'vim', 3),
      event: fc.oneof(event, fc.integer()),
      matcher: fc.oneof(fc.string(), fc.integer()),
      script: fc.oneof(fc.constantFrom('', 'scripts/x.sh', './x', '../x'), fc.integer()),
      command: fc.oneof(fc.constantFrom('', 'pnpm lint'), fc.integer()),
      extra: fc.integer(),
    },
    { requiredKeys: [] },
  );
  const budget = fc.oneof(
    fc.record(
      {
        startupTokens: fc.oneof(
          fc.constantFrom(0, 1, 8000, 100_000_000, 100_000_001, 1.5, -3, '8000'),
          fc.integer(),
        ),
        subagentStartupTokens: fc.oneof(
          fc.constantFrom(0, 1, 20_000, 100_000_000, 100_000_001, 2.5, '1'),
          fc.integer(),
        ),
        extra: fc.integer(),
      },
      { requiredKeys: [] },
    ),
    fc.integer(),
  );
  const modelValue = fc.oneof(
    fc.constantFrom('sonnet', 'Claude Sonnet 4.5', 'inherit', ''),
    fc.string({ maxLength: 4 }),
    fc.string({ unit: 'binary', minLength: 195, maxLength: 205 }),
    fc.integer(),
  );
  const modelRule = fc.oneof(
    fc.record(
      {
        allow: fc.oneof(fc.array(modelValue, { maxLength: 2 }), fc.string()),
        deny: fc.array(modelValue, { maxLength: 2 }),
        alow: fc.integer(),
      },
      { requiredKeys: [] },
    ),
    fc.integer(),
  );
  const fields = {
    $schema: fc.oneof(fc.string(), fc.integer()),
    policyVersion: fc.constantFrom(1, 2, 0, 1.5, '1', null),
    name: fc.oneof(
      fc.string({ maxLength: 130 }),
      fc.string({ unit: 'grapheme', minLength: 110, maxLength: 130 }),
      fc.integer(),
    ),
    mode: fc.constantFrom('enforce', 'audit', 'warn', 1),
    existing: fc.constantFrom('report', 'fail', 'ignore', true),
    mcp: fc.oneof(
      fc.record(
        {
          allow: fc.oneof(fc.array(entryText, { maxLength: 3 }), fc.string()),
          allowLocal: fc.oneof(fc.boolean(), fc.integer()),
          requirePin: fc.oneof(fc.boolean(), fc.constant('yes')),
          alow: fc.integer(),
        },
        { requiredKeys: [] },
      ),
      fc.constant([]),
    ),
    forbid: fc.oneof(
      fc.array(fc.oneof(fc.constantFrom(...FORBID_NAMES, 'broad-shel', ''), fc.integer()), {
        maxLength: 3,
      }),
      fc.constant({}),
    ),
    permissions: fc.record(
      {
        denyTools: fc.array(
          fc.oneof(fc.constantFrom('WebFetch', 'mcp__x__y', 'Bash(curl:*)', ''), fc.string()),
          { maxLength: 2 },
        ),
        denyCommands: fc.array(
          fc.oneof(fc.constantFrom('curl', 'g++', 'curl -s', ''), fc.string(), fc.integer()),
          { maxLength: 2 },
        ),
        extra: fc.integer(),
      },
      { requiredKeys: [] },
    ),
    hooks: fc.oneof(
      fc.record(
        {
          require: fc.oneof(fc.array(requirement, { maxLength: 2 }), fc.integer()),
          x: fc.integer(),
        },
        { requiredKeys: [] },
      ),
      fc.constant(null),
    ),
    budgets: fc.dictionary(
      fc.constantFrom(...CONTEXT_AGENTS, 'gemini', '__proto__', 'codx'),
      budget,
      { maxKeys: 3 },
    ),
    models: fc.dictionary(fc.constantFrom(...CONTEXT_AGENTS, '__proto__', 'claude'), modelRule, {
      maxKeys: 3,
    }),
    unknown: fc.integer(),
  };
  // Valid values only, so that accepted documents are common too.
  const valid = {
    policyVersion: fc.constant(1),
    name: fc.string({ minLength: 1, maxLength: 20 }),
    mode: fc.constantFrom('enforce', 'audit'),
    existing: fc.constantFrom('report', 'fail'),
    mcp: fc.record(
      {
        allow: fc.array(
          fc.constantFrom(
            'npm:@scope/name@1.2.3',
            'pypi:foo',
            `oci:x@sha256:${digest}`,
            'https://*.a.b',
          ),
          { maxLength: 3 },
        ),
        allowLocal: fc.boolean(),
        requirePin: fc.boolean(),
      },
      { requiredKeys: [] },
    ),
    forbid: fc.array(fc.constantFrom(...FORBID_NAMES), { maxLength: 3 }),
    permissions: fc.record(
      {
        denyTools: fc.array(fc.constantFrom('WebFetch', 'mcp__x__y'), { maxLength: 2 }),
        denyCommands: fc.array(fc.constantFrom('curl', 'g++'), { maxLength: 2 }),
      },
      { requiredKeys: [] },
    ),
    hooks: fc.record(
      {
        require: fc.array(
          fc.constantFrom(
            { agent: 'claude-code', event: 'PreToolUse', matcher: '' },
            { agent: 'cursor', event: 'stop', script: 'x.sh' },
            { agent: 'gemini', event: 'BeforeTool', command: 'x' },
          ),
          { maxLength: 2 },
        ),
      },
      { requiredKeys: [] },
    ),
    budgets: fc.dictionary(
      fc.constantFrom(...CONTEXT_AGENTS),
      fc.record(
        {
          startupTokens: fc.integer({ min: 1, max: 100_000_000 }),
          subagentStartupTokens: fc.integer({ min: 1, max: 100_000_000 }),
        },
        // At least one of the two: an empty budget is an error.
        { requiredKeys: ['startupTokens'] },
      ),
      { maxKeys: 3 },
    ),
    models: fc.dictionary(
      fc.constantFrom(...CONTEXT_AGENTS),
      fc.record(
        {
          allow: fc.array(fc.constantFrom('sonnet', 'inherit', 'gpt-6.1-sol'), { maxLength: 2 }),
          deny: fc.array(fc.constantFrom('opus', 'Claude Opus 4.1'), { maxLength: 2 }),
        },
        { requiredKeys: ['deny'] },
      ),
      { maxKeys: 3 },
    ),
  };
  const validPolicy = fc.record(valid, { requiredKeys: ['policyVersion', 'name'] });
  // A valid document with one field replaced by any generated value, valid or not.
  const fieldNames = Object.keys(fields) as (keyof typeof fields)[];
  const mutated = fc
    .tuple(validPolicy, fc.constantFrom(...fieldNames))
    .chain(([document, key]) =>
      fields[key].map((value: unknown) => ({ ...document, [key]: value })),
    );
  const policy = fc.oneof(fc.record(fields, { requiredKeys: [] }), validPolicy, mutated);

  it('accepts exactly the documents the validator accepts', () => {
    fc.assert(
      fc.property(fc.oneof(policy, fc.anything()), (document) => {
        // JSON.stringify returns undefined for undefined, functions and symbols.
        const text = JSON.stringify(document) as string | undefined;
        const json: unknown = JSON.parse(text ?? 'null');
        expect(validate(json)).toBe(accepted(json));
      }),
      { numRuns: 3000 },
    );
  });

  it('agrees on every allowlist entry', () => {
    fc.assert(
      fc.property(entryText, (text) => {
        const json = { policyVersion: 1, name: 'x', mcp: { allow: [text] } };
        expect(validate(json)).toBe(accepted(json));
      }),
      { numRuns: 3000 },
    );
  });

  it('generates both accepted and rejected documents', () => {
    // A guard against a generator whose documents the validator always rejects, or accepts.
    const samples = fc
      .sample(policy, { numRuns: 1000, seed: 7 })
      .map((sample) => accepted(JSON.parse(JSON.stringify(sample))));
    expect(samples.filter(Boolean).length).toBeGreaterThan(200);
    expect(samples.filter((ok) => !ok).length).toBeGreaterThan(200);
  });
});
