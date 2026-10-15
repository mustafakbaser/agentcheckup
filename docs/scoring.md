# How the score works

agentcheck reports a score from 0 to 100 and a letter grade. The score summarizes the findings;
the findings are what you act on. This page documents score formula **version 1**. The formula
version is included in every JSON and SARIF report, and any change to it is announced in the
changelog.

## Formula

1. Only unsuppressed `error` and `warn` findings count. `info` findings never change the score.
2. Each file agentcheck recognizes starts at 100. It loses **40 points per error** and **8 points
   per warning**, down to a minimum of 0.
3. The repository score blends the average file with the worst file:

   ```text
   score = round(0.7 × mean(file scores) + 0.3 × min(file scores))
   ```

4. If any `risk` finding has severity `error`, the score is capped at **49**.
5. If there are no agent configuration files, there is no score. agentcheck reports
   "No agent configuration files found" and exits 0.

| Grade | Score  |
| ----- | ------ |
| A     | 90–100 |
| B     | 80–89  |
| C     | 70–79  |
| D     | 60–69  |
| F     | 0–59   |

## Why it works this way

**Errors are expensive on purpose.** A rule may only be an `error` when a platform's documented
behavior skips, ignores, truncates or breaks the file. One error means an agent will not do what
the file says, so it takes that file to 60, a D. Three errors take it to 0.

**The worst file matters.** With a plain average, adding fifty trivial, clean skills would hide
one broken `AGENTS.md`. Weighting the minimum keeps one broken file visible: 99 clean files and
one file with three errors score 69, not 99.

**Security never earns points.** Pattern-based security checks can be evaded, so a high score
must not read as "safe". Risk findings can only lower or cap the score, and the badge says
"agent config", never "secure".

**No files, no score.** A repository without agent configuration is not "perfect" and not
"failing". It is out of scope.

## Stability

- Scores are a function of the files, the [rule set version](rules/README.md) and the formula
  version. A released rule set only receives false-positive fixes, so your score does not drop
  unless you change your files or upgrade to a new rule set.
- Output is deterministic: the same input produces byte-identical JSON on every machine.

## Gaming

- Suppressed findings do not count, because a suppression with a reason is a deliberate,
  reviewable decision. In `--untrusted` mode, inline suppressions and the repository's own
  configuration are ignored. Use it when scoring code you do not control.
- Deleting a broken file improves the score. That is intended: a file an agent cannot load does
  nothing useful.

## Badge

```sh
npx agentcheck --format badge
```

prints Markdown for a static [shields.io](https://shields.io) badge. agentcheck runs no badge
server and makes no network requests.
