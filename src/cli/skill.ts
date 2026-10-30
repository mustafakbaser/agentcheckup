/**
 * `agentcheckup skill install` (docs/skill.md): installs the agentcheckup skill that ships in the
 * package (skills/agentcheckup) into the repository's .claude/skills or .agents/skills.
 *
 * 1. Reads the packaged files through src/io/package-assets.ts and pins every
 *    `agentcheckup@<version>` in them to the running version.
 * 2. Refuses when the skill directory, or the skill in the other skills directory, exists.
 * 3. Adds the files to the walked snapshot in memory and runs every rule on every target. Any
 *    finding the files add means refuse.
 * 4. Asks on a terminal, unless `--yes`.
 * 5. Creates the files through src/io/write-fix.ts, as one all-or-nothing unit: creates only,
 *    never over an existing file, never through a symlink.
 *
 * Every file access goes through src/io; this module only decides and prints.
 */
import { resolve } from 'node:path';
import { compareStrings } from '../core/compare.js';
import { analyze, type RuleResult, runRules, type ScanOptions } from '../core/engine.js';
import { pathStatus } from '../core/paths.js';
import {
  type Finding,
  PLATFORM_IDS,
  type PlatformId,
  type Snapshot,
  type SourceFile,
} from '../core/types.js';
import { VERSION } from '../core/version.js';
import { findPackageRoot, PackageAssetError, readPackageText } from '../io/package-assets.js';
import { relativeInsideRoot } from '../io/paths.js';
import { checkRoot, walk } from '../io/walk.js';
import { FixWriteError, type FixWriteResult, writeFixes, type WriteStep } from '../io/write-fix.js';
import { parseFrontmatter } from '../parse/frontmatter.js';
import { splitToolRules } from '../platforms/permissions.js';
import { SKILL_ROOTS } from '../platforms/skills.js';
import { forTerminal } from '../report/sanitize.js';
import { readerList } from '../rules/shared/format.js';
import { type SkillCommandOptions, type SkillDir, UsageError } from './args.js';
import { EXIT, type ExitCode, type Io, loadConfig, type Prompt, scanOptionsFor } from './common.js';

/** The skill's name, and the name of its directory. */
export const SKILL_NAME = 'agentcheckup';

/** Where the skill is in the package. */
export const PACKAGED_SKILL = 'skills/agentcheckup';

/** The skill's files, relative to its directory. */
export const SKILL_FILES = [
  'SKILL.md',
  'references/context.md',
  'references/fix-classes.md',
  'references/tasks.md',
] as const;

/** The skills directory for each `--dir`. */
export const SKILL_DIRECTORIES: Readonly<Record<SkillDir, string>> = {
  claude: '.claude/skills',
  agents: '.agents/skills',
};

/**
 * `agentcheckup@` and a version, matched as release-please's generic updater matches one, so
 * every version a release bumps is a version the installer replaces.
 */
const PIN = /agentcheckup@\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.-]+)?/g;
const PIN_PREFIX = 'agentcheckup@';

/** What to install. Tests replace both; the CLI uses this package and its version. */
export interface SkillSource {
  /** The version the installed skill pins. Default: the running version. */
  readonly version?: string;
  /** The agentcheckup package to read the skill from. Default: the running package. */
  readonly packageRoot?: string;
}

/** One file of the skill: its path in the skill directory and its text. */
export interface SkillFile {
  readonly path: string;
  readonly text: string;
}

/** The packaged skill is missing, broken or pins more than one version. */
export class SkillPackageError extends Error {
  override readonly name = 'SkillPackageError';
}

/** The versions pinned in `text`, in order. */
export function pinnedVersions(text: string): string[] {
  return [...text.matchAll(PIN)].map((match) => match[0].slice(PIN_PREFIX.length));
}

/** `text` with every pinned version replaced by `version`. */
export function withVersion(text: string, version: string): string {
  return text.replace(PIN, () => PIN_PREFIX + version);
}

/**
 * The packaged skill's files with the versions replaced by `version`. Throws
 * {@link SkillPackageError} or PackageAssetError when the package's copy cannot be used.
 */
export async function packagedSkill(packageRoot: string, version: string): Promise<SkillFile[]> {
  if (pinnedVersions(PIN_PREFIX + version).join() !== version) {
    throw new SkillPackageError(`Cannot pin the skill to version ${version}.`);
  }
  const files: SkillFile[] = [];
  for (const path of SKILL_FILES) {
    files.push({ path, text: await readPackageText(packageRoot, `${PACKAGED_SKILL}/${path}`) });
  }
  const pinned = new Set(files.flatMap((file) => pinnedVersions(file.text)));
  if (pinned.size !== 1) {
    throw new SkillPackageError(
      `The packaged skill in ${PACKAGED_SKILL} pins ${pinned.size === 0 ? 'no version' : `${pinned.size} versions`} of agentcheckup. Reinstall agentcheckup.`,
    );
  }
  return files.map((file) => ({ path: file.path, text: withVersion(file.text, version) }));
}

