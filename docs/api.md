# Programmatic API

The package exports the scanner the CLI uses. It is an ES module with TypeScript types:

```ts
import { scan } from 'agentcheckup';

const result = await scan('.', { targets: ['claude-code', 'codex'], context: true });
console.log(result.score.score, result.findings.length);
```

The package root is the only entry point; `exports` in `package.json` allows no deep imports.

## What `scan()` reads

`scan(root, options)` walks `root`, reads the files agents load, and runs every built-in rule. It
throws `WalkError` when `root` is missing, not a directory or unreadable.

**It does not read `agentcheckup.config.json`.** The CLI reads that file from the scanned
directory, or the file `--config` names; `scan()` uses only the configuration you pass as
`options.config`, the parsed JSON. `resolveConfig` validates it and throws `ConfigError` with a
readable message. To scan as the CLI does in a repository you trust:

```ts
import { readFile } from 'node:fs/promises';
import { scan } from 'agentcheckup';

const config: unknown = JSON.parse(await readFile('agentcheckup.config.json', 'utf8'));
const result = await scan('.', { config });
```

The CLI refuses a configuration file that is a symbolic link or larger than 256 KiB, because the
file comes from the repository. Do the same when you read it yourself, or leave it out for a
repository you do not trust.

The other options:

| Option            | Default                        | Meaning                                                                                                                    |
| ----------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `config`          | none                           | The parsed configuration. Its `targets`, `rules`, `ignore` and `overrides` apply as in the CLI.                            |
| `targets`         | the config's, else every agent | The agents to check against. Overrides the config's `targets`, as `--targets` does.                                        |
| `trustDirectives` | `true`                         | Honor inline suppressions such as `agentcheckup-disable-next-line`.                                                        |
| `walk`            | `.gitignore` honored           | Limits and switches of the walk: `respectGitignore`, `scanIgnoredAgentConfig`, `maxFileBytes`, `maxTotalBytes` and others. |
| `context`         | `false`                        | `true` adds the load plans of the modeled agents among the targets, at the root, to `result.context`; or their options.    |

The CLI's `--untrusted` corresponds to no `config`, `trustDirectives: false` and
`walk: { scanIgnoredAgentConfig: true }`: the repository can then neither switch rules off nor
hide agent configuration behind its `.gitignore`.

## Other exports

- `scanSnapshot` and `scanWithContext` scan a snapshot you built in memory, with the rules you
  pass, such as `builtinRules`.
- `validateBaseline`, `compareWithBaseline` and `parseGateClasses` compare a scan with an earlier
  JSON report, as `--baseline` and `--gate` do.
- `fixRounds` plans, applies and verifies fixes on a copy of a snapshot in memory, and
  `applyPlan` applies a plan to a snapshot. Neither writes a file.
- `rebaseResult` and `stripPathBase` move report paths under a base directory and back.
- Constants such as `VERSION`, `RULESET_VERSION`, `PLATFORM_IDS`, `CONTEXT_AGENTS` and
  `GATE_CLASSES`, and the types of every result.

The JSON report (`--format json`) is the result in a documented shape, versioned by its
`schemaVersion` and described by [schemas/report.schema.json](../schemas/report.schema.json).

## Stability

The API is not stable before 1.0.0. Until then:

- A breaking change, such as a removed or renamed export or a changed signature, comes in a new
  minor version, and the changelog lists it under breaking changes.
- A patch version may add exports, options and fields of result types. Do not rely on a field
  being absent.
- The names the package exports are recorded in
  [test/core/\_\_snapshots\_\_/api-exports.txt](../test/core/__snapshots__/api-exports.txt), so a
  pull request that changes them shows it.
