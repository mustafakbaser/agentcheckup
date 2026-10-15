/**
 * Packs the package, installs the tarball into an empty project, and runs the installed CLI.
 * Catches what unit tests cannot: missing files in the tarball, a broken bin entry, a bundle that
 * still needs a dependency at runtime.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'agentcheck-smoke-'));
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
    'schemas/report.schema.json',
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

  process.stdout.write(
    `smoke: ok (${files.length} files, ${report.findings.length} findings, score ${report.score.score})\n`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
