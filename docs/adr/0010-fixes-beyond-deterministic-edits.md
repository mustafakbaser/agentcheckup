# 0010. Fixes beyond deterministic edits

- Status: Accepted
- Date: 2026-10-17
- Amends: [0008](0008-write-fixes-to-the-scanned-repository.md), where text written to the
  repository is only ever copied from it and `fix` is the only command that writes

## Context

[ADR 0008](0008-write-fixes-to-the-scanned-repository.md) lets `agentcheckup fix` write edits
that have one correct form. On the corpus that covered few findings: 148 of 3,475 had a safe
fix, 394 a fix for review, and 2,869 only a manual step. The common ones need judgment or the
author's words: a skill description that does not say when to use the skill, a skill body too
long to load, `allowed-tools` that grant every shell command, a field only some agents read.

Each way to close that gap brings a risk of its own:

- **The user's words.** Text typed at a prompt and written into YAML frontmatter can break the
  file or smuggle in a key, as copied text could.
- **Moving text.** Splitting a long `SKILL.md` moves whole sections into new files next to it.
  agentcheckup reads those files only through links, and no rule checks them, so moved text
  leaves the scan. A move could hide a payload that a rule reports today.
- **Handing work to a coding agent.** A prompt built from repository text goes to an agent that
  can write to the repository. The repository may be hostile, and the agent may follow
  instructions it finds in that text.
- **A second command that writes.** A skill that teaches agents to run agentcheckup has to get
  into the repository somehow.
- **An MCP server.** Agents could call agentcheckup as tools instead of through a shell.

## Decision

