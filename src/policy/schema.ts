/**
 * The policy file's JSON Schema (draft 2020-12), published as schemas/policy.schema.json for
 * editors, and the entry grammars the validator in ./parse.ts shares with it.
 *
 * The validator is hand-written, like the configuration's, so it can give one precise line per
 * problem. A property test checks that the schema and the validator accept exactly the same
 * documents. To keep them in step, every string grammar is one regex literal here: the validator
 * accepts a string when the literal matches, and the schema uses the literal's source as its
 * `pattern`. The validator never rejects a string the pattern accepts.
 */
import { HOOK_EVENTS, HOOK_PLATFORMS } from '../platforms/hooks.js';
import { CONTEXT_AGENTS } from '../platforms/load/types.js';
import { EXISTING_MODES, FORBID_NAMES, POLICY_MODES } from './types.js';

/** The policy format version this agentcheckup reads. */
export const POLICY_VERSION = 1;

/** Longest policy name, in code points. */
export const MAX_NAME_LENGTH = 120;

/** Largest startup budget, in tokens. */
export const MAX_STARTUP_TOKENS = 100_000_000;

/** Longest model value in `models`, in code points. */
export const MAX_MODEL_LENGTH = 200;

/**
 * `npm:<name>[@<exact version>]`. Names follow npm's rules, scoped or not; legacy names with
 * capitals are accepted. The version is an exact semver version, as npm reads one: a leading `=`
 * or `v` is allowed, a range or tag is not.
 */
export const NPM_ENTRY =
  /^npm:(?:@[\dA-Za-z~-][\w.~-]*\/)?[\dA-Za-z~-][\w.~-]*(?:@[=v]?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)?$/;

/**
 * `pypi:<name>[==<exact version>]`. Names follow PEP 508; the version is an exact PEP 440
 * release, optionally with a pre-, post- or dev-release segment.
 */
export const PYPI_ENTRY =
  /^pypi:[\dA-Za-z](?:[\w.-]*[\dA-Za-z])?(?:==\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?)?$/;

/**
 * `oci:<image>[@sha256:<digest>]`: an image reference in lower case, with an optional registry
 * host and port, and no tag.
 */
export const OCI_ENTRY =
  /^oci:[\da-z][\d._a-z-]*(?::\d+\/[\da-z][\d._a-z-]*)?(?:\/[\da-z][\d._a-z-]*)*(?:@sha256:[\da-f]{64})?$/;

/**
 * An origin, `scheme://host[:port]` with an http, https, ws or wss scheme, and nothing after it.
 * The host is a DNS name, optionally behind a leading `*.` wildcard, an IPv4 address, or an IPv6
 * address in brackets. The port is 1 to 65535.
 */
export const ORIGIN_ENTRY =
  /^(?:https?|wss?):\/\/(?:(?:\*\.)?(?:[\dA-Za-z](?:[\dA-Za-z-]*[\dA-Za-z])?\.)*[\dA-Za-z](?:[\dA-Za-z-]*[\dA-Za-z])?|\[[\d.:A-Fa-f]+\])(?::(?:6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]\d{4}|[1-9]\d{0,3}))?$/;

/** A tool name for `permissions.denyTools`, such as `WebFetch` or `mcp__github__create_issue`. */
export const TOOL_NAME = /^[\w.-]+$/;

/** A program name for `permissions.denyCommands`, such as `curl` or `python3.12`. */
export const COMMAND_NAME = /^[\w+.-]+$/;

const hookRequirementSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agent', 'event'],
  properties: {
    agent: { enum: [...HOOK_PLATFORMS] },
    event: { description: 'A hook event the agent fires.', type: 'string' },
    matcher: { description: "Must equal the hook's matcher.", type: 'string' },
    script: {
      description: 'A repository path the hook must run, such as scripts/hooks/guard.sh.',
      type: 'string',
      minLength: 1,
    },
    command: { description: "Must equal the hook's command line.", type: 'string', minLength: 1 },
  },
  anyOf: HOOK_PLATFORMS.map((agent) => ({
    properties: { agent: { const: agent }, event: { enum: [...HOOK_EVENTS[agent]] } },
  })),
};

const budgetSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    startupTokens: {
      description:
        'The most tokens (≈ characters / 4) any load plan of the agent may have at session start.',
      type: 'integer',
      minimum: 1,
      maximum: MAX_STARTUP_TOKENS,
    },
    subagentStartupTokens: {
      description:
        "The most tokens (≈ characters / 4) any of the agent's subagent calls may start with, in a context window of its own. Needs agentcheckup 0.3.0 or later.",
      type: 'integer',
      minimum: 1,
      maximum: MAX_STARTUP_TOKENS,
    },
  },
};

const modelValues = (description: string) => ({
  description,
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: MAX_MODEL_LENGTH },
});

const modelRuleSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    allow: modelValues(
      'Model values the agent may be set to, exactly as written, such as sonnet or claude-opus-5-5. When present, even empty, only listed values pass.',
    ),
    deny: modelValues('Model values the agent must not be set to, even when allow lists them.'),
  },
};

export const POLICY_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['policyVersion', 'name'],
  properties: {
    $schema: { type: 'string' },
    policyVersion: { description: 'The policy format version.', const: POLICY_VERSION },
    name: {
      description: 'Shown in reports.',
      type: 'string',
      minLength: 1,
      maxLength: MAX_NAME_LENGTH,
    },
    mode: {
      description: '"enforce" (default) fails the run on violations; "audit" only reports them.',
      enum: [...POLICY_MODES],
    },
    existing: {
      description:
        'With a baseline: "report" (default) fails only on new violations, "fail" on all of them.',
      enum: [...EXISTING_MODES],
    },
    mcp: {
      type: 'object',
      additionalProperties: false,
      properties: {
        allow: {
          description:
            'MCP servers that may be configured: npm:<name>[@version], pypi:<name>[==version], oci:<image>[@sha256:digest], or an origin such as https://mcp.example.com or https://*.example.com. When present, even empty, only listed servers pass.',
          type: 'array',
          items: {
            type: 'string',
            anyOf: [NPM_ENTRY, PYPI_ENTRY, OCI_ENTRY, ORIGIN_ENTRY].map((entry) => ({
              pattern: entry.source,
            })),
          },
        },
        allowLocal: {
          description: 'Allow servers that run a script from the repository. Default false.',
          type: 'boolean',
        },
        requirePin: {
          description:
            'Require an exact version, a digest or a repository script for every server that runs local code. Default false.',
          type: 'boolean',
        },
      },
    },
    forbid: {
      description: 'Settings that must not be configured.',
      type: 'array',
      items: { enum: [...FORBID_NAMES] },
    },
    permissions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        denyTools: {
          description: 'Tools no grant may let an agent use without asking.',
          type: 'array',
          items: { type: 'string', pattern: TOOL_NAME.source },
        },
        denyCommands: {
          description: 'Programs no shell grant may let an agent run without asking.',
          type: 'array',
          items: { type: 'string', pattern: COMMAND_NAME.source },
        },
      },
    },
    hooks: {
      type: 'object',
      additionalProperties: false,
      properties: {
        require: {
          description:
            'Hooks that must be configured. Configured, not enforced: hooks fail open on errors and timeouts, and user settings can turn them off.',
          type: 'array',
          items: hookRequirementSchema,
        },
      },
    },
    budgets: {
      description: 'Startup context limits per agent.',
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(CONTEXT_AGENTS.map((agent) => [agent, budgetSchema])),
    },
    models: {
      description:
        "Per agent, the models its agent definitions and the repository's model settings may name.",
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(CONTEXT_AGENTS.map((agent) => [agent, modelRuleSchema])),
    },
  },
} as const;
