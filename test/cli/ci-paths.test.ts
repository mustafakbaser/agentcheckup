import { mkdir, realpath, symlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, run } from '../../src/cli/run.js';
import { symlinksSupported } from '../io/helpers.js';
import { capture, removeTempDirs, tempDir, writeFiles } from './helpers.js';

afterEach(removeTempDirs);

/** An MCP server with a url and no type: one error finding on line 3. */
const MCP = '{\n  "mcpServers": {\n    "docs": { "url": "https://docs.example.com/mcp" }\n  }\n}\n';

/**
 * The GitHub Actions layout: the checkout in $GITHUB_WORKSPACE, the CLI run from $RUNNER_TEMP
 * (outside the checkout, so nothing committed can shadow the package).
 */
let base: string;
let workspace: string;
let runnerTemp: string;
let outside: string;

beforeEach(async () => {
  base = await tempDir();
  workspace = join(base, 'work', 'repo', 'repo');
  runnerTemp = join(base, '_temp');
  outside = join(base, 'other');
  await mkdir(runnerTemp, { recursive: true });
  await writeFiles(workspace, { '.mcp.json': MCP, 'packages/app/.mcp.json': MCP });
  await writeFiles(outside, { '.mcp.json': MCP });
});

async function annotationFiles(
  args: readonly string[],
  env: Record<string, string>,
  cwd = runnerTemp,
) {
  const io = capture(cwd, env);
  expect(await run([...args, '--format', 'github'], io)).toBe(EXIT.findings);
  return [...io.output().matchAll(/^::error file=([^,]+),/gm)].map((match) => match[1]);
}

async function sarifUris(args: readonly string[], env: Record<string, string>, cwd = runnerTemp) {
  const io = capture(cwd, env);
  expect(await run([...args, '--format', 'sarif'], io)).toBe(EXIT.findings);
  const log = JSON.parse(io.output()) as {
    runs: [
      {
        results: {
          locations: { physicalLocation: { artifactLocation: { uri: string } } }[];
        }[];
      },
    ];
  };
  return log.runs[0].results.map(
    (result) => result.locations[0]!.physicalLocation.artifactLocation.uri,
  );
}

describe('paths in github and sarif output', () => {
  it('are relative to GITHUB_WORKSPACE when the scanned directory is inside it', async () => {
    const env = { GITHUB_WORKSPACE: workspace };
    expect(await annotationFiles([workspace], env)).toEqual([
      '.mcp.json',
      'packages/app/.mcp.json',
    ]);
    expect(await sarifUris([workspace], env)).toEqual(['.mcp.json', 'packages/app/.mcp.json']);
    // A subdirectory keeps its place in the repository.
    const app = join(workspace, 'packages', 'app');
    expect(await annotationFiles([app], env)).toEqual(['packages/app/.mcp.json']);
    expect(await sarifUris([app], env)).toEqual(['packages/app/.mcp.json']);
    // A relative GITHUB_WORKSPACE is resolved against the working directory.
    const relativeEnv = { GITHUB_WORKSPACE: relative(runnerTemp, workspace) };
    expect(await annotationFiles([workspace], relativeEnv)).toEqual([
      '.mcp.json',
      'packages/app/.mcp.json',
    ]);
  });

  it.runIf(symlinksSupported)(
    'are relative to GITHUB_WORKSPACE spelled through a symlink, as macOS spells /tmp',
    async () => {
      await symlink(join(base, 'work'), join(base, 'link'));
      const env = { GITHUB_WORKSPACE: join(base, 'link', 'repo', 'repo') };
      const app = await realpath(join(workspace, 'packages', 'app'));
      expect(await annotationFiles([app], env)).toEqual(['packages/app/.mcp.json']);
      expect(await sarifUris([app], env)).toEqual(['packages/app/.mcp.json']);
    },
  );

  it('are relative to the working directory without GITHUB_WORKSPACE', async () => {
    const above = join(base, 'work', 'repo');
    expect((await annotationFiles([workspace], {}, above))[0]).toBe('repo/.mcp.json');
    expect((await annotationFiles([workspace], { GITHUB_WORKSPACE: '' }, above))[0]).toBe(
      'repo/.mcp.json',
    );
    expect((await sarifUris([workspace], {}, above))[0]).toBe('repo/.mcp.json');
  });

  it('are relative to the scanned directory outside the working directory', async () => {
    // From $RUNNER_TEMP, a sibling of the checkout: never `../work/repo/repo/.mcp.json`.
    expect((await annotationFiles([workspace], {}))[0]).toBe('.mcp.json');
    expect((await sarifUris([workspace], {}))[0]).toBe('.mcp.json');
    // Outside GITHUB_WORKSPACE as well.
    const env = { GITHUB_WORKSPACE: workspace };
    expect(await annotationFiles([outside], env)).toEqual(['.mcp.json']);
    expect(await sarifUris([outside], env)).toEqual(['.mcp.json']);
  });

  it('leave the other formats relative to the working directory', async () => {
    const io = capture(base, { GITHUB_WORKSPACE: workspace });
    expect(await run([workspace, '--format', 'json'], io)).toBe(EXIT.findings);
    const report = JSON.parse(io.output()) as { findings: { path: string }[] };
    expect(report.findings[0]?.path).toBe('work/repo/repo/.mcp.json');
  });
});
