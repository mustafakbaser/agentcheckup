# Architecture decision records

Significant decisions, with the context that made them reasonable at the time. A decision is
changed by adding a new record that supersedes the old one, never by editing history.

| ADR                                                                        | Title                                                                  | Status   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| [0001](0001-record-architecture-decisions.md)                              | Record architecture decisions                                          | Accepted |
| [0002](0002-single-package-with-a-pure-core.md)                            | Single package with a pure core                                        | Accepted |
| [0003](0003-treat-scanned-repositories-as-hostile.md)                      | Treat scanned repositories as hostile                                  | Accepted |
| [0004](0004-evidence-backed-rules.md)                                      | Evidence-backed, versioned rules                                       | Accepted |
| [0005](0005-scoring.md)                                                    | A score that cannot be padded or gamed cheaply                         | Accepted |
| [0006](0006-scope-for-the-first-release.md)                                | Scope for the first release                                            | Accepted |
| [0007](0007-model-what-each-agent-loads.md)                                | Model what each agent loads and gate security-relevant changes         | Accepted |
| [0008](0008-write-fixes-to-the-scanned-repository.md)                      | Write fixes to the scanned repository                                  | Accepted |
| [0009](0009-coverage-of-copilot-gemini-devin-cline-and-codex-toml.md)      | Coverage of Copilot, Gemini CLI, Devin Local and Cline, and Codex TOML | Accepted |
| [0010](0010-fixes-beyond-deterministic-edits.md)                           | Fixes beyond deterministic edits                                       | Accepted |
| [0011](0011-organization-policy.md)                                        | Check repositories against an organization policy                      | Accepted |
| [0012](0012-list-hooks-servers-and-permissions-declared-in-frontmatter.md) | List hooks, servers and permissions declared in frontmatter            | Accepted |
| [0013](0013-list-agent-definitions-and-their-models.md)                    | List agent definitions and their models                                | Accepted |

New records use [the template](template.md).
