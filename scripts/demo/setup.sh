#!/bin/sh
# Creates the demo repository that scripts/demo/demo.tape records, and prints its path.
#
#   scripts/demo/setup.sh          # in a new temporary directory
#   scripts/demo/setup.sh <dir>    # in <dir>, which must not exist
#
# The files are the same on every run, so every recording shows the same output:
# - AGENTS.md and a CLAUDE.md that does not import it: Claude Code skips AGENTS.md
#   (instr/agents-md-ignored-by-claude, a safe fix);
# - a Cursor rule saved as .md: Cursor skips it (cursor/md-file-ignored, a fix for review);
# - an MCP server with a "url" but no "type": Claude Code skips it (mcp/url-without-type, a
#   fix for review, because it lets Claude Code start the server).
set -eu

if [ "$#" -gt 1 ]; then
  echo "usage: $0 [dir]" >&2
  exit 2
fi
if [ "$#" -eq 1 ]; then
  dir=$1
  mkdir -- "$dir"
else
  tmp=${TMPDIR:-/tmp}
  dir=$(mktemp -d "${tmp%/}/agentcheckup-demo.XXXXXX")
fi

mkdir -p -- "$dir/.cursor/rules"

cat >"$dir/AGENTS.md" <<'MD'
# Acme API

Run `pnpm test` before every commit.
MD

cat >"$dir/CLAUDE.md" <<'MD'
# Claude notes

Use the staging database for manual tests.
MD

cat >"$dir/.cursor/rules/style.md" <<'MD'
Prefer named exports in TypeScript files.
MD

cat >"$dir/.mcp.json" <<'JSON'
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp"
    }
  }
}
JSON

printf '%s\n' "$dir"
