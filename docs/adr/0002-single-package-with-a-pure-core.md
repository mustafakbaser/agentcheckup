# 0002. Single package with a pure core

- Status: Accepted
- Date: 2026-10-14

## Context

The first plan was a six-package monorepo (core, rules, adapters, graders, CLI, action) plus a
Next.js site. An independent review found that this structure costs a solo maintainer weeks of
tooling work before it pays anything back, and that a GitHub Action published to the Marketplace
must live in its own repository with `action.yml` at the root anyway.

The core still needs to be reusable: a browser playground, an editor extension and a GitHub
Action are all on the roadmap.

## Decision

- Ship one npm package, `agentcheck`, ESM only, Node.js >= 22.12.
- Keep a hard boundary inside it. `src/core`, `src/parse`, `src/platforms`, `src/rules` and
  `src/report` are pure: they take bytes and return data. ESLint forbids file system, process
  and network imports in those directories. Only `src/io` touches the disk and only `src/cli`
  touches the process.
- Bundle all runtime code with tsdown into single files. Runtime libraries are listed as
  development dependencies so they are bundled, which gives the published package zero
  dependencies. Third-party licenses are reproduced in `THIRD_PARTY_NOTICES.md`.
- Use no CLI framework (`node:util` `parseArgs`) and no color library (an injected style
  interface), to keep `npx agentcheck` fast to install and start.

## Consequences

- Splitting into packages later is mechanical because the pure/impure boundary already exists.
- A zero-dependency tarball means nothing can change underneath users between our releases, and
  `npx` downloads one package.
- We own a little more code (argument parsing, color handling) than a framework would give us.
