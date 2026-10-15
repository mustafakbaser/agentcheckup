# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-10-14

## Context

agentcheck is maintained in the open. Contributors need to know why the code looks the way it
does before they change it, and the maintainer needs a place to write down trade-offs that a
commit message is too small for.

## Decision

Keep short architecture decision records in `docs/adr/`, numbered, one decision per file, using
[the template](template.md). Records are immutable once accepted; a later record supersedes an
earlier one.

## Consequences

Decisions get one paragraph of justification at the moment they are made, which is cheap. Pull
requests that reverse a recorded decision must add a superseding record.
