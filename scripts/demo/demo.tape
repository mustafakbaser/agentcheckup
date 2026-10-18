# Records docs/assets/demo.gif, about 20 seconds: what each agent loads (context --matrix), the
# fix preview (fix) and the safe fixes applied (fix --write), on the repository that
# scripts/demo/setup.sh creates. Run it from the repository root once the release is on npm:
#
#   vhs scripts/demo/demo.tape
#
# See scripts/demo/README.md.

Output docs/assets/demo.gif

Require bash
Require npx

Set Shell "bash"
# About 130 columns by 46 rows: the whole fix preview fits, and no line wraps.
Set FontSize 14
Set Width 1280
Set Height 860
Set Padding 24
Set TypingSpeed 40ms

# Off camera: a plain prompt, no npx install prompt or npm update notice, the demo repository,
# and a first npx run so that the download does not show in the recording.
Hide
Type `export PS1='$ ' npm_config_yes=true npm_config_update_notifier=false`
Enter
Type `cd "$(scripts/demo/setup.sh)" && npx agentcheckup --version >/dev/null && clear`
Enter
Sleep 20s
Show

# What each agent loads: Claude Code skips AGENTS.md and the MCP server, Cursor skips style.md.
Sleep 500ms
Type "npx agentcheckup context --matrix"
Sleep 400ms
Enter
Sleep 6s

Hide
Type "clear"
Enter
Sleep 300ms
Show

# The dry run: two fixes that need review and one safe fix, each verified in memory.
Type "npx agentcheckup fix"
Sleep 400ms
Enter
Sleep 8s

Hide
Type "clear"
Enter
Sleep 300ms
Show

# Only the safe fix is written; the two that need review are left.
Type "npx agentcheckup fix --write"
Sleep 400ms
Enter
Sleep 4s

# What it wrote: the import that makes Claude Code read AGENTS.md.
Type "head -3 CLAUDE.md"
Sleep 300ms
Enter
Sleep 3500ms
