# Repository settings

GitHub settings live outside Git, so this page records them. The rulesets in
[`.github/rulesets/`](../../.github/rulesets) are the source of truth: change a file in a pull
request, then apply it with the commands at the end of this page.

## Rulesets

| Ruleset                   | Applies to      | What it enforces                                                                                                                                                                                                                | Who can bypass |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `main: integrity`         | the main branch | No deletion, no force push, linear history, signed commits. The CI checks must have passed on the exact commit, with the branch up to date.                                                                                     | Nobody         |
| `main: pull requests`     | the main branch | Changes arrive through a pull request with an approving review from a code owner, the latest push approved by someone else, resolved review threads, squash merge only, a Conventional Commits title, and clean CodeQL results. | Admins         |
| `release tags: immutable` | `v*` tags       | Release tags cannot be moved or deleted.                                                                                                                                                                                        | Nobody         |

The rules are split in two on purpose. The integrity rules hold for everyone, admins included:
nothing reaches `main` unsigned, rewritten, or without green CI on that commit. Only the
pull request rules can be bypassed, and only by admins, so a maintainer can land their own
signed and tested commits as they are. The merge button would replace them with new commits
signed by GitHub.

Tags are created by release-please through the API, so tag creation stays open. A tag that
exists cannot change.

## Landing a maintainer change

Every change goes through a pull request, including the maintainer's. The merge button replaces
the commits with a squash commit signed by GitHub. To keep their own signed commits, a
maintainer can instead fast-forward `main` to the pull request head once the checks pass:

```sh
git push origin HEAD:refs/heads/<topic>
gh pr create --fill
gh pr checks --watch --fail-fast
git push origin HEAD:main
```

GitHub accepts the push only if the required checks passed on that exact commit in a pull
request. Checks from a manual workflow run on a branch don't count. GitHub then marks the pull
request as merged and deletes its branch.

## Release pull requests

release-please opens and updates its pull request with the workflow token. GitHub does not
start workflows for events caused by that token, so the required checks never run on it on
their own. Before merging a release pull request, close and reopen it as the maintainer. That
runs CI and the title check on the current head. Then approve and squash-merge it.

```sh
gh pr close <number> && gh pr reopen <number>
```

Repeat this whenever release-please updates the pull request. Giving release-please a GitHub
App token instead of the workflow token would remove this step.

## Merging

- Squash merge is the only merge method. The commit title is the pull request title and the
  body is empty, so release-please reads exactly one Conventional Commit per pull request. Mark
  a breaking change with `!` in the title, for example `feat(cli)!: ...`.
- Head branches are deleted after merge. Auto-merge and "Update branch" are allowed.
- The wiki is off, because wiki edits skip review. Discussions are on for the support channel
  in [SUPPORT.md](../../SUPPORT.md).

## GitHub Actions

- The default workflow token is read-only. Actions may open pull requests, which release-please
  needs.
- Only GitHub-owned actions and this allowlist may run: `amannn/action-semantic-pull-request`,
  `googleapis/release-please-action`, `ossf/scorecard-action`, `pnpm/action-setup`,
  `step-security/harden-runner` and `zizmorcore/zizmor-action`. A new third-party action must be
  added in Settings, Actions, General, in the same pull request that introduces it.
- Every action must be pinned to a full commit SHA, including actions called from inside
  composite actions.

## Security features

- Dependabot alerts and Dependabot security updates are on.
- Private vulnerability reporting is on, so reports can follow [SECURITY.md](../../SECURITY.md).
- Secret scanning and push protection are on.
- Workflow runs from all outside contributors need approval before they start.
- `main: pull requests` requires CodeQL results with no errors and no security alerts of high
  severity or above. The rule is in the pull request ruleset, not in `main: integrity`, so a
  maintainer's fast-forward is not blocked when CodeQL has not analyzed that commit yet.

## The `npm` environment

The release workflow's publish job runs in the `npm` environment, and npm trusted publishing is
bound to it. The job that builds the tarball runs before it, without the environment, so the
approval comes after `pnpm check` passed on the tag. The environment needs the maintainer as a
required reviewer, no admin bypass, and deployments from `main` only. Create it with:

```sh
gh api -X PUT repos/mustafakbaser/agentcheckup/environments/npm --input - <<'JSON'
{
  "prevent_self_review": false,
  "can_admins_bypass": false,
  "reviewers": [{ "type": "User", "id": 32432625 }],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
JSON
gh api -X POST repos/mustafakbaser/agentcheckup/environments/npm/deployment-branch-policies \
  -f name=main -f type=branch
```

`prevent_self_review` stays off because the maintainer is the only reviewer.

Immutable releases are off for now. The release workflow's `release-asset` job attaches the
tarball to a release that already exists, which an immutable release would refuse. Enabling them first needs
release-please to create draft releases.

## Applying and rolling back

List the rulesets, then replace one with its file:

```sh
gh api repos/mustafakbaser/agentcheckup/rulesets --jq '.[] | "\(.id) \(.name)"'
gh api -X PUT repos/mustafakbaser/agentcheckup/rulesets/<id> --input .github/rulesets/<file>.json
```

GitHub keeps a history of every ruleset in Settings, Rules, Rulesets, and can restore an earlier
version. To recover from an emergency, set the ruleset's enforcement to `disabled`, fix the
problem, and set it back to `active`. The audit log records both changes.
