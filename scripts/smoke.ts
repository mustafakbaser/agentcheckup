/**
 * Packs the package, installs the tarball into an empty project, and runs the installed CLI.
 * Catches what unit tests cannot: missing files in the tarball, a broken bin entry, a bundle that
 * still needs a dependency at runtime.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'agentcheckup-smoke-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function fail(message: string): never {
  throw new Error(`smoke: ${message}`);
}

try {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };

  const packed = JSON.parse(
    execFileSync(npm, ['pack', '--json', '--pack-destination', work], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }),
  ) as { filename: string; files: { path: string }[] }[];
  const tarball = packed[0] ?? fail('npm pack produced no tarball');
  const files = tarball.files.map((file) => file.path).sort();

  for (const required of [
    'LICENSE',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'dist/cli.js',
    'dist/index.js',
    'dist/index.d.ts',
    'package.json',
    'schemas/config.schema.json',
    'schemas/fix.schema.json',
    'schemas/report.schema.json',
    'skills/agentcheckup/SKILL.md',
    'skills/agentcheckup/references/context.md',
    'skills/agentcheckup/references/fix-classes.md',
    'skills/agentcheckup/references/tasks.md',
  ]) {
    if (!files.includes(required)) fail(`tarball is missing ${required}`);
  }
  const unexpected = files.filter((path) => /^(?:src|test|scripts|docs|\.github)\//.test(path));
  if (unexpected.length > 0) fail(`tarball contains development files: ${unexpected.join(', ')}`);

  const project = join(work, 'project');
  execFileSync(npm, ['init', '-y'], {
    cwd: work,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  await writeFile(join(work, 'package.json'), '{"name":"smoke","private":true}\n');
  execFileSync(
    npm,
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', join(work, tarball.filename)],
    { cwd: work, stdio: 'inherit', shell: process.platform === 'win32' },
  );

  const installed = JSON.parse(
    await readFile(join(work, 'node_modules', manifest.name, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  if (installed.dependencies && Object.keys(installed.dependencies).length > 0) {
    fail(
      `published package must have zero dependencies, found: ${Object.keys(installed.dependencies).join(', ')}`,
    );
  }

  const cli = join(work, 'node_modules', manifest.name, 'dist', 'cli.js');
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  if (version.status !== 0) fail(`--version exited ${version.status}: ${version.stderr}`);
  if (version.stdout.trim() !== manifest.version) {
    fail(`--version printed "${version.stdout.trim()}", expected "${manifest.version}"`);
  }

  const fixture = join(root, 'test', 'fixtures', 'smoke');
  const scan = spawnSync(process.execPath, [cli, fixture, '--format', 'json'], {
    encoding: 'utf8',
  });
  if (scan.status !== 1)
    fail(`scan of the smoke fixture exited ${scan.status}, expected 1: ${scan.stderr}`);
  const report = JSON.parse(scan.stdout) as {
    findings: { ruleId: string }[];
    score: { score: number };
  };
  if (report.findings.length === 0) fail('scan of the smoke fixture reported no findings');

  const sarif = spawnSync(process.execPath, [cli, fixture, '--format', 'sarif'], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(sarif.stdout) as { version: string };
  if (parsed.version !== '2.1.0') fail('SARIF output has the wrong version');

  const clean = spawnSync(process.execPath, [cli, project, '--format', 'json'], {
    encoding: 'utf8',
  });
  if (clean.status !== 2) fail(`scanning a missing directory exited ${clean.status}, expected 2`);

  // What each agent loads, the matrix, and a baseline round trip with the gate. Run from inside
  // the fixture, so report paths are root-relative.
  const repo = join(root, 'test', 'fixtures', 'context');
  const runCli = (args: readonly string[], expected: number): string => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8' });
    if (result.status !== expected) {
      fail(`${args.join(' ')} exited ${result.status}, expected ${expected}: ${result.stderr}`);
    }
    return result.stdout;
  };
  if (!runCli(['context', repo], 0).includes('Claude Code context')) {
    fail('context printed no Claude Code plan');
  }
  if (!/^AGENTS\.md(?: +startup){4}$/m.test(runCli(['context', repo, '--matrix'], 0))) {
    fail('context --matrix printed no matrix row for AGENTS.md');
  }
  const baseline = join(work, 'baseline.json');
  runCli([repo, '--context', '--format', 'json', '--output', baseline, '--fail-on', 'none'], 0);
  const compared = JSON.parse(
    runCli(
      [repo, '--context', '--baseline', baseline, '--gate', 'security', '--format', 'json'],
      0,
    ),
  ) as { baseline?: { findings: { new: number }; gate: { hits: unknown[] } } };
  if (compared.baseline?.findings.new !== 0 || compared.baseline.gate.hits.length !== 0) {
    fail('a scan compared with its own baseline reported changes');
  }
  runCli(
    ['context', repo, '--baseline', baseline, '--gate', 'security', '--cwd', 'packages/api'],
    0,
  );
  runCli([repo, '--gate', 'security'], 2);

  // fix on a demo repository with known fixable findings: CLAUDE.md without the AGENTS.md
  // import (safe), a Cursor rule saved as .md (review) and an MCP server with a url but no type
  // (review). The dry run lists all three and exits 1; --write applies only the safe fix;
  // --write --review applies the rest; a last dry run plans nothing and exits 0.
  const demo = join(work, 'fix-repo');
  const demoFiles: Readonly<Record<string, string>> = {
    'AGENTS.md': '# Acme API\n\nRun `pnpm test` before every commit.\n',
    'CLAUDE.md': '# Claude notes\n\nUse the staging database for manual tests.\n',
    '.cursor/rules/x.md': 'Prefer named exports in TypeScript files.\n',
    '.mcp.json':
      '{\n  "mcpServers": {\n    "docs": {\n      "url": "https://example.com/mcp"\n    }\n  }\n}\n',
  };
  for (const [path, text] of Object.entries(demoFiles)) {
    await mkdir(dirname(join(demo, path)), { recursive: true });
    await writeFile(join(demo, path), text);
  }
  const readDemo = (path: string): Promise<string> => readFile(join(demo, path), 'utf8');
  const exists = (path: string): Promise<boolean> =>
    access(join(demo, path)).then(
      () => true,
      () => false,
    );
  interface FixJson {
    mode: string;
    fixes: { id: string; class: string; status: string }[];
  }
  const fixCli = (args: readonly string[], expected: number): string => {
    const result = spawnSync(process.execPath, [cli, 'fix', ...args], {
      cwd: demo,
      encoding: 'utf8',
    });
    if (result.status !== expected) {
      fail(`fix ${args.join(' ')} exited ${result.status}, expected ${expected}: ${result.stderr}`);
    }
    return result.stdout;
  };
  const fixIds = (report: FixJson, status: string): string =>
    report.fixes
      .filter((entry) => entry.status === status)
      .map((entry) => `${entry.class} ${entry.id}`)
      .sort()
      .join(', ');
  const SAFE_FIX = 'safe instr/agents-md-ignored-by-claude#import';
  const REVIEW_FIXES =
    'review cursor/md-file-ignored#always-apply, review mcp/url-without-type#http';

  const dryRun = JSON.parse(fixCli(['--format', 'json'], 1)) as FixJson;
  if (dryRun.mode !== 'dry-run') fail('fix --format json did not report a dry run');
  const planned = fixIds(dryRun, 'planned');
  if (planned !== `${REVIEW_FIXES}, ${SAFE_FIX}`) fail(`fix planned ${planned}`);
  const diff = fixCli([], 1);
  for (const title of [
    'Add "@AGENTS.md" as line 1 of CLAUDE.md',
    'Rename .cursor/rules/x.md to x.mdc',
    'Add "type": "http" to MCP server "docs"',
  ]) {
    if (!diff.includes(title)) fail(`fix printed no "${title}": ${diff}`);
  }

  const safe = JSON.parse(fixCli(['--write', '--format', 'json'], 0)) as FixJson;
  if (fixIds(safe, 'applied') !== SAFE_FIX) fail(`fix --write applied ${fixIds(safe, 'applied')}`);
  if (!(await readDemo('CLAUDE.md')).startsWith('@AGENTS.md\n\n# Claude notes\n')) {
    fail('fix --write did not add the AGENTS.md import to CLAUDE.md');
  }
  if (!(await exists('.cursor/rules/x.md')) || (await exists('.cursor/rules/x.mdc'))) {
    fail('fix --write renamed the Cursor rule, a fix that needs review');
  }
  if ((await readDemo('.mcp.json')) !== demoFiles['.mcp.json']) {
    fail('fix --write changed .mcp.json, a fix that needs review');
  }

  const review = JSON.parse(fixCli(['--write', '--review', '--format', 'json'], 0)) as FixJson;
  if (fixIds(review, 'applied') !== REVIEW_FIXES) {
    fail(`fix --write --review applied ${fixIds(review, 'applied')}`);
  }
  if (
    (await exists('.cursor/rules/x.md')) ||
    !(await readDemo('.cursor/rules/x.mdc')).startsWith('---\nalwaysApply: true\n---\n')
  ) {
    fail('fix --write --review did not turn the Cursor rule into x.mdc with alwaysApply');
  }
  if (!(await readDemo('.mcp.json')).includes('"type": "http",')) {
    fail('fix --write --review did not add "type": "http" to .mcp.json');
  }

  const again = JSON.parse(fixCli(['--format', 'json'], 0)) as FixJson;
  if (again.fixes.length > 0)
    fail(`a second fix dry run still planned ${fixIds(again, 'planned')}`);
  fixCli([], 0);
  fixCli(['--untrusted', '--write'], 2);

  // skill install from the installed package: it finds the skill in the package, pins the
  // package's version, and the repository it writes to scans clean.
  const skillRepo = join(work, 'skill-repo');
  await mkdir(skillRepo);
  await writeFile(
    join(skillRepo, 'AGENTS.md'),
    '# Acme API\n\nRun `pnpm test` before every commit.\n',
  );
  const install = spawnSync(process.execPath, [cli, 'skill', 'install', '--yes'], {
    cwd: skillRepo,
    encoding: 'utf8',
  });
  if (install.status !== 0) fail(`skill install exited ${install.status}: ${install.stderr}`);
  const installedSkill = await readFile(
    join(skillRepo, '.claude', 'skills', 'agentcheckup', 'SKILL.md'),
    'utf8',
  );
  if (!installedSkill.includes(`Bash(npx agentcheckup@${manifest.version} tasks --check *)`)) {
    fail('the installed skill does not pin the package version');
  }
  const skillScan = spawnSync(process.execPath, [cli, skillRepo, '--fail-on', 'info'], {
    encoding: 'utf8',
  });
  if (skillScan.status !== 0)
    fail(`the repository with the skill has findings: ${skillScan.stdout}`);
  const secondInstall = spawnSync(process.execPath, [cli, 'skill', 'install', skillRepo, '--yes'], {
    encoding: 'utf8',
  });
  if (secondInstall.status !== 1) {
    fail(`a second skill install exited ${secondInstall.status}, expected 1`);
  }

  process.stdout.write(
    `smoke: ok (${files.length} files, ${report.findings.length} findings, score ${report.score.score})\n`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
