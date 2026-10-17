# Fixing findings

`agentcheckup fix` repairs the findings that have a fix. By default it is a dry run: it prints
the diff of each fix, checked by scanning a fixed copy of the repository in memory, and changes
nothing. `--write` applies the fixes, and `-i` asks about each one first. The design and the
threats it guards against are in [ADR 0008](adr/0008-write-fixes-to-the-scanned-repository.md).

```sh
npx agentcheckup fix                                # preview every fix; changes nothing
npx agentcheckup fix --write                        # apply the safe fixes
npx agentcheckup fix --write --review               # also apply the fixes that need review
npx agentcheckup fix -i                             # ask about each fix
npx agentcheckup fix --rule cursor/md-file-ignored  # only this rule's fixes
npx agentcheckup fix --untrusted --format json --output fixes.json
```

The examples on this page come from a small repository with an `AGENTS.md`, a `CLAUDE.md` that
imports a missing `docs/setup.md`, a Cursor rule saved as `.cursor/rules/style.md`, an MCP
server with a `url` but no `type`, and a skill without a description.

## Options

| Option                                 | Meaning                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `[path]`                               | The repository root. Default: the current directory.                                                                                |
| `--write`                              | Apply the safe fixes, then walk and scan the repository again from disk.                                                            |
| `--review`                             | With `--write`: also apply the fixes that need review. Without `--write` it is a usage error, because a dry run already shows them. |
| `-i`, `--interactive`                  | Ask about each fix, then apply the accepted ones. See [Interactive mode](#interactive-mode).                                        |
| `--rule <ids>`                         | Comma-separated rule ids: fix only these rules. An unknown id is a usage error.                                                     |
| `-t`, `--targets <list>`               | The agents to check against, as for a scan.                                                                                         |
| `-f`, `--format <name>`                | `diff` (default), [`json`](#json-output), or [`suggestions`](#pull-request-suggestions) with `--diff <file>`.                       |
| `-o`, `--output <file>`                | Write the diff or JSON to a file instead of stdout.                                                                                 |
| `-c`, `--config <file>`, `--no-config` | As for a scan.                                                                                                                      |
| `--untrusted`                          | As for a scan, and a dry run only. See [Untrusted repositories](#untrusted-repositories).                                           |
| `--color`, `--no-color`                | Force or disable color.                                                                                                             |

`fix` does not take `--baseline`, `--gate`, `--context-window` or `--no-gitignore`. It reads the
files a scan reads by default.

A suppressed finding is never fixed, and a rule set to `"off"` reports nothing to fix. To keep
agentcheckup from applying one fix, suppress its finding with a reason
([Inline suppressions](configuration.md#inline-suppressions)).

## Safe, review and manual

What agentcheckup can do about a finding falls into one of three classes. A scan shows the class
on each finding's `fix` line, and `context` shows it on each skip it can remove.

**Safe.** The fix is deterministic, has one correct form, keeps the author's text, passes a new
scan with no new error or warning, and adds or changes nothing a `--gate` class flags.
`fix --write` applies safe fixes. Examples:

- `instr/agents-md-ignored-by-claude`: adds `@AGENTS.md` as line 1 of the `CLAUDE.md` in the same
  directory.
- `skill/frontmatter-bom`: saves `SKILL.md` without its byte order mark.
- `json/duplicate-key`: deletes the earlier copy of a key, which `JSON.parse` ignores anyway.
- `directive/unused`: removes a suppression comment that no longer suppresses anything.

**Review.** Every other fix agentcheckup can write. The dry run shows them with the safe fixes;
`fix --write --review` applies them, and `fix -i` asks about each one. Examples:

- `cursor/md-file-ignored`: renames `style.md` to `style.mdc` and adds `alwaysApply: true`, which
  puts the rule in every Cursor conversation.
- `mcp/url-without-type`: adds `"type": "sse"`, which lets Claude Code start the server.
- `skill/description-missing`: copies the first line of the body into `description`, for you to
  reword.
- `hooks/timeout-units`: rewrites a hook timeout in the unit the agent reads.

**Manual.** The finding has no fix. Its `how` line in a scan, and its `manual` line in the dry
run, say what to do:

```text
manual  instr/import-unresolved  CLAUDE.md:5  create "docs/setup.md" or correct the path; no file named "setup.md" exists
```

One rule can produce fixes of both classes. `cursor/md-file-ignored` only renames the file, a
safe fix, when its frontmatter already sets `description`, `globs` or `alwaysApply`; otherwise
it has to choose the frontmatter, so the fix needs review.

A fix that adds or changes an MCP server, a hook, a permission, an env override or hidden
Unicode is always `review`: these are the changes the `--gate` classes flag in a pull request.
Verification checks this for every fix. A `safe` fix with such an effect is treated as
`review`, and `--write` alone leaves it out with this line:

```text
1 fix needs review: it adds or changes an MCP server, hook, permission or env override. Apply with "agentcheckup fix -i" or "agentcheckup fix --write --review".
```

## Rounds and verification

Fixes are applied to a copy of the repository in memory and checked there before anything is
written:

1. **Plan.** agentcheckup takes the unsuppressed findings with a fix of the selected classes and
   rules. Findings that carry the same fix share it.
2. **Check each fix alone.** It applies the fix to the copy and scans it again, with the load
   plans. The fix passes when every finding it fixes is gone and no error, warning or rule crash
   is new. Findings are matched by rule and file, following renames, because an edit changes
   their fingerprints. A fix that fails is dropped, and the round is planned again without it.
   Its finding stays, listed as a manual step when the rule names one. To stay fast with
   hundreds of fixes, fixes in different files are applied together and scanned once, and each
   is judged by the findings, load-plan entries and inventory items of its own files, as its own
   scan would judge it. When something changes in another file, or a fix fails, the fixes
   concerned are scanned alone.
3. **Check them together.** It applies the passing fixes at once and checks again. When they
   fail together, it adds them one at a time and keeps each one that still passes.
4. **Repeat.** It runs up to 3 rounds. Each round starts from the files as the last one left
   them, so a fix that had to wait gets its turn.

Two fixes conflict when their edits overlap or insert at the same place, when both create or
move a file to the same path (letter case aside), or when one renames a file the other changes.
Identical edits do not conflict. The winner goes first: safe before review, then the higher
severity, then the lower rule id, then the earlier position in the file. The other fix waits for
the next round. Here the rename of a Cursor rule (an error) wins over the removal of a zero-width
space (a warning) in the same file, which then applies to the renamed file. The diff shows both
changes together:

```text
$ npx agentcheckup fix
review  cursor/md-file-ignored  Rename .cursor/rules/style.md to style.mdc and add "alwaysApply: true"
rename from .cursor/rules/style.md
rename to .cursor/rules/style.mdc
--- a/.cursor/rules/style.md
+++ b/.cursor/rules/style.mdc
@@ -1 +1,4 @@
-Always use TypeScript<U+200B> strict mode.
+---
+alwaysApply: true
+---
+Always use TypeScript strict mode.
…
review  risk/hidden-unicode  Delete 1 run of invisible characters
  .cursor/rules/style.mdc: see the diff above
…
Verified on an in-memory copy: 2 findings resolved, 0 new, 0 left.
```

When the rounds run out, a fix that is still waiting is listed as
`skipped: it overlaps a fix that goes first; run agentcheckup fix again`.

The last line compares the fixed copy with the repository: findings **resolved**, findings that
are **new**, and findings **left**. A fix may add a finding at `info` severity, which is advice
and never affects the score. Such a finding does not stop the fix; it is listed as **new info**:

```text
Verified on an in-memory copy: 4 findings resolved, 2 new, 1 left.
  new info  .agents/skills/deploy/SKILL.md:3  skill/description-quality  The description has only 5 words, too few for agents to match requests against. Say what the skill does and when to use it.
  new info  .mcp.json:3  mcp/insecure-transport  MCP server "docs" uses the SSE transport, which Claude Code has deprecated. Use "type": "http" if the server supports Streamable HTTP.
```

A new error or warning always stops the fix, even one that another fix could remove. For
example, moving a skill's frontmatter to line 1 makes its `name: Deploy` visible to the name
rules. That raises a new error, so the dry run shows
`skipped: a re-scan showed it does not resolve its finding or adds a problem` and lists the
finding as a manual step.

`--write` and `-i` then write the checked fixes, walk the repository again and scan it from
disk:

```text
Applied 4 fixes to 4 files. Re-scanned: 4 findings resolved, 2 new, 1 left.
```

If the scan from disk still finds what a written fix fixed, the run says so
(`Written, but the scan from disk still finds what it fixes`) and exits 1. Running the same
command again changes nothing.

## Effects

Each fix lists what it changes for the agents, found by comparing the scans before and after
the fix:

```text
  effect: Claude Code session start ≈16 → ≈101 tokens
  effect: Changed MCP server docs (sse, https://mcp.example.com) (gate class mcp)
  note: GitHub Copilot CLI also reads CLAUDE.md, so it may load AGENTS.md twice after this change (not verified).
```

- **Tokens:** the estimated session-start context of Claude Code, Codex and Cursor in the
  repository root, before and after, as `context` computes it (characters ÷ 4).
- **Gate:** an MCP server, hook, permission, env override or hidden Unicode that the fix adds or
  changes, with the [gate class](context.md#gate-classes) that would flag it in a pull request.
  A fix with a gate effect is always `review`.
- **Notes:** what the rule knows about the change, such as an unverified side effect, or a
  reminder to reword copied text.

After `--write`, the summary adds up the token changes per agent and lists the gate effects:

```text
  Claude Code ≈16 → ≈101 tokens at session start · Codex ≈82 → ≈102 tokens at session start · Cursor ≈99 → ≈125 tokens at session start
  Changed MCP server docs (sse, https://mcp.example.com) (gate class mcp)
```

## Interactive mode

`fix -i` prints each checked fix with its diff, effects and notes, then asks:

```text
(4/4) Apply? [y]es [n]o [d]iff [q]uit (Enter: yes)
```

- Enter means yes for a safe fix and no for a fix that needs review.
- `d` shows the diff again.
- When the rule has other ways to fix the finding, the prompt adds `[a]lternatives`, and `a`
  lists them. `cursor/legacy-cursorrules` can rename `.cursorrules` to `AGENTS.md` instead of
  moving it into `.cursor/rules/`, and `skill/yaml-portability` can write a YAML 1.1 boolean as
  `true` or `false` instead of quoting it.
- `q` stops asking. The fixes you accepted so far are applied.
- When input ends or you press Ctrl-C, nothing is written: `Stopped: no files were changed.`

`-i` offers fixes of both classes, and the fix for `mcp/literal-secret`. After the last answer,
agentcheckup plans again with only the accepted fixes, checks them and writes them, as `--write`
does. A fix that only a declined fix made possible is not applied. The fixes of
`directive/unused` and `directive/unknown-rule` apply all or none: when you decline one, the
others of that rule stay as they are too.

The `Left:` list at the end comes from the scan of the files as written. It names the findings
of the fixes you declined, with the fix's title when the rule gives no manual step, and the
manual steps of the findings still there. A step that only a fix you did not apply would bring
up is not listed. Here the `mcp/url-without-type` fix was declined:

```text
Left: .mcp.json:3 mcp/url-without-type (Add "type": "sse" to MCP server "docs")
      CLAUDE.md:5 instr/import-unresolved (create "docs/setup.md" or correct the path; no file named "setup.md" exists)
```

`-i` needs a terminal on stdin and stdout and exits 2 without one. With `--format json` it
needs `--output`, because the questions go to stdout.

## Credentials

A fix for [`mcp/literal-secret`](rules/mcp/literal-secret.md) replaces only the token with a
reference to an environment variable, in the syntax of the agent that reads the file. It is
applied only when you ask for it: name the rule with `--rule mcp/literal-secret`, or accept the
fix in `-i`. A plain `fix`, `fix --write --review` and the pull request formats (`markdown`,
`github` and `sarif`) never offer it.

Revoke and rotate the credential first. The fix removes it from the file, but not from git
history, and anyone who could read the file could copy it. agentcheckup prints that warning
before and after the fix, and never shows the token:

```text
$ npx agentcheckup fix --rule mcp/literal-secret
!! Revoke and rotate this credential now. Editing the file does not remove it from git history.
review  mcp/literal-secret  Replace the literal GitHub personal access token with ${GITHUB_PERSONAL_ACCESS_TOKEN}
…
-      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_…(40 chars)" }
+      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}" }
…
  note: Set GITHUB_PERSONAL_ACCESS_TOKEN in the environment of everyone who uses this configuration.
…
!! Revoke and rotate this credential now. Editing the file does not remove it from git history.
```

## Untrusted repositories

`fix --untrusted` previews the fixes for code you do not trust, such as a pull request from a
fork. As in a scan, it ignores the repository's configuration file and inline suppressions, and
reads agent configuration that `.gitignore` excludes
([Scanning untrusted repositories](configuration.md#scanning-untrusted-repositories)). It allows
only a dry run: combined with `--write` or `-i`, it exits 2.

```sh
npx agentcheckup fix --untrusted --format json --output fixes.json
```

## What `fix` never does

- **Delete a file.** A fix can remove text inside a file, such as a duplicate JSON key, but never
  a whole file.
- **Rename a directory.** A skill whose `name` does not match its directory gets a new `name`;
  the directory keeps its name.
- **Rename a file when only the letter case changes,** such as `Claude.md` to `CLAUDE.md`. The
  manual step says what to rename, for example with `git mv`.
- **Run git or anything else.** No git, hooks, formatters, package managers or editors. Commands
  such as `git mv`, `git rm --cached` or `git config core.symlinks true` are printed for you to
  run.
- **Write through a symlink or a hard link.** A file the scan reached through a symlink is never
  edited; the manual step names the file to edit. A file with more than one hard link, a
  symlinked parent directory and anything that is not a regular file are refused.
- **Write inside `.git`,** in any spelling that Git or the file system treats as `.git`.
- **Overwrite a file by creating or renaming one.** A create or a rename fails when the target
  exists.
- **Write a file that changed since the scan.** Just before writing, the file's SHA-256 must
  match the bytes the scan read; otherwise the fix is skipped as "the file changed since the
  scan".
- **Edit a file it cannot read back exactly.** A file with decoding errors, or whose bytes do not
  survive decoding and encoding unchanged, is never edited. Edits keep the file's encoding, byte
  order mark, line endings and final newline.

Each file is written to a temporary file in the same directory and then moved into place, so a
file is never left half written. When one step of a fix that changes several files fails, its
earlier steps are undone.

## Limits

- At most 3 rounds per run.
- At most 1,000 fixes per run.
- At most 1 MiB per written file.

A fix past a limit is listed as `skipped: past a limit of this run`; run `fix` again for the
rest. Text copied from the repository, such as a skill description, is one line of at most 200
characters. Where the file system does not support hard links (FAT and some network drives),
fixes that create or rename a file are refused.

## Exit codes

| Code | When                                                                                                                                                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | A dry run has nothing to change, or every selected fix was applied and verified on disk. A fix you declined in `-i` does not count                                                                                                                               |
| 1    | A dry run would change a file; a selected fix was not applied (a conflict, a file that changed since the scan, a refused path, a failed check, a limit, a failed write); the scan from disk still finds what a written fix fixed; or `-i` stopped before writing |
| 2    | Invalid arguments or configuration: an unknown `--rule`, `--review` without `--write`, `--untrusted` with `--write` or `-i`, `-i` without a terminal, or `-i --format json` without `--output`                                                                   |
| 3    | Internal error: a rule or the scanner crashed. With `--write` or `-i`, nothing is written when a rule crashed                                                                                                                                                    |

## JSON output

`fix --format json` writes one object that follows
[schemas/fix.schema.json](../schemas/fix.schema.json):

| Field          | What it holds                                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`         | `dry-run`, `write` (`--write`) or `interactive` (`-i`)                                                                                                                                                           |
| `pathBase`     | The prefix added to every path when the scanned directory is not the current directory                                                                                                                           |
| `fixes[]`      | `id` (`<rule id>#<variant>`), `ruleId`, `class`, `title`, `effects[]`, `findings[]` (the fingerprints of the findings it fixes), `notes[]`, `warning`, `status` (`planned`, `applied` or `skipped`) and `reason` |
| `files[]`      | `path`, `op` (`edit`, `create` or `rename`), `from` for a rename, `before` and `after` (`sha256`, `encoding`, `bom`, `lineEnding`), and `hunks[]` of the unified diff                                            |
| `manual[]`     | `ruleId`, `path`, `line` and `guidance` for each finding left to you                                                                                                                                             |
| `verification` | `resolved`, `remaining`, and `introduced[]` with each new finding                                                                                                                                                |

A skipped fix's `reason` is one of `conflict`, `changed-since-scan`, `refused-path`,
`verification-failed`, `limit`, `write-failed` or `declined`. The fingerprints in `findings[]` are
those of the scan's JSON report. Paths are never absolute, and credentials are redacted in the
hunks as in the diff.

## Pull request suggestions

`fix --untrusted --format suggestions --diff <file>` turns the safe fixes of a pull request into
review comments with suggested changes, for the GitHub Action to post. `[path]` is the pull
request's head and `<file>` its unified diff, with paths relative to `[path]`: the output of
`gh pr diff`, or of the API with `Accept: application/vnd.github.diff`. The diff is read like any
untrusted input, at most 16 MiB.

```sh
gh pr diff 42 > pr.diff
npx agentcheckup fix --untrusted --format suggestions --diff pr.diff --output suggestions.json
```

The JSON follows [schemas/suggestions.schema.json](../schemas/suggestions.schema.json):
`comments[]` in the shape the API that creates a review takes, and `skipped[]`, a count per
reason. One round of safe fixes runs and is verified as in a dry run; fixes that need review and
those of `mcp/literal-secret` are never suggested.

- Each block of changed lines is one comment, made only when all its lines lie in one hunk of the
  diff. A removed line gets an empty suggestion. An inserted line has no line of its own: the
  comment anchors on the line before it and repeats that line above the new ones, or, before line
  1, anchors on line 1 and repeats it below them.
- The body is the suggestion, the rule's fix summary and a last line
  `<!-- agentcheckup-suggestion <rule ids> <hash> -->`, where the hash is 12 hex digits of the
  SHA-256 of the path, the lines and the suggested text, so the Action can skip a comment it
  already posted.
- The suggested lines are the exact new text. A change whose lines hold a control, bidirectional,
  tag or other invisible character (`hidden-characters`) or a credential (`credential`) is not
  suggested, nor one outside the diff (`outside-diff`). Neither is a fix that creates or renames a
  file, changes an encoding, or touches a UTF-16 file, a file with a byte order mark or one with
  CRLF line endings, because a suggestion cannot keep them. At most 50 comments are made.

````json
{
  "path": ".github/instructions/ts.instructions.md",
  "line": 4,
  "start_line": 2,
  "side": "RIGHT",
  "start_side": "RIGHT",
  "body": "```suggestion\napplyTo: \"**/*.ts,**/*.tsx\"\n```\n\n**agentcheckup** safe fix for [`copilot/apply-to`](…): Joins an &quot;applyTo&quot; YAML list into one comma\\-separated string\\.\n\n<!-- agentcheckup-suggestion copilot/apply-to 74151d191441 -->"
}
````

The command exits 0 whatever it suggests, 2 for invalid arguments (`--format suggestions`
without `--diff` or `--untrusted`, or with `--write` or `-i`) or a diff it cannot read, and 3 when
a rule crashed, without output.

## Rules with fixes

This table lists each rule's fix classes and what its fix does, as `agentcheckup explain <rule-id>`
prints them. The page of each rule in the [rule catalog](rules/README.md) has the same in its Fix
section.

<!-- Start of the fixable rules, generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

39 of the 62 rules can attach a fix. The others give a manual step where they can name one.

| Rule                                                                              | Classes          | What the fix does                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`copilot/apply-to`](rules/copilot/apply-to.md)                                   | `safe`           | Joins an "applyTo" YAML list into one comma-separated string.                                                                                                                                                                                                                                                            |
| [`copilot/instructions-misplaced`](rules/copilot/instructions-misplaced.md)       | `review`         | Moves a file found elsewhere in a .github folder to .github/copilot-instructions.md or into .github/instructions/. A letter-case difference, a .github folder in a subdirectory and an existing target are left to the user, with the commands to run.                                                                   |
| [`cursor/legacy-cursorrules`](rules/cursor/legacy-cursorrules.md)                 | `review`         | Moves the file to .cursor/rules/cursorrules.mdc with "alwaysApply: true", as Cursor's migration steps do. `fix -i` also offers renaming it to AGENTS.md when the directory has none.                                                                                                                                     |
| [`cursor/md-file-ignored`](rules/cursor/md-file-ignored.md)                       | `safe`, `review` | Renames the file to .mdc. Safe when its frontmatter already sets description, globs or alwaysApply; otherwise for review, adding "alwaysApply: true" or renaming "paths" or "applyTo" to "globs".                                                                                                                        |
| [`cursor/rule-frontmatter`](rules/cursor/rule-frontmatter.md)                     | `safe`, `review` | Safe: writes alwaysApply: "true" as the boolean true and joins a globs list into one comma-separated string. For review: renames "paths" or "applyTo" to "globs".                                                                                                                                                        |
| [`directive/unknown-rule`](rules/directive/unknown-rule.md)                       | `review`         | Replaces the id with the only rule id within two edits of it, which makes the directive suppress that rule.                                                                                                                                                                                                              |
| [`directive/unused`](rules/directive/unused.md)                                   | `safe`           | Removes the directive, and its line when nothing else is on it, when every rule it names checked the file in this scan.                                                                                                                                                                                                  |
| [`hooks/fails-open`](rules/hooks/fails-open.md)                                   | `review`         | Sets "onFailure": "block" on the Claude Code hook or "failClosed": true on the Cursor hook. Codex and Gemini CLI have no such setting, so their scripts must be changed by hand.                                                                                                                                         |
| [`hooks/timeout-units`](rules/hooks/timeout-units.md)                             | `review`         | Rewrites the number in the unit the agent reads: divided by 1,000 and rounded up for Claude Code, Codex and Cursor, multiplied by 1,000 for Gemini CLI. Only the number changes.                                                                                                                                         |
| [`hooks/unknown-event`](rules/hooks/unknown-event.md)                             | `review`         | Renames the key to the event the message names: the same name in the right case, or the event within two edits of it. Always a review fix, because the hooks under it start to run. Not offered when the file already has that event.                                                                                    |
| [`instr/agents-md-ignored-by-claude`](rules/instr/agents-md-ignored-by-claude.md) | `safe`, `review` | Adds "@AGENTS.md" as the first line of the CLAUDE.md in the same directory (safe), or creates a CLAUDE.md with that line when the CLAUDE file Claude Code reads instead is in a parent directory or is a CLAUDE.local.md (review).                                                                                       |
| [`instr/claude-rule-frontmatter`](rules/instr/claude-rule-frontmatter.md)         | `review`         | Renames "globs" or "applyTo" to "paths", turning a comma-separated string into a list, and escapes an unclosed "[" as "\\[". Invalid YAML is left to you.                                                                                                                                                                |
| [`instr/encoding`](rules/instr/encoding.md)                                       | `safe`           | Converts a UTF-16 file that decodes without errors to UTF-8 without a byte order mark, keeping its text and line endings. Invalid UTF-8 is left to you.                                                                                                                                                                  |
| [`instr/import-unresolved`](rules/instr/import-unresolved.md)                     | `review`         | Points the import at the only file in the repository with the name it asks for. Without exactly one such file, the path is left to you.                                                                                                                                                                                  |
| [`instr/subagent-invalid`](rules/instr/subagent-invalid.md)                       | `safe`           | Deletes the blank lines before the frontmatter. Missing fields, names and YAML errors are left to you.                                                                                                                                                                                                                   |
| [`instr/symlink-materialized`](rules/instr/symlink-materialized.md)               | `review`         | Replaces the path in a CLAUDE.md or GEMINI.md with an import of the file it links to; other files need symlinks enabled in Git.                                                                                                                                                                                          |
| [`json/duplicate-key`](rules/json/duplicate-key.md)                               | `safe`           | Deletes the earlier key and its value, which JSON.parse ignores, so the configuration agents read does not change. Not offered when the deletion would remove a comment.                                                                                                                                                 |
| [`json/invalid-syntax`](rules/json/invalid-syntax.md)                             | `review`         | Deletes the trailing commas and comments (in Gemini CLI settings, which allow comments, only the trailing commas) when they are the only syntax errors. Other syntax errors are left to you.                                                                                                                             |
| [`mcp/env-syntax-mismatch`](rules/mcp/env-syntax-mismatch.md)                     | `review`         | Rewrites every reference in the string in the syntax of the agent that reads the file: "${NAME}" for Claude Code, "$NAME" for Gemini CLI. Not offered for Cursor built-ins such as "${workspaceFolder}", which the other agents do not have, or for a file that other paths link to.                                     |
| [`mcp/gemini-server-name`](rules/mcp/gemini-server-name.md)                       | `review`         | Renames the server, replacing each "_" with "-". Not offered when another server has that name or "mcp.allowed" or "mcp.excluded" names the server.                                                                                                                                                                      |
| [`mcp/gemini-trust`](rules/mcp/gemini-trust.md)                                   | `review`         | Removes "trust" from the server, so Gemini CLI asks before each tool call again.                                                                                                                                                                                                                                         |
| [`mcp/insecure-transport`](rules/mcp/insecure-transport.md)                       | `review`         | Changes http:// to https:// and ws:// to wss:// in the server URL. Moving off the deprecated SSE transport is left to you.                                                                                                                                                                                               |
| [`mcp/literal-secret`](rules/mcp/literal-secret.md)                               | `review`         | Replaces only the token with a variable reference in the syntax of the agent that reads the file: "${NAME}" in .mcp.json and plugin servers, "${env:NAME}" in .cursor/mcp.json, "$NAME" in .gemini/settings.json. Applied only when you name the rule or accept the fix, always with a warning to rotate the credential. |
| [`mcp/url-without-type`](rules/mcp/url-without-type.md)                           | `review`         | Adds "type" as the first property of the server: "ws" for ws:// and wss:// URLs, "sse" when the path ends in /sse, otherwise "http". Always a review fix, because it lets Claude Code start the server.                                                                                                                  |
| [`risk/hidden-unicode`](rules/risk/hidden-unicode.md)                             | `review`         | Deletes every run of tag characters and zero-width characters in the file, and every variation selector after a run's first. Bidirectional controls are left to you, because right-to-left text can need them.                                                                                                           |
| [`settings/auto-approve-project-mcp`](rules/settings/auto-approve-project-mcp.md) | `review`         | Replaces "enableAllProjectMcpServers": true with "enabledMcpjsonServers" listing the servers the project's .mcp.json declares today, so later additions need approval. Not offered when the file already has such a list or .mcp.json cannot be read.                                                                    |
| [`settings/ignored-permission-mode`](rules/settings/ignored-permission-mode.md)   | `review`         | Removes "defaultMode" from the project or local settings. A review fix: Claude Code before v2.1.257 applied "bypassPermissions" from these files.                                                                                                                                                                        |
| [`settings/plugin-manifest`](rules/settings/plugin-manifest.md)                   | `safe`, `review` | Adds the missing "./" in front of a component path that exists (a review fix when the plugin declares hooks or servers, which then load), and renames a plugin whose name is not kebab-case (review). Other problems are left to you.                                                                                    |
| [`skill/broad-allowed-tools`](rules/skill/broad-allowed-tools.md)                 | `review`         | Replaces `Bash` with rules for the commands in the skill's shell code blocks, such as `Bash(git status *)`, and removes bare `Write`, `Edit`, `PowerShell`, `shell` and `bash`. Keeps a string or a list as it is. Offered only when it finds a command; each new rule is listed with its source line.                   |
| [`skill/broken-reference`](rules/skill/broken-reference.md)                       | `safe`, `review` | Replaces backslashes in a link with `/` (safe), or writes the link in the letter case of the only file it matches (review). Other broken links are left to you.                                                                                                                                                          |
| [`skill/description-missing`](rules/skill/description-missing.md)                 | `review`         | Copies the first line of the body, which Claude Code uses when `description` is omitted, into `description` for you to reword. A value that is not text is left to you.                                                                                                                                                  |
| [`skill/field-type`](rules/skill/field-type.md)                                   | `review`         | Writes an `allowed-tools` list as a space-separated string when no tool rule contains a space. Other types are left to you.                                                                                                                                                                                              |
| [`skill/frontmatter-bom`](rules/skill/frontmatter-bom.md)                         | `safe`           | Saves SKILL.md as UTF-8 without the byte order mark.                                                                                                                                                                                                                                                                     |
| [`skill/frontmatter-missing`](rules/skill/frontmatter-missing.md)                 | `safe`, `review` | Moves the frontmatter to line 1 and removes the indentation of its delimiters (safe), or adds frontmatter with the directory name and the first body line as the description (review). An unclosed block is left to you.                                                                                                 |
| [`skill/name-dir-mismatch`](rules/skill/name-dir-mismatch.md)                     | `safe`, `review` | Sets `name` to the directory name: safe when that is the name in lowercase with hyphens, review otherwise. Directories are never renamed.                                                                                                                                                                                |
| [`skill/name-format`](rules/skill/name-format.md)                                 | `safe`, `review` | Sets `name` to the directory name: safe when that is the name in lowercase with hyphens, review otherwise. A non-ASCII name or an invalid directory name is left to you.                                                                                                                                                 |
| [`skill/name-missing`](rules/skill/name-missing.md)                               | `safe`           | Sets `name` to the directory name when that is a valid skill name.                                                                                                                                                                                                                                                       |
| [`skill/non-portable-field`](rules/skill/non-portable-field.md)                   | `review`         | Moves keys that no agent documents under `metadata`, as quoted text, in a skill uploaded or installed on its own. `fix -i` can instead record why the fields stay, as a suppression with your reason, or remove agent-specific fields that do not restrict the model.                                                    |
| [`skill/yaml-portability`](rules/skill/yaml-portability.md)                       | `review`         | Puts a value that YAML 1.1 reads as a boolean, or YAML 1.2 as a number, in double quotes. Anchors, aliases, tags and empty values are left to you.                                                                                                                                                                       |

<!-- End of the fixable rules. -->
