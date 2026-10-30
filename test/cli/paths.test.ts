import { mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, run } from '../../src/cli/run.js';
import { symlinksSupported } from '../io/helpers.js';
import { capture, removeTempDirs, tempDir, writeFiles } from './helpers.js';

afterEach(removeTempDirs);

/** An MCP server with a url and no type: one error finding. */
const MCP = '{\n  "mcpServers": {\n    "docs": { "url": "https://docs.example.com/mcp" }\n  }\n}\n';

/** The path of the finding in each format, scanning `path` from `cwd`. */
async function reportedPaths(cwd: string, path: string) {
  const outputs: Record<string, string> = {};
  for (const format of ['stylish', 'json', 'sarif', 'github', 'markdown']) {
    const io = capture(cwd);
    expect(await run([path, '--format', format], io), format).toBe(EXIT.findings);
    outputs[format] = io.output();
  }
  const json = JSON.parse(outputs['json'] ?? '') as { findings: { path: string }[] };
  const sarif = JSON.parse(outputs['sarif'] ?? '') as {
    runs: [
      { results: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[] },
    ];
  };
  return {
    outputs,
    json: json.findings[0]?.path,
    sarif: sarif.runs[0].results[0]?.locations[0]?.physicalLocation.artifactLocation.uri,
    github: /^::error file=([^,]+),/m.exec(outputs['github'] ?? '')?.[1],
  };
}

function expectNoParentOrAbsolute(outputs: Record<string, string>, absolute: string): void {
  for (const [format, output] of Object.entries(outputs)) {
    expect(output, format).not.toContain('../');
    expect(output, format).not.toContain('..\\');
    expect(output, format).not.toContain(absolute);
  }
}

describe('report paths', () => {
  it.runIf(symlinksSupported)(
    'are relative to the working directory when the path goes through a symlink',
    async () => {
      const dir = await tempDir();
      await writeFiles(join(dir, 'real', 'repo'), { '.mcp.json': MCP });
      await symlink(join(dir, 'real'), join(dir, 'link'));
      // process.cwd() is the physical directory; the path is spelled through the link, as a
      // logical $PWD or macOS's /tmp spells it.
      const cwd = await realpath(join(dir, 'real'));
      const paths = await reportedPaths(cwd, join(dir, 'link', 'repo'));
      expect(paths.json).toBe('repo/.mcp.json');
      expect(paths.sarif).toBe('repo/.mcp.json');
      expect(paths.github).toBe('repo/.mcp.json');
      expect(paths.outputs['stylish']).toContain('repo/.mcp.json');
      expectNoParentOrAbsolute(paths.outputs, dir);
    },
  );

  it('are relative to the scanned directory outside the working directory', async () => {
    const dir = await tempDir();
    await writeFiles(join(dir, 'b'), { '.mcp.json': MCP });
    await mkdir(join(dir, 'a'));
    const paths = await reportedPaths(join(dir, 'a'), join(dir, 'b'));
    expect([paths.json, paths.sarif, paths.github]).toEqual([
      '.mcp.json',
      '.mcp.json',
      '.mcp.json',
    ]);
    expectNoParentOrAbsolute(paths.outputs, dir);
    // The same from a relative path.
    expect((await reportedPaths(join(dir, 'a'), '../b')).json).toBe('.mcp.json');
  });

  it('keep the prefix of a subdirectory of the working directory', async () => {
    const dir = await tempDir();
    await writeFiles(join(dir, 'b'), { '.mcp.json': MCP });
    const paths = await reportedPaths(dir, 'b');
    expect([paths.json, paths.sarif, paths.github]).toEqual([
      'b/.mcp.json',
      'b/.mcp.json',
      'b/.mcp.json',
    ]);
  });
});

