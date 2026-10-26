# 0011. Check repositories against an organization policy

- Status: Accepted
- Date: 2026-10-17
- Amends: [0007](0007-model-what-each-agent-loads.md), where token counts never fail a run
- Amended by: [0012](0012-list-hooks-servers-and-permissions-declared-in-frontmatter.md), whose
  frontmatter items the policy checks too

## Context

The gate ([ADR 0007](0007-model-what-each-agent-loads.md)) makes every security-relevant change
visible and fails the check until someone reviews it. Teams then ask the next question: which
changes are acceptable at all? Security teams want to say once, for every repository, that only
these MCP servers may run, that no repository may grant an agent every shell command, that a
guard hook must be configured, and that an agent may not start with more than a set amount of
context.

Three things make this harder than a configuration file:

- **Who writes the rules.** `agentcheckup.config.json` belongs to the repository. A pull request
  can edit it, turn rules off, ignore files or add inline directives. Rules an organization sets
  must not be in the reach of the change they judge.
- **What counts as a violation.** Findings describe how agents load files and feed the score
  ([ADR 0005](0005-scoring.md)). A forbidden server that loads correctly is not a loading
  problem, and an organization's rules must not move a score that means the same in every
  repository.
- **What cannot be known.** agentcheckup cannot read every launcher's command line, cannot
  analyze a configuration file that does not parse, and cannot see user settings ([ADR 0003](0003-treat-scanned-repositories-as-hostile.md)).
  A check that passes whenever it cannot tell would invite configuration that hides from it.

## Decision

- **A policy file.** `--policy <file>` reads a JSON policy (`schemas/policy.schema.json`,
  `policyVersion` 1) with an MCP allowlist, a pin requirement, a closed list of forbidden
  settings, denied tools and commands, required hooks and per-agent startup budgets. The
  validator is hand-written and agrees with the schema; unknown fields, unknown setting names and
  unknown hook events are errors, so a typo cannot switch a check off.
- **Violations are not findings.** They live in the report's `policy` field: no rule id, no
  suppressible fingerprint, never in the score. Repository configuration and inline directives
  cannot name them.
- **The repository cannot switch the policy off.** `--policy` implies `--untrusted`: the
  repository's configuration and directives are ignored, and its `.gitignore` cannot hide agent
  configuration. `--policy` with `--config` is a usage error. `--targets` does not narrow the
  policy: every inventory item is checked and every agent a budget names is planned.
- **Fail closed.** A configuration file that cannot be analyzed is a violation of its own; a
  server whose package or version cannot be told matches no allowlist entry; a shell grant whose
  program cannot be told counts as running every denied program; an agent with a budget but no
  load plan fails its budget.
- **Same tables as the gate.** Broad grants, env override classes and pin states come from the
  code the gate uses, so the policy and `--gate` agree on what an entry does.
- **Baselines.** The same pure function checks the baseline report. A violation's id is its
  check, its subject and, for an inventory item, the item's digest, relative to the scanned
  directory, so changing a server that already violates the policy is a new violation. The policy
  decides what existing violations do: `"existing": "report"` fails only on new ones, `"fail"`
  on all of them.
- **Exit codes.** 1 when a violation fails the run, whatever `--fail-on` says; `"mode": "audit"`
  never fails. 2 for any problem with the policy file, which is read as untrusted input: a regular
  file, at most 256 KiB.
- **Startup budgets.** An organization may fail a run on estimated startup tokens. This amends
  ADR 0007, where token counts never fail a run: the limit is set by the organization, the
  report labels it as an estimate, and it still never affects the score.
- **Hooks are configured, not enforced.** A hook requirement checks presence only. Every report
  line about one says that hooks fail open on errors and timeouts and that user settings can turn
  them off.
- **Identity of the policy.** Reports carry the policy's name and the SHA-256 of the file's
  bytes, which `shasum -a 256` reproduces, and note when the policy file lies inside the scanned
  directory.
- **Trust lives outside the repository.** The policy file must come from a trusted tree: the base
  branch or a central repository, never the pull request. The GitHub Action reads it from there.
  Real enforcement needs a ruleset that requires a workflow from a central repository at a pinned
  ref, or CODEOWNERS on `.github/workflows/` with required code-owner review.

## Consequences

- Organizations get a check they can require across repositories without trusting any of them,
  and a policy rollout can start in audit mode.
- Fail-closed checks have a cost: a configuration file agentcheckup cannot analyze, such as a
  `.codex/config.toml` that is not valid TOML, is a violation whenever an inventory check is on.
  With a baseline and `"existing": "report"`, a file the base branch already had does not fail
  the run.
- A required hook proves configuration, not behavior. The reports say so instead of implying a
  control the repository cannot enforce.
- Gitignored personal files such as `.claude/settings.local.json` are checked on a developer's
  machine and never in CI, which sees only committed files. User and managed settings are never
  read, so a developer can still allow locally what the policy forbids.
- SARIF code scanning needs a file for every result, so violations of the whole repository (a
  missing hook, a startup budget) appear as tool notifications there, and in full in every other
  format.
- A second format to keep stable: `policyVersion` and the report's `policy` field change only
  additively within version 1.