export async function skill(
  options: SkillCommandOptions,
  io: Io,
  source: SkillSource = {},
): Promise<ExitCode> {
  const prompt = options.yes ? undefined : terminalOf(io);
  const root = (await checkRoot(resolve(io.cwd, options.path))).path;
  const config = await loadConfig(options, root, io.cwd);
  const targets = config?.targets ?? PLATFORM_IDS;
  const dir = options.dir ?? (targets.includes('claude-code') ? 'claude' : 'agents');
  const skillsDirectory = SKILL_DIRECTORIES[dir];
  const target = `${skillsDirectory}/${SKILL_NAME}`;
  const base = relativeInsideRoot(io.cwd, root) ?? '';
  const shown = (path: string): string => forTerminal(base === '' ? path : `${base}/${path}`);

  let files: SkillFile[];
  try {
    files = await packagedSkill(
      source.packageRoot ?? (await findPackageRoot()),
      source.version ?? VERSION,
    );
  } catch (error) {
    if (!(error instanceof PackageAssetError || error instanceof SkillPackageError)) throw error;
    io.stderr(`${forTerminal(error.message)}\n`);
    return EXIT.internal;
  }

  // The .gitignore must not hide a skill that agents load from the directory.
  const snapshot = await walk(root, { respectGitignore: true, scanIgnoredAgentConfig: true });
  const refusal = existingSkill(snapshot, dir);
  if (refusal !== undefined) {
    io.stderr(`Not installed: ${forTerminal(refusal(shown))}\n`);
    return EXIT.findings;
  }

  const encoder = new TextEncoder();
  const added = files.map((file) => ({
    path: `${target}/${file.path}`,
    bytes: encoder.encode(file.text),
  }));
  const scanOptions = scanOptionsFor({ untrusted: false }, undefined, undefined);
  const before = scan(snapshot, scanOptions);
  const after = scan(withFiles(snapshot, added), scanOptions);
  const failures = [...before.ruleFailures, ...after.ruleFailures];
  if (failures.length > 0) {
    for (const failure of failures) {
      io.stderr(`Rule ${forTerminal(failure.ruleId)} crashed: ${forTerminal(failure.message)}\n`);
    }
    io.stderr('Not installed: a scan with a crashed rule cannot check the skill.\n');
    return EXIT.internal;
  }
  const introduced = newFindings(before.findings, after.findings);
  if (introduced.length > 0) {
    io.stderr(
      `Not installed: with the skill in ${shown(target)}, agentcheckup reports ${introduced.length === 1 ? 'a finding' : `${introduced.length} findings`} it does not report now:\n`,
    );
    for (const finding of introduced) {
      io.stderr(
        `  ${finding.severity}  ${shown(finding.path)}:${finding.range.start.line}  ` +
          `${forTerminal(finding.ruleId)}  ${forTerminal(finding.message)}\n`,
      );
    }
    return EXIT.findings;
  }

  const tools = allowedTools(files.find((file) => file.path === 'SKILL.md')?.text ?? '');
  io.stdout(planText(files, tools, target, dir, shown));
  if (prompt !== undefined) {
    const answer = await prompt.ask('Install the skill? [y/N] ');
    if (answer === undefined) {
      io.stdout('\nStopped: nothing was installed.\n');
      return EXIT.findings;
    }
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
      io.stdout('Not installed.\n');
      return EXIT.findings;
    }
  }

  await io.beforeWrite?.();
  const steps: WriteStep[] = added.map((file) => ({ kind: 'create', ...file }));
  let results: FixWriteResult[];
  try {
    results = await writeFixes(root, snapshot.files, [{ id: SKILL_NAME, steps }]);
  } catch (error) {
    if (!(error instanceof FixWriteError)) throw error;
    io.stderr(`Not installed: ${forTerminal(error.message)}\n`);
    return EXIT.findings;
  }
  // One unit, so one result.
  const failed = results.find((result) => result.status !== 'applied');
  if (failed !== undefined) {
    io.stderr(`Not installed: ${writeFailure(failed, shown)}\n`);
    return EXIT.findings;
  }
  const gate =
    tools.length === 0
      ? ''
      : 'Its allowed-tools is a new permission: a pull request check with --gate permissions or\n' +
        '--gate security flags it. That is intended: review the tools above and approve it.\n';
  io.stdout(
    `Installed the agentcheckup skill in ${shown(target)} (${files.length} files).\n${gate}` +
      `Commit ${shown(target)}. To update the skill, remove the directory and install again.\n`,
  );
  return EXIT.ok;
}

/** The prompt to confirm with, or a UsageError unless stdin and stdout are both terminals. */
function terminalOf(io: Io): Prompt {
  const prompt = io.prompt;
  if (prompt === undefined || !prompt.isTTY || !io.isTTY) {
    throw new UsageError(
      'skill install asks before it writes, so it needs a terminal: stdin and stdout must ' +
        'both be a TTY. In scripts, add --yes.',
    );
  }
  return prompt;
}

/**
 * Why the skill cannot go into `dir`: its directory exists, or cannot be seen, or the skill is
 * already in the other skills directory. Undefined when nothing is in the way. The result
 * formats the message with the function that shows a path.
 */
