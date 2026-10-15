# 0005. A score that cannot be padded or gamed cheaply

- Status: Accepted
- Date: 2026-10-14

## Context

A single number is easy to share and easy to game. Averages reward adding many trivial clean
files. A "security" category that adds points would turn a red flag into a green badge for a
malicious skill. Scores that change between machines or releases erode trust.

## Decision

Score formula version 1, documented in [docs/scoring.md](../scoring.md):

- Each artifact starts at 100 and loses 40 per error and 8 per warning, floored at 0. One
  error takes a file to 60 (D); three take it to 0.
- The repository score is `0.7 × mean + 0.3 × worst artifact`, rounded.
- Any `risk` error caps the score at 49.
- No artifacts means no score, not 0 or 100.
- Suppressed findings do not count. In `--untrusted` mode suppressions and repository
  configuration are ignored.
- The badge says "agent config", never "safe".

We publish aggregate statistics only. We do not publish rankings of other people's repositories
and do not open unsolicited badge pull requests.

## Consequences

- Penalties are coarse by design: an error is a documented breakage, so it should hurt. An
  earlier draft used 25 and 5; on a sample repository where agents mis-loaded three of seven
  files it produced a B, which overstated how well the configuration worked.
- Changing weights requires a new formula version and a note in the changelog.
