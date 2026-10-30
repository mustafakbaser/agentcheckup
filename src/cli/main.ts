#!/usr/bin/env node
import { terminalPrompt } from './prompt.js';
import { run } from './run.js';
import { guardStream } from './streams.js';

// Guarded before anything writes to them, readline included: a reader that stops early
// (`agentcheckup | head`) must not crash the run or change its exit code.
const stdout = guardStream(process.stdout);
const stderr = guardStream(process.stderr);
const prompt = terminalPrompt(process.stdin, process.stdout);
let code: number;
try {
  code = await run(process.argv.slice(2), {
    stdout,
    stderr,
    cwd: process.cwd(),
    env: process.env,
    isTTY: process.stdout.isTTY,
    prompt,
  });
} finally {
  prompt.close();
}
// exitCode, not exit(): lets stdout drain when piped.
process.exitCode = code;
