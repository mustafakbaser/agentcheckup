/**
 * Opens or updates source-drift issues from a JSON drift report. Runs in
 * .github/workflows/source-drift.yml after `pnpm drift:check --report <file>`.
 *
 *   tsx scripts/drift/sync-issues.ts <report.json>
 *
 * Needs the `gh` CLI with GH_TOKEN (issues: write) and GH_REPO. `gh` is started with execFile
 * and an argument array, never through a shell.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { forTerminal } from '../../src/report/sanitize.js';
import { type IssueContext, type RunGh, syncIssues } from './issues.js';
import { parseReport } from './report.js';

const GH_ENV = {
  ...process.env,
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
};

const runGh: RunGh = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      'gh',
      [...args],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000, env: GH_ENV },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${stderr.trim() || error.message}`),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });

const RUN_ID = /^\d+$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/** The workflow run URL from the runner's default environment variables. */
function runUrl(): string | undefined {
  const server = process.env['GITHUB_SERVER_URL'];
  const repository = process.env['GITHUB_REPOSITORY'];
  const id = process.env['GITHUB_RUN_ID'];
  if (server === undefined || repository === undefined || id === undefined) return undefined;
  if (!server.startsWith('https://') || !REPOSITORY.test(repository) || !RUN_ID.test(id)) {
    return undefined;
  }
  return `${server}/${repository}/actions/runs/${id}`;
}

const [file, ...rest] = process.argv.slice(2);
if (file === undefined || rest.length > 0) {
  process.stderr.write('Usage: tsx scripts/drift/sync-issues.ts <report.json>\n');
  process.exitCode = 2;
} else {
  const report = parseReport(await readFile(file, 'utf8'));
  const context: IssueContext = { runUrl: runUrl() };
  for (const line of await syncIssues(report, runGh, context)) {
    process.stdout.write(`${forTerminal(line)}\n`);
  }
}