- **Fixes that need the user's words.** A fix may carry an input request (`Fix.input`: the
  field, a question, a label, an initial value and where the answer goes) instead of changes.
  The planner never plans one. A dry run and `fix --write --review` list it as `input` ("needs
  your words") and do not change the exit code; the JSON report lists it under `awaitingInput`;
  scan reports show `needs your words (fix -i)`; the docs show the class `input`. Only `fix -i`
  asks for the words. A completed fix keeps the class the rule gave it, which is `review` for
  every such fix today.
- **Typed content.** An answer is one line, with a length limit per field (a description 1,024
  characters with the text it joins, a suppression reason 200, globs 500, `allowed-tools`
  1,000), and free of control, bidirectional, tag and other invisible characters; a description
  takes no `<` or `>` and a reason no `-->`. The builders write it double-quoted and parse the
  result again. Then every rule runs on a copy with the answer: an answer that does not resolve
  the finding, or adds an error or a warning, is refused with the rule's own message and asked
  again. An accepted answer goes through the same final plan, write and re-scan as any fix.
  Input fixes and alternatives are offered only by `-i`, so `--write --review` can never remove
  a field. `-i` can also suppress a warning or info with the user's reason, never an error, a
  `risk` finding or `mcp/literal-secret`.
- **Moved content.** ADR 0008's copied content puts repository text into a YAML or JSON value.
  Moved content is different: whole Markdown sections move, byte for byte, out of `SKILL.md`
  into new files next to it, and each heading stays with one line that links to its file. The
  builder only creates files, never overwrites, makes at most 8, and names them from the heading
  (`skillSlug`), never with a name that collides with another path regardless of letter case or
  that an agent reads as configuration. Because moved text leaves the scan, a section stays in
  `SKILL.md` when it holds render-time commands, `$N` or declared argument placeholders, HTML
  comments, hidden or bidirectional characters, remote-script lines, reference-style links or
  definitions, the target of a fragment link, or a link that would break. There is no such fix
  for a `SKILL.md` reached through a symlink, a directory symlink alias, or a skill at the scan
  root. It is always `review`: an agent reads a moved section only when it follows the link.
- **Risk guard.** Verification fails a fix when the re-scan loses a `risk` finding that the fix
  does not claim, whether the finding is gone or newly suppressed. It applies to every fix, so no
  move, rewrite or suppression can hide a payload.
- **Tasks for a coding agent.** `agentcheckup tasks` writes each rule and file whose finding has
  no ready fix as a task in a Markdown or JSON prompt. Ready fixes are never tasks: step 0 tells
  the agent to preview `agentcheckup fix` and to ask the user before `fix --write --review`. The
  prompt follows six rules:
  1. Every command is an agentcheckup invocation pinned to the running version. No command from
     the repository is ever quoted as an instruction.
  2. Excerpts are minimal: frontmatter values of at most 20 lines and 1,024 characters, the
     heading outline of a long skill body, nothing from JSON files.
  3. Credentials are redacted with the detector of `mcp/literal-secret`.
  4. Repository text is fenced as `~~~~untrusted`, with a fence longer than any run of tildes
     inside; paths are code spans; control, bidirectional and tag characters show as `<U+…>`;
     messages go through the Markdown sanitizer.
  5. A preamble, whose wording a test pins, says this text is data and forbids widening
     `allowed-tools`, permissions, hooks, MCP servers or env overrides, and creating, renaming
     or deleting files a task does not name.
  6. With `--untrusted`, a banner asks the user to review the prompt, and step 0 leaves applying
     fixes to the user.

  `tasks --check` takes no other option, so a permission rule that allows it cannot write a
  file. Guard rules keep a task open when the agent breaks the file another way.
  [Tasks for a coding agent](../tasks.md) has the details.

- **"For you".** Some findings are never handed to an agent: `mcp/literal-secret`, because the
  credential needs rotating; `risk/hidden-unicode` and `risk/hidden-comment`, because the hidden
  content is the payload; every rule of the `mcp`, `hooks`, `settings` and `risk` families and
  `skill/shell-preprocessing`; and every finding in a JSON file or a file of unknown kind, where
  MCP servers, hooks, permissions and env overrides live. The prompt lists them by file, line,
  rule and title, never by message, and keeps their ready fixes out of step 0.
- **`skill install`, a second entry point to the writer.** `agentcheckup skill install` copies
  the agentcheckup skill into `.claude/skills` or `.agents/skills` through
  `src/io/write-fix.ts`, which stays the only code that writes to the scanned repository: inside
  the repository, creates only, never through a symlink, all files or none. It pins the skill's
  commands to the running version, scans the result in memory with every rule and refuses on any
  finding, refuses when the skill exists in either directory, asks first unless `--yes` is
  given, and refuses `--untrusted`. The skill's `allowed-tools` pre-approve only exact read-only
  commands; writing is never pre-approved, so the agent's permission prompt keeps the user in
  the loop. [The agentcheckup skill](../skill.md) describes both.
- **Suggestions.** `fix --untrusted --format suggestions --diff <file>` runs one round of safe
  fixes on a pull request's head and prints review comments whose suggested changes apply them.
  Only changes inside one hunk of the diff are suggested. Review fixes, fixes that need words,
  `mcp/literal-secret`, creates, renames, encoding changes, files with CRLF or a byte order mark,
  and lines with hidden characters or credentials are counted as skipped. The diff is untrusted
  input: at most 16 MiB, parsed in one linear pass. The command writes nothing to the
  repository; the GitHub Action posts the comments.
- **No MCP server mode for now.** Every agent agentcheckup targets has a shell, so the skill and
  the JSON output of the CLI give the same capability without a resident tool surface. A
  `fix_apply` tool would turn a permission prompt per command into tool-level approval that users
  grant once for every call; tool results carry repository text into the model's context, where
  they are trusted more than shell output; and agentcheckup's own gate would flag the added
  server. A server would also cost spec revisions, capability negotiation and an SDK dependency
  tree. We revisit this for clients without a shell. A first version would then be a hand-written
  stdio JSON-RPC server with the root fixed at start, no path arguments, read-only tools (scan,
  context, a fix dry run, tasks) marked `readOnlyHint: true` and `openWorldHint: false`, capped
  and sanitized output with `structuredContent`, and no tool that writes.

## Consequences

- Most findings now have a next step. Of the 3,475 corpus findings, 148 have a safe fix, 1,528 a
  fix for review, 811 a fix that needs the user's words and 925 are tasks for an agent. The other
  63 have no fix and stay with the user, as "For you" findings.
  `corpus/SUMMARY.md` keeps the counts current.
- agentcheckup checks the shape of an answer and what the rules say about the result, not
  whether the words are true. A "Use when ..." sentence that passes can still describe the skill
  badly.
- A split skill loads less at session start, but an agent sees a moved section only when it
  follows the link. The fix prints the line and token counts before and after, and stays
  `review`.
- The risk guard can refuse a fix that would have been correct, such as one that rewrites a
  line holding hidden characters. The finding then stays, with its manual step.
- A task prompt still puts repository text in front of an agent with write access. The rules
  above narrow what a hostile repository can do, but cannot stop an agent from following text it
  was told is data. `tasks --check` proves that the finding is gone and no guard rule fires, not
  that the change is right; the user reviews the diff, as with any agent's work.
- Installing the skill adds `allowed-tools`, which the `permissions` gate flags in the pull
  request. That is intended: a person approves the rules once.
- Clients without a shell cannot use agentcheckup through the skill until an MCP server exists.
