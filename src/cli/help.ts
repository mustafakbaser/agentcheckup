import { CONFIG_FILE_NAME, REPOSITORY_URL, TOOL_NAME } from '../core/meta.js';
import { PLATFORM_IDS } from '../core/types.js';

export const HELP = `Usage: ${TOOL_NAME} [path] [options]
       ${TOOL_NAME} rules [--json]
       ${TOOL_NAME} explain <rule-id>

Check AGENTS.md, CLAUDE.md, SKILL.md, Cursor rules, Copilot instructions and MCP
configs against how coding agents actually load them.

Options
  -f, --format <name>      stylish (default), json, sarif, github, markdown, badge
  -o, --output <file>      Write the report to a file instead of stdout
  -t, --targets <list>     Comma-separated platforms to check against. Default: all
                           (${PLATFORM_IDS.join(', ')})
      --fail-on <level>    Exit 1 on findings at or above: error (default), warn, info, none
      --min-score <n>      Exit 1 if the score is below n (0-100)
  -c, --config <file>      Use this config file instead of ./${CONFIG_FILE_NAME}
      --no-config          Ignore config files
      --untrusted          Ignore the repository's config and inline suppressions.
                           Use for pull requests from forks and third-party code.
      --no-gitignore       Also scan files excluded by .gitignore
      --show-suppressed    Include suppressed findings in stylish output
      --color, --no-color  Force or disable color (NO_COLOR and FORCE_COLOR are honored)
  -h, --help               Show this help
  -v, --version            Show the version

Exit codes
  0  No findings at or above --fail-on, and the score meets --min-score
  1  Findings at or above --fail-on, or the score is below --min-score
  2  Invalid arguments or configuration
  3  Internal error (a rule or the scanner crashed)

agentcheck makes no network requests and collects no telemetry.
Docs: ${REPOSITORY_URL}#readme
`;
