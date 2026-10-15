import { GATE_CLASSES } from '../core/baseline.js';
import { CONFIG_FILE_NAME, REPOSITORY_URL, TOOL_NAME } from '../core/meta.js';
import { PLATFORM_IDS } from '../core/types.js';
import { CONTEXT_AGENTS } from '../platforms/load/types.js';

const FOOTER = `agentcheckup makes no network requests and collects no telemetry.
Docs: ${REPOSITORY_URL}#readme
`;

export const HELP = `Usage: ${TOOL_NAME} [path] [options]
       ${TOOL_NAME} context [path] [options]
       ${TOOL_NAME} rules [--json]
       ${TOOL_NAME} explain <rule-id>

Check AGENTS.md, CLAUDE.md, SKILL.md, Cursor rules, Copilot instructions and MCP
configs against how coding agents actually load them. "${TOOL_NAME} context"
shows what each agent loads; run "${TOOL_NAME} context --help" for its options.

Options
  -f, --format <name>      stylish (default), json, sarif, github, markdown, badge
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
      --untrusted          Ignore the repository's config and inline suppressions.
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
      --untrusted          Ignore the repository's config and inline suppressions
      --no-gitignore       Also read files excluded by .gitignore
      --color, --no-color  Force or disable color
  -h, --help               Show this help

Exit codes
  0  The plans were shown. Findings never fail this command
  1  --gate found security-relevant changes since --baseline
  2  Invalid arguments, configuration, --agent, --cwd or baseline
  3  Internal error (a rule or a loader crashed)

${FOOTER}`;
