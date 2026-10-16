#!/usr/bin/env node
import { terminalPrompt } from './prompt.js';
import { run } from './run.js';

const prompt = terminalPrompt(process.stdin, process.stdout);
let code: number;
try {
  code = await run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
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
