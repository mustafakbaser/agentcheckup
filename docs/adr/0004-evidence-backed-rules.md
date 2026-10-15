# 0004. Evidence-backed, versioned rules

- Status: Accepted
- Date: 2026-10-14

## Context

At least five tools already lint agent configuration files or grade them from 0 to 100. Most
rules in that space encode opinions ("add a Testing section"). Gloaguen et al.,
[Evaluating AGENTS.md](https://arxiv.org/abs/2602.11988) (2026), found that context files do not
generally raise task success and increase inference cost by over 20% on average, while agents do
follow the instructions in them. A score that rewards more content would be dismissed by the
people we most want to reach. Platform behavior also changes quickly: Claude Code started reading
`AGENTS.md` in version 2.1.277, and Gemini CLI was replaced by Antigravity CLI for unpaid and
Google One users on 18 June 2026.

## Decision

- A rule may be `error` only when a documented platform behavior skips, ignores, truncates or
  breaks the file. `warn` covers degraded behavior and portability problems. `info` is advice and
  never affects the score.
- Every rule cites at least one source (official documentation or the platform's source code)
  with the date it was last checked. Behavior we could not verify is `unverified` and may only
  produce `info` findings.
- Rule ids are stable and never reused. Each rule has a documentation page generated from its
  metadata.
- Rules are grouped into calendar-versioned rule sets (`2026.10`). A released rule set is
  immutable apart from false-positive fixes, so a repository's score cannot drop without a rule
  set change. Reports record the tool version, rule set version and score formula version.

## Consequences

- The rule catalog grows more slowly than an opinion-based one.
- Each rule's message can say exactly what will happen ("Codex stops reading here") instead of
  what is recommended.
- Sources need re-checking; a scheduled job will diff the cited documentation and open an issue
  when it changes.
