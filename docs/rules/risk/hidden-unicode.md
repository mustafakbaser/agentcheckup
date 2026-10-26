<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `risk/hidden-unicode`

File contains invisible or text-reordering Unicode characters.

|            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity   | `error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Category   | `risk`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Platforms  | Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Devin Local, Cline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Applies to | `agents-md`, `agents-override-md`, `claude-md`, `claude-local-md`, `claude-rule`, `claude-agent`, `claude-command`, `skill`, `cursor-rule`, `cursor-rule-md`, `cursor-legacy-rules`, `copilot-instructions`, `copilot-path-instructions`, `gemini-md`, `windsurf-rule`, `windsurf-legacy-rules`, `cline-rule`, `cline-workflow`, `cursor-agent`, `gemini-agent`, `copilot-agent`, `devin-agent`, `imported-file`, `claude-settings`, `claude-plugin-manifest`, `cursor-hooks`, `cursor-mcp`, `gemini-settings`, `mcp-json`, `codex-hooks`, `copilot-hooks`, `copilot-mcp`, `copilot-settings`, `vscode-mcp`, `devin-config`, `devin-mcp`, `devin-hooks`, `codex-config`, `codex-agent` |
| Fixable    | Yes, `review`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Since      | 2026.10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Why

Unicode tag characters (U+E0000–U+E007F) mirror ASCII but render as nothing: editors, diffs and rendered Markdown do not show them, yet language models read them as text, so a file can carry instructions no reviewer sees ("ASCII smuggling"). Bidirectional controls (U+202A–U+202E, U+2066–U+2069) change the display order of text, so the reviewed text differs from the text the agent reads ("Trojan Source"). Zero-width characters and runs of variation selectors hide data the same way.

Tag characters and bidirectional controls are errors; bidirectional controls are warnings on a line with right-to-left script, where they have legitimate uses. Zero-width characters and variation selector runs are warnings. Not reported: a joiner inside an emoji sequence or a joining script, a zero width space between letters of a script written without spaces, a byte order mark at the start of the file, and subdivision flags such as England (U+1F3F4 followed by tag letters). Files that an instruction file imports with `@path`, such as a `README.md` that `CLAUDE.md` imports, are checked too: the agent loads their text with the file that imports them.

Delete the characters. If they came from copy and paste, retype the affected text.

## Evidence

- [Embrace The Red: ASCII Smuggler, hiding text in Unicode tag characters](https://embracethered.com/blog/posts/2024/hiding-and-finding-text-with-unicode-tags/), verified, checked 2026-10-14
- [Boucher and Anderson, "Trojan Source: Invisible Vulnerabilities" (USENIX Security 2023)](https://arxiv.org/abs/2111.00169), verified, checked 2026-10-14
- [Unicode Technical Standard #39: Security mechanisms](https://www.unicode.org/reports/tr39/), verified, checked 2026-10-14
- [Unicode Technical Standard #51: Unicode Emoji (emoji tag sequences, Annex C)](https://www.unicode.org/reports/tr51/), verified, checked 2026-10-14
- [Paul Butler: Smuggling arbitrary data through an emoji](https://paulbutler.org/2025/smuggling-arbitrary-data-through-an-emoji/), verified, checked 2026-10-14

## Fix

Classes: `review` ([fix classes](../../fix.md#safe-review-and-manual)).

Deletes every run of tag characters and zero-width characters in the file, and every variation selector after a run's first. Bidirectional controls are left to you, because right-to-left text can need them.

Preview the fix with `agentcheckup fix --rule risk/hidden-unicode`.

## Configuration

```json
{
  "rules": {
    "risk/hidden-unicode": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheckup.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheckup-disable-next-line risk/hidden-unicode -- reason -->
```
