import { describe, expect, it } from 'vitest';
import { parseCommand, UsageError } from '../../src/cli/args.js';
import { pinnedVersions, SKILL_FILES, withVersion } from '../../src/cli/skill.js';
import { splitToolRules } from '../../src/platforms/permissions.js';
import { releasePleaseBump } from '../helpers/release-please.js';
import {
  bodyOf,
  frontmatterOf,
  listFiles,
  packageVersion,
  SKILL_DIR,
  skillText,
} from './helpers.js';

/** The pinned prefix of every agentcheckup command the skill runs. */
function prefix(version: string): string {
  return `npx agentcheckup@${version} `;
}

describe('the agentcheckup skill', () => {
  it('has exactly the files the installer copies', async () => {
    expect(await listFiles(SKILL_DIR)).toEqual([...SKILL_FILES].sort());
  });

  it('has a portable frontmatter with a "Use when" description', async () => {
    const values = frontmatterOf(await skillText());
    expect(Object.keys(values)).toEqual(['name', 'description', 'license', 'allowed-tools']);
    expect(values['name']).toBe('agentcheckup');
    expect(values['license']).toBe('MIT');
    const description = values['description'];
    expect(typeof description).toBe('string');
    expect(description).toContain(' Use when ');
    expect((description as string).length).toBeLessThanOrEqual(1024);
  });

  it('pre-approves only exact read-only commands pinned to the package version', async () => {
    const version = await packageVersion();
    const tools = frontmatterOf(await skillText())['allowed-tools'];
    expect(typeof tools).toBe('string');
    expect(splitToolRules(tools as string)).toEqual([
      `Bash(${prefix(version)}tasks --format json)`,
      `Bash(${prefix(version)}fix)`,
      `Bash(${prefix(version)}context)`,
      `Bash(${prefix(version)}tokens)`,
      `Bash(${prefix(version)}tasks --check *)`,
      'Read',
    ]);
  });

  it('pins every command to the package version, so no placeholder ships', async () => {
    const version = await packageVersion();
    const skill = await skillText();
    expect(pinnedVersions(skill).length).toBeGreaterThan(10);
    expect(new Set(pinnedVersions(skill))).toEqual(new Set([version]));
    // Only SKILL.md is in release-please's extra-files: the references pin nothing.
    for (const path of SKILL_FILES.filter((file) => file !== 'SKILL.md')) {
      expect(pinnedVersions(await skillText(path)), path).toEqual([]);
    }
  });

  it('lets release-please bump every pinned version and nothing else', async () => {
    const skill = await skillText();
    const bumped = releasePleaseBump(skill, '98.76.54');
    expect(bumped).not.toBe(skill);
    expect(bumped).toBe(withVersion(skill, '98.76.54'));
    expect(releasePleaseBump(skill, '1.0.0-rc.1')).toBe(withVersion(skill, '1.0.0-rc.1'));
  });

  it('runs without asking only commands that cannot write', async () => {
    const version = await packageVersion();
    const allowed = splitToolRules(frontmatterOf(await skillText())['allowed-tools'] as string)
      .filter((rule) => rule.startsWith(`Bash(${prefix(version)}`))
      .map((rule) => rule.slice(`Bash(${prefix(version)}`.length, -1));
    for (const rule of allowed) {
      const args = rule.split(' ').filter((arg) => arg !== '*');
      const command = parseCommand(args);
      if (command.kind === 'fix') {
        expect(command.options.write || command.options.interactive).toBe(false);
        expect(command.options.output).toBeUndefined();
      } else if (
        command.kind === 'tasks' ||
        command.kind === 'context' ||
        command.kind === 'tokens'
      ) {
        expect(command.options.output).toBeUndefined();
      } else {
        throw new Error(`unexpected command ${command.kind} for ${rule}`);
      }
    }
    // `tasks --check *` is safe only because --check takes no option but ids and one path.
    for (const extra of [
      ['--output', 'x.md'],
      ['-o', 'x.md'],
      ['--format', 'json'],
      ['--rule', 'skill/name-format'],
      ['--max', '1'],
      ['--untrusted'],
      ['--write'],
      ['--config', 'x.json'],
      ['--no-gitignore'],
    ]) {
      expect(() => parseCommand(['tasks', '--check', 'ac-12345678', ...extra]), extra[0]).toThrow(
        UsageError,
      );
    }
  });

  it('asks before every command it is not allowed to run, and those are the writes', async () => {
    const version = await packageVersion();
    const skill = await skillText();
    const allowed = splitToolRules(frontmatterOf(skill)['allowed-tools'] as string)
      .filter((rule) => rule.startsWith('Bash('))
      .map((rule) => rule.slice('Bash('.length, -1));
    const approved = (command: string): boolean =>
      allowed.some((rule) =>
        rule.endsWith(' *')
          ? command === rule.slice(0, -2) || command.startsWith(rule.slice(0, -1))
          : command === rule,
      );
    const commands = bodyOf(skill)
      .split('\n')
      .filter((line) => line.startsWith(prefix(version)));
    expect(commands.length).toBeGreaterThan(5);
    for (const command of commands) {
      if (!approved(command)) expect(command, command).toContain(' --write');
      expect(command).not.toContain(' -i');
      expect(command).not.toContain('--output');
    }
  });

  it('keeps the body short and links each reference one level deep', async () => {
    const skill = await skillText();
    const body = bodyOf(skill);
    expect(body.split('\n').length).toBeLessThanOrEqual(200);
    // About 1,800 tokens at four characters per token.
    expect(Math.ceil(skill.length / 4)).toBeLessThanOrEqual(2200);
    for (const path of SKILL_FILES.filter((file) => file !== 'SKILL.md')) {
      expect(body).toContain(`](${path})`);
      // References link to nothing, so no chain goes deeper.
      expect(await skillText(path), path).not.toMatch(/\]\([^)]*\)/);
    }
  });
});
