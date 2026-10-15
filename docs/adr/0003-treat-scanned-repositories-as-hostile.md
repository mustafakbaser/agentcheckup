# 0003. Treat scanned repositories as hostile

- Status: Accepted
- Date: 2026-10-14

## Context

agentcheckup is most useful on repositories the user did not write: a cloned skill collection, a
pull request from a fork, a dependency's agent configuration. Its output lands in terminals, CI
logs, pull request comments and GitHub code scanning. The review identified concrete attacks:

- `gray-matter` evaluates `---js` frontmatter, and `js-yaml` has had prototype pollution and
  merge-key denial-of-service issues.
- Following a `CLAUDE.md` import such as `@~/.aws/credentials`, or a symlink out of the
  repository, would put secrets into CI artifacts.
- Opening a FIFO named `AGENTS.md` hangs a naive scanner.
- Terminal escape sequences and GitHub workflow commands (`::stop-commands::`) in file names or
  content can rewrite the terminal or spoof CI annotations.
- Rules run regular expressions over attacker-controlled text.
- Running `git` inside a cloned directory can execute commands configured through
  `core.fsmonitor`.

## Decision

- agentcheckup never executes anything from the scanned repository: no JavaScript config files, no
  plugins loaded from the target, no hook scripts, no `git` subprocess.
- All file access goes through `src/io`. It never follows a symlink or import out of the scan
  root, never opens special files, caps file size, file count, depth and total bytes, and opens
  files with `O_NOFOLLOW` where the platform supports it.
- YAML is parsed with the `yaml` package in strict YAML 1.2 mode without merge keys, with unique
  keys and a low alias limit, into null-prototype objects. JSON is parsed into null-prototype
  objects as well.
- Every output channel has its own sanitizer: terminal, workflow commands, Markdown, SARIF.
  Invisible and bidirectional characters are rendered visibly.
- Regular expressions over untrusted text must pass `eslint-plugin-regexp`'s super-linear
  backtracking checks. Dynamically built regular expressions are banned because they bypass that
  check; an early version of the directive parser backtracked for 16 seconds on a crafted line.
- Parsing cost is bounded per file and per scan. The Markdown parser can need far more time
  and memory than a file's size suggests, so each file gets a cost guard and the whole scan
  gets a budget of 16 MiB and 600,000 lines of Markdown, twice the largest repository in our
  corpus. Files past the budget are reported as partly analyzed, never silently skipped. A
  crafted 64 MiB repository that previously ran for 100 seconds and exhausted memory now
  finishes in under 8 seconds.
- Nothing is excluded by directory name inside agent configuration directories, so a skill
  named `build` or `dist` cannot hide from the scan.
- A hostile-input corpus runs in CI on Linux, macOS and Windows.
- `--untrusted` ignores the repository's own configuration file and inline suppressions, so a
  repository cannot switch rules off to improve its score.

## Consequences

- Some legitimate setups are reported rather than followed, for example a skills directory
  symlinked from outside the repository. The report says so explicitly.
- Rule authors work with pre-parsed, pre-sanitized views instead of raw strings, which also makes
  rules simpler.
