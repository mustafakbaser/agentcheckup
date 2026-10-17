import { GATE_CLASSES } from '../core/baseline.js';
import { CONFIG_FILE_NAME, REPOSITORY_URL, TOOL_NAME } from '../core/meta.js';
import { PLATFORM_IDS } from '../core/types.js';
import { CONTEXT_AGENTS } from '../platforms/load/types.js';
import { DEFAULT_MAX_TASKS, MAX_TASKS } from '../tasks/index.js';

const FOOTER = `agentcheckup makes no network requests and collects no telemetry.
Docs: ${REPOSITORY_URL}#readme
`;

export const HELP = `Usage: ${TOOL_NAME} [path] [options]
       ${TOOL_NAME} fix [path] [options]
       ${TOOL_NAME} tasks [path] [options]
       ${TOOL_NAME} context [path] [options]
       ${TOOL_NAME} rules [--json]
       ${TOOL_NAME} explain <rule-id>

Check AGENTS.md, CLAUDE.md, SKILL.md, Cursor rules, Copilot instructions and MCP
configs against how coding agents actually load them. "${TOOL_NAME} fix" repairs
what it can, "${TOOL_NAME} tasks" writes the rest as tasks for a coding agent, and
"${TOOL_NAME} context" shows what each agent loads; run any of them with --help
for its options.

Options
  -f, --format <name>      stylish (default), json, sarif, github, markdown, badge
      --compact            stylish, markdown, github: the findings only, without what
                           each agent misses and the why, fix and how lines
      --verbose            stylish, markdown, github: also each rule's docs URL,
                           rationale and sources
  -o, --output <file>      Write the report to a file instead of stdout
  -t, --targets <list>     Comma-separated platforms to check against. Default: all
                           (${PLATFORM_IDS.join(', ')})
      --fail-on <level>    Exit 1 on findings at or above: error (default), warn, info, none.
                           With --baseline, only new findings count
      --min-score <n>      Exit 1 if the score is below n (0-100)
      --context            Add what each agent loads to the report (load plans and the
                           file-by-agent matrix). Use it for the scan that makes a baseline
      --context-window <n> With --context: the model's context window in tokens
      --baseline <file>    Compare with a JSON report of an earlier scan: mark findings
                           new or unchanged, and list changed MCP servers, hooks,
                           permissions and env overrides
      --gate <classes>     Exit 1 on security-relevant changes since --baseline:
                           ${GATE_CLASSES.join(', ')},
                           or security for all of them, or none
  -c, --config <file>      Use this config file instead of ./${CONFIG_FILE_NAME}
      --no-config          Ignore config files
      --untrusted          Ignore the repository's config and inline suppressions, and
                           do not let its .gitignore hide agent configuration.
                           Use for pull requests from forks and third-party code.
      --no-gitignore       Also scan files excluded by .gitignore
      --show-suppressed    Include suppressed findings in stylish output
      --color, --no-color  Force or disable color (NO_COLOR and FORCE_COLOR are honored)
  -h, --help               Show this help
  -v, --version            Show the version

In GitHub Actions (GITHUB_WORKSPACE is set), github and sarif paths are relative to
the workspace when the scanned directory is inside it.

Exit codes
  0  No findings at or above --fail-on, the score meets --min-score, and no gate tripped
  1  Findings at or above --fail-on (new ones only, with --baseline), the score is
     below --min-score, or --gate found security-relevant changes
  2  Invalid arguments, configuration or baseline
  3  Internal error (a rule or the scanner crashed)

${FOOTER}`;

export const FIX_HELP = `Usage: ${TOOL_NAME} fix [path] [options]

Repair what agentcheckup can fix. Without --write or -i this is a dry run: it
prints the diff of each fix, checked by scanning a fixed copy in memory, and
changes nothing. [path] is the repository root; default: the current directory.

A safe fix has one correct form and adds or changes no MCP server, hook,
permission or env override. Every other fix needs review. Findings without a
fix are listed as manual steps.

Options
      --write              Apply the safe fixes, then scan the files again
      --review             With --write: also apply the fixes that need review
  -i, --interactive        Ask about each fix: [y]es [n]o [d]iff [a]lternatives
                           [q]uit, then apply the accepted ones. Enter means yes
                           for a safe fix and no for one that needs review.
                           Needs a terminal
      --rule <ids>         Comma-separated rule ids: fix only these rules.
                           mcp/literal-secret is fixed only when named here or
                           accepted with -i
  -t, --targets <list>     Comma-separated platforms to check against. Default: all
                           (${PLATFORM_IDS.join(', ')})
  -f, --format <name>      diff (default), json
  -o, --output <file>      Write the diff or JSON to a file instead of stdout
  -c, --config <file>      Use this config file instead of ./${CONFIG_FILE_NAME}
      --no-config          Ignore config files
      --untrusted          Ignore the repository's config and inline suppressions, and
                           do not let its .gitignore hide agent configuration.
                           Dry run only: cannot be combined with --write or -i
      --color, --no-color  Force or disable color
  -h, --help               Show this help

agentcheckup runs no git, hooks or formatters. Review what it wrote with git diff.

Exit codes
  0  Nothing to change (dry run), or every selected fix was applied and verified
  1  The dry run found changes, or a selected fix was not applied: a conflict, a
     file that changed since the scan, a refused path or a failed check
  2  Invalid arguments or configuration, an unknown --rule, or -i without a
     terminal
  3  Internal error (a rule or the scanner crashed)

${FOOTER}`;