function existingSkill(
  snapshot: Snapshot,
  dir: SkillDir,
): ((shown: (path: string) => string) => string) | undefined {
  const target = `${SKILL_DIRECTORIES[dir]}/${SKILL_NAME}`;
  const status = pathStatus(snapshot, target);
  if (status === 'exists') {
    return (shown) =>
      `${shown(target)} already exists, and skill install never overwrites. Remove it to install this version.`;
  }
  if (status === 'unknown') {
    return (shown) =>
      `agentcheckup cannot tell whether ${shown(target)} exists: a directory on its path was not listed (excluded, unreadable or past a limit).`;
  }
  const other: SkillDir = dir === 'claude' ? 'agents' : 'claude';
  const elsewhere = `${SKILL_DIRECTORIES[other]}/${SKILL_NAME}`;
  if (pathStatus(snapshot, elsewhere) === 'missing') return undefined;
  const agentsReaders = skillReaders('agents');
  const both = skillReaders('claude').filter((platform) => agentsReaders.includes(platform));
  return (shown) =>
    `the skill is already in ${shown(elsewhere)}. ${readerList(both)} read both ` +
    `${SKILL_DIRECTORIES.claude} and ${SKILL_DIRECTORIES.agents}, so a second copy would give ` +
    `them two skills named "${SKILL_NAME}" (skill/duplicate-name). Keep that copy, or remove it ` +
    `and install again.`;
}

/**
 * The platforms whose agents load skills from the skills directory of `--dir`, in
 * SKILL_ROOTS order. Messages name them with `readerList`: Devin Local, not Windsurf.
 */
export function skillReaders(dir: SkillDir): PlatformId[] {
  const segment = SKILL_DIRECTORIES[dir];
  const root = SKILL_ROOTS.find((candidate) => candidate.segment === segment);
  return root?.readers.map((reader) => reader.platform) ?? [];
}

function scan(snapshot: Snapshot, options: ScanOptions): RuleResult {
  return runRules(analyze(snapshot, options), options);
}

/** `snapshot` with `files` added, as a walk would list them. */
function withFiles(
  snapshot: Snapshot,
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
): Snapshot {
  const paths = new Set(snapshot.paths);
  const added: SourceFile[] = [];
  for (const file of files) {
    added.push({ path: file.path, bytes: file.bytes });
    paths.add(file.path);
    const parts = file.path.split('/');
    for (let length = 1; length < parts.length; length++) {
      paths.add(`${parts.slice(0, length).join('/')}/`);
    }
  }
  const all = [...snapshot.files, ...added].sort((a, b) => compareStrings(a.path, b.path));
  return { ...snapshot, files: all, paths };
}

/** Unsuppressed findings of `after` that `before` does not have, by rule, path and message. */
function newFindings(before: readonly Finding[], after: readonly Finding[]): Finding[] {
  const key = (finding: Finding): string =>
    `${finding.ruleId}\u0000${finding.path}\u0000${finding.message}`;
  const known = new Map<string, number>();
  for (const finding of before) {
    if (finding.suppressed === undefined)
      known.set(key(finding), (known.get(key(finding)) ?? 0) + 1);
  }
  const added: Finding[] = [];
  for (const finding of after) {
    if (finding.suppressed !== undefined) continue;
    const count = known.get(key(finding)) ?? 0;
    if (count > 0) known.set(key(finding), count - 1);
    else added.push(finding);
  }
  return added;
}

/** What the install writes and what the skill may run without asking. */
function planText(
  files: readonly SkillFile[],
  tools: readonly string[],
  target: string,
  dir: SkillDir,
  shown: (path: string) => string,
): string {
  const lines = [
    `Install the agentcheckup skill in ${shown(target)}:`,
    ...files.map((file) => `  ${shown(`${target}/${file.path}`)}`),
    `${readerList(skillReaders(dir))} load skills from ${SKILL_DIRECTORIES[dir]}.`,
    'Checked in memory with every rule: the skill adds no finding.',
  ];
  if (tools.length > 0) {
    lines.push('While the skill runs, Claude Code may use these without asking (allowed-tools):');
    for (const tool of tools) lines.push(`  ${forTerminal(tool)}`);
    lines.push('Every command that writes asks first.');
  }
  return `${lines.join('\n')}\n`;
}

/** The rules of the skill's `allowed-tools`. */
function allowedTools(text: string): string[] {
  const parsed = parseFrontmatter(text);
  if (parsed.kind !== 'valid') return [];
  const value = parsed.data.values['allowed-tools'];
  return typeof value === 'string' ? splitToolRules(value) : [];
}

/** Why the write did not apply, for stderr. */
function writeFailure(
  result: Exclude<FixWriteResult, { readonly status: 'applied' }>,
  shown: (path: string) => string,
): string {
  const where = result.path === undefined ? '' : `${shown(result.path)}: `;
  const undone =
    result.status === 'rolled-back'
      ? result.unrestored.length === 0
        ? ' The files written before were removed again.'
        : ` These could not be removed again: ${result.unrestored.map(shown).join(', ')}.`
      : '';
  return `${where}${forTerminal(result.detail)}.${undone}`;
}
