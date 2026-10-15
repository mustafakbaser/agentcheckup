# Releasing

Releases are cut by [release-please](https://github.com/googleapis/release-please) and published
by `.github/workflows/release.yml`. No npm token exists anywhere: publishing uses
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) from one workflow and
one protected GitHub environment.

## Normal release

1. Merge pull requests into `main` with Conventional Commit titles.
2. release-please keeps a "chore(main): release x.y.z" pull request up to date with the version
   bump and changelog.
3. Merge that pull request. The workflow tags the release, waits for approval on the `npm`
   environment, runs `pnpm check`, builds, attests the tarball, publishes to npm with provenance,
   and attaches the tarball to the GitHub release.

Before 1.0.0, breaking changes bump the minor version and features bump the patch version.

## One-time setup

Do these once, in this order. They need the maintainer's npm and GitHub accounts, so they are
not automated.

1. **Choose the npm name.** npm refuses names that differ from an existing package only by
   punctuation. `agent-check` exists, so publishing `agentcheck` may be rejected. Confirm the
   name before the first publish; the name is defined in `package.json` and `src/core/meta.ts`.
2. **Secure the accounts.** Use a passkey or hardware key for npm and GitHub two-factor
   authentication.
3. **Create the package.** Trusted publishing can only be configured for a package that exists.
   Publish a `0.0.0` placeholder manually from a clean checkout:
   `npm publish --access public` with a minimal `package.json` that has the same name.
4. **Configure trusted publishing** on npmjs.com for the package: GitHub Actions, repository
   `mustafakbaser/agentcheck`, workflow `release.yml`, environment `npm`.
5. **Lock down publishing.** In the package settings, require two-factor authentication and
   disallow tokens.
6. **Protect the environment.** In GitHub, Settings, Environments, create `npm` with yourself as
   a required reviewer and restrict it to the `main` branch.
7. **Protect `main`** with a ruleset: require pull requests, require the CI, CodeQL and
   pull-request-title checks, block force pushes, and require signed commits.
8. **Protect tags** with a ruleset for `v*`, and enable immutable releases.
9. **Enable** private vulnerability reporting, secret scanning with push protection, and
   Dependabot alerts.
10. **Let release-please open its pull request.** In Settings, Actions, General, enable "Allow
    GitHub Actions to create and approve pull requests". New repositories have it off, and the
    Release workflow fails with "GitHub Actions is not permitted to create or approve pull
    requests" until it is on. The default workflow token stays read-only; only the Release
    workflow's release-please job asks for `contents: write` and `pull-requests: write`. From
    the command line:

    ```sh
    gh api -X PUT repos/mustafakbaser/agentcheck/actions/permissions/workflow \
      -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
    ```

## Dependency updates

Dependabot proposes updates weekly with a 7-day cooldown, matching `minimumReleaseAge` in
`pnpm-workspace.yaml`. Dependabot's support for pnpm 12 lockfiles is not confirmed yet. If its
npm updates fail, switch npm updates to Renovate and keep Dependabot for GitHub Actions.

## If something goes wrong

- A bad version was published: publish a fixed patch release. Use `npm deprecate` on the bad
  version with a message pointing to the fix. Do not unpublish.
- A credential or workflow was compromised: revoke trusted publishing on npmjs.com first, then
  investigate. Follow [SECURITY.md](../../SECURITY.md) for disclosure.
