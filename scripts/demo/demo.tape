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
# About 80 columns by 24 rows with VHS's default font.
Set FontSize 16
Set Width 900
Set Height 560
Set Padding 20
Set TypingSpeed 45ms

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
Sleep 5s

Hide
Type "clear"
Enter
Sleep 300ms
Show

# The dry run: two fixes that need review and one safe fix, each verified in memory.
Type "npx agentcheckup fix"
Sleep 400ms
Enter
Sleep 5s

Hide
Type "clear"
Enter
Sleep 300ms
Show

# Only the safe fix is written; the two that need review are left.
Type "npx agentcheckup fix --write"
Sleep 400ms
Enter
Sleep 4500ms