describe('--output', () => {
  const FILES = {
    'AGENTS.md': '# Acme API\n\nRun `pnpm test` before every commit.\n',
    'CLAUDE.md': '# Claude notes\n\nUse the staging database for manual tests.\n',
  };

  it('never replaces a file the scan read or a fix writes', async () => {
    const repo = await tempDir();
    await writeFiles(repo, FILES);
    for (const [args, output] of [
      [['fix', '--write'], 'CLAUDE.md'],
      [['fix'], 'CLAUDE.md'],
      [['--format', 'json'], 'AGENTS.md'],
      [['context'], 'AGENTS.md'],
      [['tokens'], 'AGENTS.md'],
      [['agents'], 'AGENTS.md'],
      [['tasks'], 'AGENTS.md'],
      [['--format', 'json'], `../${repo.split(/[/\\]/).at(-1) ?? ''}/AGENTS.md`],
    ] as const) {
      const io = capture(repo);
      expect(await run([...args, '-o', output], io), `${args.join(' ')} -o ${output}`).toBe(
        EXIT.usage,
      );
      expect(io.errors()).toContain(`agentcheckup scanned ${output}; choose another --output.`);
    }
    expect(await readFile(join(repo, 'CLAUDE.md'), 'utf8')).toBe(FILES['CLAUDE.md']);
    expect(await readFile(join(repo, 'AGENTS.md'), 'utf8')).toBe(FILES['AGENTS.md']);
  });

  it.runIf(symlinksSupported)(
    'never replaces a file the scan read under another name for it',
    async () => {
      const dir = await tempDir();
      const repo = join(dir, 'repo');
      await writeFiles(repo, { ...FILES, '.claude/settings.json': '{}\n' });
      await symlink(join(repo, '.claude'), join(repo, 'sub'));
      await symlink(repo, join(dir, 'link'));
      // process.cwd() is the physical directory, as macOS gives it for a path under /tmp.
      const cwd = await realpath(repo);
      for (const output of [
        'sub/settings.json',
        join(dir, 'link', 'AGENTS.md'),
        join(repo, 'AGENTS.md'),
        '../link/CLAUDE.md',
      ]) {
        for (const args of [[], ['fix', '--write'], ['context']]) {
          const io = capture(cwd);
          expect(await run([...args, '-o', output], io), `${args.join(' ')} -o ${output}`).toBe(
            EXIT.usage,
          );
          expect(io.errors()).toContain(`agentcheckup scanned ${output}; choose another --output.`);
        }
      }
      expect(await readFile(join(repo, 'AGENTS.md'), 'utf8')).toBe(FILES['AGENTS.md']);
      expect(await readFile(join(repo, 'CLAUDE.md'), 'utf8')).toBe(FILES['CLAUDE.md']);
      expect(await readFile(join(repo, '.claude/settings.json'), 'utf8')).toBe('{}\n');
    },
  );

  it('takes another case for the same file only where the file system does', async () => {
    const repo = await tempDir();
    await writeFiles(repo, FILES);
    // The default file systems of macOS and Windows take agents.md for AGENTS.md.
    const ignoresCase = await stat(join(repo, 'agents.md')).then(
      () => true,
      () => false,
    );
    for (const args of [
      ['--format', 'json'],
      ['fix', '--write'],
    ]) {
      const io = capture(repo);
      const code = await run([...args, '-o', 'agents.md'], io);
      expect(code, args.join(' ')).toBe(ignoresCase ? EXIT.usage : EXIT.ok);
      if (ignoresCase) expect(io.errors()).toContain('agentcheckup scanned agents.md');
    }
    expect(await readFile(join(repo, 'AGENTS.md'), 'utf8')).toBe(FILES['AGENTS.md']);
  });

  it('never replaces the configuration file or a git file that steered the walk', async () => {
    const dir = await tempDir();
    const repo = join(dir, 'repo');
    const config = '{ "rules": { "instr/size-budget": "off" } }\n';
    await writeFiles(repo, {
      ...FILES,
      'agentcheckup.config.json': config,
      '.gitignore': 'dist/\n',
      'packages/app/.gitignore': 'build/\n',
      '.gitmodules': '',
    });
    await writeFile(join(dir, 'custom.json'), config);
    for (const [args, output] of [
      [[], 'agentcheckup.config.json'],
      [['fix', '--write'], 'agentcheckup.config.json'],
      [['--config', '../custom.json'], '../custom.json'],
      [[], '.gitignore'],
      [['tokens'], 'packages/app/.gitignore'],
      [['--no-gitignore'], '.gitignore'],
      [[], '.gitmodules'],
    ] as const) {
      const io = capture(repo);
      expect(await run([...args, '-o', output], io), `${args.join(' ')} -o ${output}`).toBe(
        EXIT.usage,
      );
      expect(io.errors()).toContain(`agentcheckup read ${output}; choose another --output.`);
    }
    expect(await readFile(join(repo, 'agentcheckup.config.json'), 'utf8')).toBe(config);
    expect(await readFile(join(dir, 'custom.json'), 'utf8')).toBe(config);
    expect(await readFile(join(repo, '.gitignore'), 'utf8')).toBe('dist/\n');
    expect(await readFile(join(repo, 'packages/app/.gitignore'), 'utf8')).toBe('build/\n');
    // A configuration file the run does not read is the user's to replace.
    expect(await run(['--no-config', '-o', 'agentcheckup.config.json'], capture(repo))).toBe(
      EXIT.ok,
    );
  });

  it('never replaces a file a fix creates', async () => {
    const repo = await tempDir();
    await writeFiles(repo, { '.cursor/rules/style.md': 'Prefer named exports.\n' });
    const io = capture(repo);
    const args = ['fix', '--write', '--review', '-o', '.cursor/rules/style.mdc'];
    expect(await run(args, io)).toBe(EXIT.usage);
    expect(io.errors()).toContain('agentcheckup fix writes .cursor/rules/style.mdc');
    expect(await readFile(join(repo, '.cursor/rules/style.md'), 'utf8')).toBe(
      'Prefer named exports.\n',
    );
  });

  it('writes a report inside the scanned directory, also over an earlier report', async () => {
    const repo = await tempDir();
    await writeFiles(repo, FILES);
    for (let run_ = 0; run_ < 2; run_++) {
      expect(await run(['--format', 'json', '-o', 'report.json'], capture(repo))).toBe(EXIT.ok);
    }
    expect(await run(['fix', '--write', '-o', 'fix.diff'], capture(repo))).toBe(EXIT.ok);
    expect(await readFile(join(repo, 'fix.diff'), 'utf8')).toContain('CLAUDE.md');
    expect(await readFile(join(repo, 'CLAUDE.md'), 'utf8')).toMatch(/^@AGENTS\.md\n/);
    await writeFile(join(repo, 'notes.md'), 'not an agent file\n');
    expect(await run(['-o', 'notes.md'], capture(repo))).toBe(EXIT.ok);
  });
});