export const TASKS_HELP = `Usage: ${TOOL_NAME} tasks [path] [options]
       ${TOOL_NAME} tasks [path] --check [ids...]

Write the findings that need judgment as tasks for a coding agent: a Markdown
prompt with rules for every task, one section per task and a final check, such
as claude "$(npx ${TOOL_NAME} tasks)". [path] is the repository root; default:
the current directory.

Findings that "${TOOL_NAME} fix" can fix are never tasks: step 0 tells the agent
to preview them and to ask you before it applies them. Credentials, hidden
content, MCP servers, hooks, permissions and settings are listed for you and
never given to an agent. Repository text in the prompt is marked as data.

Options
  -f, --format <name>      markdown (default), json
      --rule <ids>         Comma-separated rule ids: only these rules
      --max <n>            List at most n tasks, 1 to ${MAX_TASKS}. Default: ${DEFAULT_MAX_TASKS}
  -o, --output <file>      Write the tasks to a file instead of stdout
      --untrusted          Ignore the repository's config and inline suppressions, and
                           do not let its .gitignore hide agent configuration. Adds a
                           banner: review the prompt before you give it to an agent
      --check [ids...]     Check instead of listing: exit 0 when none of the given
                           tasks, or no task at all, is open. Takes no other option,
                           so it never writes a file. Ids look like ac-7f3c91d2
  -h, --help               Show this help

The configuration file of the repository applies, as in a scan. tasks takes no
--config or --targets, so that tasks --check, which takes no options, checks the
same findings.

Exit codes
  0  No task is open (with --check: none of the given tasks)
  1  A task is open
  2  Invalid arguments or configuration, an unknown --rule, or --check with
     another option
  3  Internal error (a rule or the scanner crashed)

${FOOTER}`;

export const CONTEXT_HELP = `Usage: ${TOOL_NAME} context [path] [options]

Show what each coding agent loads in a session: the files in its context at
session start with their sizes, what loads on demand, its MCP servers and hooks,
and what it skips and why. [path] is the repository root; default: the current
directory. Text and Markdown output show paths relative to [path]; JSON output
uses paths relative to the current directory, as a scan does.

Options
      --agent <list>       Comma-separated agents: ${CONTEXT_AGENTS.join(', ')}.
                           Default: those among the configured targets
      --cwd <dir>          Plan a session started in this directory, relative to [path].
                           Default: the root
      --matrix             Also plan Codex in each directory with an AGENTS.md, and show
                           which agent reads which file. Only from the root
      --context-window <n> The model's context window in tokens, for limits that depend
                           on it, such as the skills listing
  -f, --format <name>      text (default), json, markdown
  -o, --output <file>      Write the report to a file instead of stdout
      --baseline <file>    Compare with a JSON report of an earlier scan with --context
      --gate <classes>     Exit 1 on security-relevant changes since --baseline:
                           ${GATE_CLASSES.join(', ')},
                           or security for all of them, or none
  -c, --config <file>      Use this config file instead of ./${CONFIG_FILE_NAME}
      --no-config          Ignore config files
      --untrusted          Ignore the repository's config and inline suppressions, and
                           do not let its .gitignore hide agent configuration
      --no-gitignore       Also read files excluded by .gitignore
      --color, --no-color  Force or disable color
  -h, --help               Show this help

Exit codes
  0  The plans were shown. Findings never fail this command
  1  --gate found security-relevant changes since --baseline
  2  Invalid arguments, configuration, --agent, --cwd or baseline
  3  Internal error (a rule or a loader crashed)

${FOOTER}`;
