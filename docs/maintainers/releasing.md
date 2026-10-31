# Releasing

Releases are cut by [release-please](https://github.com/googleapis/release-please) and published
by `.github/workflows/release.yml`. No npm token exists anywhere: publishing uses
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) from one workflow and
one protected GitHub environment.

## Normal release

1. Merge pull requests into `main` with Conventional Commit titles.
2. release-please keeps a "chore(main): release x.y.z" pull request up to date with the version
   bump and changelog.
3. Close and reopen that pull request so the required checks run on it, then approve and merge
   it. [Repository settings](repository-settings.md#release-pull-requests) explains why. The
   workflow tags the release, runs `pnpm check` on the tag and packs the tarball, waits for
   approval on the `npm` environment, attests the tarball, publishes it to npm with provenance,
   and attaches it to the GitHub release.
4. After the release of [agentcheckup-action](https://github.com/mustafakbaser/agentcheckup-action)
   that runs the new version, point the README's example at it: the release's commit SHA, with
   the version in the comment. A test fails once the example is more than one minor version
   behind the package. release-please bumps the pinned versions in `docs/skill.md` and
   `docs/tasks.md` itself; a test checks that every `npx agentcheckup@<version>` in the docs is
   one it bumps.

Before 1.0.0, breaking changes bump the minor version and features bump the patch version.

## How the release workflow publishes

The publish steps run in three jobs, so that the code running with each permission is as small
as it can be:

| Job             | Permissions                                                 | What it runs                                                                                                                                                   |
| --------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`         | `contents: read`                                            | Checks out the tag, runs `pnpm install` and `pnpm check`, packs the tarball and uploads it as the `package` artifact. Its outputs carry the tarball's SHA-256. |
| `publish`       | `id-token: write`, `attestations: write`; environment `npm` | Downloads the artifact, checks its SHA-256, attests it and runs `npm publish`. No checkout, no install.                                                        |
| `release-asset` | `contents: write`                                           | Downloads the artifact, checks its SHA-256 and attaches it to the GitHub release.                                                                              |

Only `publish` can request an OIDC token, the credential npm trusted publishing accepts, and it
runs no code from the repository or its dependencies. A compromised devDependency runs in
`build`, where it has a read-only token and cannot publish. It could still change what it builds,
so the lockfile, `minimumReleaseAge`, `pnpm check` and the smoke test of the packed tarball stay
the defense for the tarball's contents.

npm checks the workflow file (`release.yml`) and the environment (`npm`) of the run, not the job
name, so the trusted publisher configuration below did not change with the split. CI rehearses
the same hand-over on every pull request: the "Build and verify the package" job packs a
tarball with a version npm has never seen and uploads it, and "Rehearse the publish job"
downloads it, checks its hash and runs `npm publish --dry-run` without a checkout.

## One-time setup

Do these once, in this order. They need the maintainer's npm and GitHub accounts, so they are
not automated.

1. **Reserve the npm name early.** npm refuses new names that differ from an existing package
   only by punctuation, which is why the project is not called `agentcheck` (`agent-check`
   exists). On 2026-10-15 `agentcheckup` and every punctuation variant of it were free. Publish
   the placeholder in step 3 soon, so nobody takes the name first. The name is defined in
   `package.json` and `src/core/meta.ts`.
2. **Secure the accounts.** Use a passkey or hardware key for npm and GitHub two-factor
   authentication.
3. **Create the package.** Trusted publishing can only be configured for a package that exists.
   Publish a `0.0.0` placeholder manually: a minimal package with the same name, a README that
   says the name is reserved, and no install scripts. After 0.1.0 is out, deprecate it with
   `npm deprecate agentcheckup@0.0.0 "Placeholder. Install the latest version."`.
4. **Configure trusted publishing** on npmjs.com for the package: GitHub Actions, repository
   `mustafakbaser/agentcheckup`, workflow `release.yml`, environment `npm`. A new configuration
   must complete its first publish within two days, so set it up right before the first release.
5. **Lock down publishing.** In the package settings, require two-factor authentication and
   disallow tokens.
6. **Protect the environment.** Create `npm` with yourself as a required reviewer and restrict it
   to the `main` branch. The command is in
   [repository settings](repository-settings.md#the-npm-environment).
7. **Apply the repository settings.** Rulesets for `main` and release tags, merge settings, the
   Actions allowlist and Dependabot are described in
   [repository settings](repository-settings.md). They were applied on 2026-10-15.
8. **At launch,** when the repository becomes public, turn on the features GitHub offers only for
   public repositories. They are listed under
   [security features](repository-settings.md#security-features) and were turned on on
   2026-10-15.
9. **Let release-please open its pull request.** In Settings, Actions, General, enable "Allow
   GitHub Actions to create and approve pull requests". New repositories have it off, and the
   Release workflow fails with "GitHub Actions is not permitted to create or approve pull
   requests" until it is on. The default workflow token stays read-only; only the Release
   workflow's release-please job asks for `contents: write` and `pull-requests: write`. From
   the command line:

   ```sh
   gh api -X PUT repos/mustafakbaser/agentcheckup/actions/permissions/workflow \
     -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
   ```

## Keeping rules current

Rules cite documentation and source code that change. A weekly workflow compares every cited
source with a committed baseline and opens a `source-drift` issue when one changes or cannot be
fetched. [Source drift](source-drift.md) explains how to handle those issues.

## Dependency updates

Dependabot proposes updates weekly with a 7-day cooldown, matching `minimumReleaseAge` in
`pnpm-workspace.yaml`. It updates the pnpm 12 lockfile: pull request #80 bumped seven
devDependencies in `pnpm-lock.yaml`, and CI passed on it.

Every dependency is a devDependency: tsdown bundles the ones the CLI runs, so the package has
none. Minor and patch updates arrive in two grouped pull requests:

- **`bundled`**: `ignore`, `jsonc-parser`, `mdast-util-from-markdown`, `picomatch` and `yaml`,
  the packages tsdown bundles into `dist/`. `THIRD_PARTY_NOTICES.md`, which `pnpm build` writes,
  lists them with the packages they bring along. A bump changes the code users run.
- **`development`**: everything else, the tools that build and test the package.

Dependabot sets one commit message prefix for all npm updates, not one per group, so both
arrive titled `build: ...`, a type release-please leaves out of the changelog. Before merging a
`bundled` pull request, or any other that bumps a bundled package (a security update of
`micromark`, say, or a major update), retitle it to `fix(deps): ...`: the squash commit takes
the pull request's title, so the bump gets a changelog entry and a release.

A bundled bump needs more than green CI. Read the package's changelog, and run the unit tests
that cover it: `test/parse` and `test/fix` for `yaml`, `jsonc-parser` and
`mdast-util-from-markdown`, `test/core/config.test.ts` for `picomatch`, which matches the
configuration's `ignore` and `overrides` globs, and `test/io` for `ignore`. For `ignore`, also
compare how `.gitignore` files are read before and after the bump. The corpus checks cannot
show it: `scripts/corpus/virtual-walk.ts` replays the walk without applying `.gitignore`. Scan a
few repositories with nested `.gitignore` files and negated patterns with
`node dist/cli.js <repo> --context --format json --output <file> --fail-on none`, built from
both versions, and compare the `artifacts`, the findings and the plans' `ignored` counts.

## If something goes wrong

- A job failed for a reason outside the repository, such as a registry outage: use "Re-run
  failed jobs" on the run within 7 days, while the `package` artifact exists. The jobs that
  succeeded keep their results and outputs, so the tarball is not built again; a re-run of
  `publish` needs the `npm` environment approval again. If `publish` succeeded and only
  `release-asset` failed, re-running it uploads the same tarball.
- The `build` or `publish` job failed after the GitHub release was created and the workflow
  needs a fix: the tag is immutable, so fix the workflow on `main`, then run it for that tag:
  `gh workflow run release.yml -f tag=v0.1.0`. The run builds the tag's source, checks that
  `package.json` holds that version, and needs the same `npm` environment approval as any
  publish.
- The publish step fails with `404 Not Found - PUT https://registry.npmjs.org/agentcheckup` after
  the provenance statement is signed: npm did not accept the run as the trusted publisher. A new
  configuration that has not published within two days lapses; revoke it
  (`npm trust revoke agentcheckup --id=<id>`, the id from `npm trust list agentcheckup`) and
  create it again (`npm trust github agentcheckup --file=release.yml
--repository=mustafakbaser/agentcheckup --environment=npm --allow-publish`), then run the
  workflow for the tag. Otherwise check that the file, repository and environment match exactly.
- A bad version was published: publish a fixed patch release. Use `npm deprecate` on the bad
  version with a message pointing to the fix. Do not unpublish.
- A credential or workflow was compromised: revoke trusted publishing on npmjs.com first, then
  investigate. Follow [SECURITY.md](../../SECURITY.md) for disclosure.
