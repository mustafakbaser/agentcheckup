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
   workflow tags the release, waits for approval on the `npm` environment, runs `pnpm check`,
   builds, attests the tarball, publishes to npm with provenance, and attaches the tarball to the
   GitHub release.

Before 1.0.0, breaking changes bump the minor version and features bump the patch version.

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
   `mustafakbaser/agentcheckup`, workflow `release.yml`, environment `npm`.
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
`pnpm-workspace.yaml`. Dependabot's support for pnpm 12 lockfiles is not confirmed yet. If its
npm updates fail, switch npm updates to Renovate and keep Dependabot for GitHub Actions.

## If something goes wrong

- A bad version was published: publish a fixed patch release. Use `npm deprecate` on the bad
  version with a message pointing to the fix. Do not unpublish.
- A credential or workflow was compromised: revoke trusted publishing on npmjs.com first, then
  investigate. Follow [SECURITY.md](../../SECURITY.md) for disclosure.
