# The agentcheckup skill

agentcheckup ships an [Agent Skill](https://agentskills.io/specification) that teaches a coding
agent to run agentcheckup on the repository it works in. When you ask the agent to lint or clean
up its configuration, or why it ignores a file, the skill has it:

1. list the work with `agentcheckup tasks --format json`;
2. preview the fixes with `agentcheckup fix`, and apply the safe ones with `fix --write` after
   asking you;
3. show you the fixes that need review one rule at a time, and apply each rule's with
   `fix --write --review --rule <id>` only when you say yes;
4. work through the [tasks](tasks.md) one by one, checking each with `tasks --check <id>`;
5. run `tasks` again until `tasks --check` exits 0.

It also explains how to read [`agentcheckup context`](context.md) output. The skill is
`skills/agentcheckup/SKILL.md` with three reference files, `fix-classes.md`, `tasks.md` and
`context.md`, which the agent reads only when it needs them.

## Install it

### With agentcheckup

```sh
npx agentcheckup skill install              # asks before it writes
npx agentcheckup skill install --yes        # for scripts
npx agentcheckup skill install --dir agents # into .agents/skills
```

| Option         | Meaning                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[path]`       | The repository root. Default: the current directory.                                                                                                                   |
| `--dir <name>` | `claude` for `.claude/skills` or `agents` for `.agents/skills`. Default: `claude` when the targets in `agentcheckup.config.json` include `claude-code`, else `agents`. |
| `-y`, `--yes`  | Install without asking. Without it, `skill install` needs a terminal and exits 2 without one.                                                                          |

Which agents load skills from each directory:

| Directory        | Loaded by                                                        |
| ---------------- | ---------------------------------------------------------------- |
| `.claude/skills` | Claude Code, Cursor, GitHub Copilot, Devin Local and Cline       |
| `.agents/skills` | Codex, Cursor, GitHub Copilot, Gemini CLI, Devin Local and Cline |

The installer reads the skill from the installed agentcheckup package, sets every
`npx agentcheckup@<version>` in it to the version you are running, and then:

- **Checks before it writes.** It adds the skill to the scanned repository in memory and runs
  every rule on every target. If the skill would add any finding, such as a second skill named
  `agentcheckup` in the same directory, it lists the findings and installs nothing.
- **Creates, never overwrites.** It refuses when `<dir>/agentcheckup` exists. To update the
  skill, remove the directory and install again.
- **Installs once.** It refuses when the skill is already in the other directory: Cursor, GitHub
  Copilot, Devin Local and Cline read both `.claude/skills` and `.agents/skills`, so a second copy
  gives them two skills of the same name ([`skill/duplicate-name`](rules/skill/duplicate-name.md)).
- **Writes like `fix --write`.** It writes only inside the repository, through the same writer
  as [`fix`](fix.md#what-fix-never-does): never through a symlinked directory such as a `.claude`
  that links elsewhere, never into `.git`, and all four files or none.
- **Refuses `--untrusted`.** Install the skill only in a repository you trust.

```text
$ npx agentcheckup skill install
Install the agentcheckup skill in .claude/skills/agentcheckup:
  .claude/skills/agentcheckup/SKILL.md
  .claude/skills/agentcheckup/references/context.md
  .claude/skills/agentcheckup/references/fix-classes.md
  .claude/skills/agentcheckup/references/tasks.md
Claude Code, Cursor, GitHub Copilot, Devin Local and Cline load skills from .claude/skills.
Checked in memory with every rule: the skill adds no finding.
While the skill runs, Claude Code may use these without asking (allowed-tools):
  Bash(npx agentcheckup@0.1.0 tasks --format json)
  Bash(npx agentcheckup@0.1.0 fix)
  Bash(npx agentcheckup@0.1.0 context)
  Bash(npx agentcheckup@0.1.0 tasks --check *)
  Read
Every command that writes asks first.
Install the skill? [y/N] y
Installed the agentcheckup skill in .claude/skills/agentcheckup (4 files).
Its allowed-tools is a new permission: a pull request check with --gate permissions or
--gate security flags it. That is intended: review the tools above and approve it.
Commit .claude/skills/agentcheckup. To update the skill, remove the directory and install again.
```

| Code | When                                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The skill was installed                                                                                                                       |
| 1    | Not installed: the skill directory exists, the skill is in the other directory, it would add a finding, you said no, or the write was refused |
| 2    | Invalid arguments or configuration, `--untrusted`, or no terminal without `--yes`                                                             |
| 3    | Internal error: a rule crashed, or the packaged skill is missing or broken                                                                    |

### With skills.sh

The [skills CLI](https://github.com/vercel-labs/skills) installs the skill straight from this
repository:

```sh
npx skills add mustafakbaser/agentcheckup --skill agentcheckup
```

It copies `skills/agentcheckup` from the default branch, whose commands are pinned to the latest
release. Choose one directory: installing for agents that read different directories, such as
Claude Code (`.claude/skills`) and Codex (`.agents/skills`), puts a copy in each, and Cursor,
GitHub Copilot, Devin Local and Cline then see two skills named `agentcheckup`. agentcheckup does not check a copy
installed this way before it is written; run `npx agentcheckup` afterwards.

## What the skill may run without asking

The skill's `allowed-tools` pre-approves five tools:

```yaml
allowed-tools: >-
  Bash(npx agentcheckup@0.1.0 tasks --format json)
  Bash(npx agentcheckup@0.1.0 fix)
  Bash(npx agentcheckup@0.1.0 context)
  Bash(npx agentcheckup@0.1.0 tasks --check *)
  Read
```

The value is one space-separated string, as the Agent Skills specification defines it, written
over several lines so that release-please can bump the version in each rule.

Each Bash rule is an exact command, except the last, and none of them can write:

- `tasks --format json` lists the tasks. Without `--output` it writes nothing.
- `fix` without `--write` or `-i` is a dry run.
- `context` prints load plans.
- `tasks --check *` allows task ids after `--check`. It is safe only because `--check` takes no
  other option: `--output`, `--format`, `--rule` and every other flag exit 2, so no argument can
  make it write a file.

The commands are pinned to one version, so what runs without asking is the version you
installed and reviewed, not whatever npm resolves later. `context --agent codex`,
`tasks --rule …` and `fix --rule …` are not pre-approved even though they only read: allowing
`context *` or `tasks *` would also allow `--output`, which writes a file.

These are Claude Code permission rules. GitHub Copilot documents `allowed-tools` with its own
tool names, such as `shell`, and Codex and Cursor do not document the field, so those agents ask
before each command as their own settings say.

## Why `--write` is not pre-approved

`fix --write`, `fix --write --review` and the agent's own edits change the repository, and some
fixes start or change MCP servers and hooks. The skill tells the agent to ask you before each of
them, but the permission prompt is what makes sure it does: repository content can try to talk
an agent into running a command, and an approved write would run without stopping. Leaving
`--write` out keeps you in the loop for every change.

## The pull request gate

`allowed-tools` grants permissions, so a pull request that adds the skill trips the
`permissions` class of [`--gate`](context.md#gate-classes):

```text
✖ 5 security-relevant changes since the baseline need review
    Permission widened: allowed-tools adds Bash(npx agentcheckup@0.1.0 context)
    Permission widened: allowed-tools adds Bash(npx agentcheckup@0.1.0 fix)
    Permission widened: allowed-tools adds Bash(npx agentcheckup@0.1.0 tasks --check *)
    Permission widened: allowed-tools adds Bash(npx agentcheckup@0.1.0 tasks --format json)
    Permission widened: allowed-tools adds Read
```

This is intended: review the five rules once and approve the pull request. Updating the skill
to a new version changes the rules and trips the gate again.

## Sources

- Agent Skills specification: the fields, `allowed-tools` as a space-separated string,
  `references/` and file references one level deep from `SKILL.md`
  (https://agentskills.io/specification, checked 2026-10-17).
- Claude Code skills: `allowed-tools` pre-approves tools during the turn that invokes the skill,
  as a space- or comma-separated string or a YAML list; project skills in `.claude/skills`
  (https://code.claude.com/docs/en/skills, checked 2026-10-17).
- Claude Code permissions: a Bash rule without `*` matches one exact command, and a trailing
  ` *` also matches the bare command (https://code.claude.com/docs/en/permissions, checked
  2026-10-17).
- Codex skills in `.agents/skills` from the working directory up to the repository root
  (https://developers.openai.com/codex/skills, checked 2026-10-17); Cursor skills in
  `.agents/skills`, `.cursor/skills` and the Claude and Codex directories
  (https://cursor.com/docs/skills, checked 2026-10-17).
- GitHub Copilot skills: `allowed-tools` with Copilot's tool names, and project skills in
  `.github/skills`, `.claude/skills` and `.agents/skills`
  (https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills,
  checked 2026-10-17).
- skills CLI: `npx skills add <owner>/<repo> --skill <name>` (https://github.com/vercel-labs/skills,
  checked 2026-10-17).
- release-please generic updater: replaces the first version on each line of an
  `x-release-please-start-version` block
  (https://github.com/googleapis/release-please/blob/main/src/updaters/generic.ts, checked
  2026-10-17).
