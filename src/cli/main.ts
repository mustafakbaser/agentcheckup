#!/usr/bin/env node
import { run } from './run.js';

const code = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
  isTTY: process.stdout.isTTY,
});
// exitCode, not exit(): lets stdout drain when piped.
process.exitCode = code;
