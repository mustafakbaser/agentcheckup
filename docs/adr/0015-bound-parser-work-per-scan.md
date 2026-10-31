# 0015. Bound parser work per scan

- Status: Accepted
- Date: 2026-10-30
- Amends: [0003](0003-treat-scanned-repositories-as-hostile.md), whose scan-wide Markdown budget
  counted characters and lines only, and whose claim that a crafted 64 MiB repository finishes
  in under 8 seconds did not hold

## Context

[ADR 0003](0003-treat-scanned-repositories-as-hostile.md) bounds parsing per file and per scan.
A performance audit on 2026-10-30 found crafted inputs that the per-scan bounds did not cover.
CPU time of the CLI, measured on an Apple silicon laptop:

- **Markdown.** The cost guard (src/parse/markdown-guard.ts) estimates parser work in three
  units, inline delimiters, container churn and lazy continuation lines, and keeps each file
  under a budget worth up to about a second of parsing. The scan-wide budget counted characters
  and lines, which such files hardly spend: 320 files of 8 KB of `*a_` delimiters took 66 s, and
  320 files of 1,870 `- - x` lines (3.5 MB) took 83 s and 2 GB of memory.
- **YAML frontmatter.** yaml's check of repeated keys compares each key of a mapping with every
  earlier one. A flow mapping of 16,000 keys fits in the 64 KiB frontmatter limit and took 0.9 s
  instead of 0.03 s, and a scan parses a skill's frontmatter several times: 40 such skills with
  one repeated key took 143 s.
- **JSON fixes.** Every JSON fix parses the whole edited file again to check itself, and rules
  built a fix for every finding, also those past the 100 a rule lists per file: `fix` on a
  repository with 1,000 MCP servers and 1,000 hooks took 1,487 s.

On the 80 corpus repositories, the most a scan spends is 623,202 inline units
(davila7/claude-code-templates), 3,188,563 container units and 41,999 lazy-line units
(ruvnet/ruflo); no corpus file reaches a per-file guard. No frontmatter mapping in the corpus has
more than 18 keys, and no file more than 30 JSON fixes.

## Decision

- **A scan-wide budget of Markdown parser work**, in the guard's three units: twice what the
  most expensive corpus repository spends, rounded up (1,250,000 inline, 6,400,000 container and
  84,000 lazy-line units, `SCAN_MARKDOWN_COST_BUDGET`). A file gets the whole per-file budget
  while some of a unit is left, so a scan overspends by at most one file. Once a unit is spent,
  later files are parsed without what costs in it: inline delimiters are defused in paragraphs
  that have a cost, and lists, block quotes and setext headings are not parsed where they have
  one, which leaves parsing linear in the text. `analysis/partial` reports those files, as it
  reports files past the character and line budgets. Agent configuration is parsed before the
  files it imports, so it is the last to lose structure. The walk's import pass has a budget of
  its own, the same size.
- **YAML is checked for repeated keys in linear time** (src/parse/frontmatter.ts): parsed
  without yaml's check, searched with a Set, and parsed again with the check only when a key
  repeats. YAML that repeats a key and has a mapping of more than 2,000 keys is not parsed
  again: each key the Set found gets the error yaml's check gives it, at the key, so rules
  report the repeat as they do in smaller frontmatter. `NaN` keys stay out of the Set, as the
  check never finds two of them equal.
- **Rules build JSON fixes only for the findings they list**, at most 100 per rule and file
  ([fix.md](../fix.md#limits)), and a fix checks its result without building the value.

Results are otherwise the same: on the corpus, every command and format gives the same output
byte for byte, and `--check-golden`, `--consistency` and `--fix-replay` are unchanged.

## Consequences

- The crafted inputs above now take 0.8 s (320 files of delimiters), 5 s and 360 MB (320 files
  of nested lists), 2.7 s (40 skills with 16,000 keys and a repeat), and 60 to 110 s (`fix` with
  1,000 MCP servers and 1,000 hooks, which still scans the repository once per fix it verifies
  in that file).
- Parsed Markdown stays in memory until the scan ends, because rules and load plans read the
  trees, and short paragraphs with inline formatting take about 3 KB per line. The character and
  line budgets bound it: 130 different files of 128 KiB of such paragraphs (17 MB) take 19 s of
  CPU time, 12 s on the clock, and 1.7 GB of memory, down from 24 s and 2.1 GB. That is the
  costliest crafted scan we know of: a crafted 64 MiB repository finishes in seconds, but not in
  under 8 s, and needs more than 1 GB of memory.
- A repository whose own files need more parser work than the budget, far beyond the corpus,
  sees `analysis/partial` on its later files instead of a slow scan.
