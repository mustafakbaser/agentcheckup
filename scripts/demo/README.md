# Demo recording

[demo.tape](demo.tape) is a [VHS](https://github.com/charmbracelet/vhs) script that records
`docs/assets/demo.gif`: about 20 seconds in a terminal of about 80 columns by 24 rows.

1. `npx agentcheckup context --matrix`: what each agent loads.
2. `npx agentcheckup fix`: the dry run, which changes nothing.
3. `npx agentcheckup fix --write`: the safe fix, written.

The commands run on a small repository that [setup.sh](setup.sh) creates in a new temporary
directory. The files are the same on every run:

| File                                                     | What the recording shows                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`, and a `CLAUDE.md` that does not import it   | Claude Code skips `AGENTS.md`. The safe fix adds `@AGENTS.md` as line 1 of `CLAUDE.md`, and `fix --write` applies it.                           |
| `.cursor/rules/style.md`                                 | Cursor skips it, because only `.mdc` files are rules there. The fix renames it to `style.mdc` and adds `alwaysApply: true`, so it needs review. |
| `.mcp.json` with a server that has a `url` but no `type` | Claude Code skips the server. The fix adds `"type": "http"`, which lets Claude Code start it, so it needs review.                               |

## Render the GIF

VHS needs `ttyd` and `ffmpeg`; its README explains how to install them. The tape runs
`npx agentcheckup`, so render it once the release is on npm. From the repository root:

```sh
npx -y agentcheckup --version   # must print the release; this also fills the npm cache
mkdir -p docs/assets
vhs scripts/demo/demo.tape      # writes docs/assets/demo.gif
```

Before it starts recording, the tape sets a `$ ` prompt, sets `npm_config_yes=true` and
`npm_config_update_notifier=false` so that npx shows no install prompt or update notice, creates
the demo repository, and runs `npx agentcheckup --version` once so that the download is not
recorded. It waits 20 seconds for that, so on a slow network run the first command above before
`vhs`.

## Check the GIF

- The first frame is an empty `$ ` prompt: no npx prompt, npm notice or error.
- `Width`, `Height` and `FontSize` in the tape give about 80 by 24 with VHS's default font. If
  lines of 80 characters or less wrap, raise `Width`.
- `context --matrix` prints the plan of every agent before the matrix, 114 lines in all, so the
  plans scroll past. The last frame shows the end of Cline's plan, the matrix, its key and the
  footer, all within 80 columns.
- `fix` prints 47 lines. The last frame shows the note of the MCP server fix, the safe fix with
  its diff and effects, and `Verified on an in-memory copy: 3 findings resolved, 0 new, 0 left.`
- `fix --write` prints 22 lines, 27 rows at 80 columns because the token summary wraps. The last
  frame shows the diff from its hunk header on, and
  `Applied 1 fix to 1 file. Re-scanned: 1 finding resolved, 0 new, 2 left.`

These line counts come from the build of this commit; another version may print more or fewer.

## Without VHS

```sh
cd "$(scripts/demo/setup.sh)"
npx agentcheckup context --matrix
npx agentcheckup fix
npx agentcheckup fix --write
```

To try a build that is not released, run `pnpm build` and use `node <repository>/dist/cli.js`
instead of `npx agentcheckup`.

## After rendering

Commit `docs/assets/demo.gif`, then add this line to the top-level README as a paragraph of its
own, after the line that starts with "No configuration, no API key":

```markdown
![Terminal recording: agentcheckup context --matrix shows Claude Code skipping AGENTS.md and an MCP server and Cursor skipping a .md rule; fix previews the fixes; fix --write applies only the safe one.](docs/assets/demo.gif)
```
