import { describe, expect, it } from 'vitest';

import {
  AGENT_CONFIG_DIRECTORIES,
  BINARY_SNIFF_BYTES,
  defaultIsCandidate,
  HARD_EXCLUDED_DIRECTORIES,
  isHardExcludedDirectory,
  looksBinary,
} from '../../src/io/filters.js';
import * as walkModule from '../../src/io/walk.js';
import { classify, isCandidateBasename } from '../../src/platforms/classify.js';

describe('isHardExcludedDirectory', () => {
  it('matches every listed entry, at any depth, with or without a trailing slash', () => {
    for (const entry of HARD_EXCLUDED_DIRECTORIES) {
      expect(isHardExcludedDirectory(entry)).toBe(true);
      expect(isHardExcludedDirectory(`${entry}/`)).toBe(true);
      expect(isHardExcludedDirectory(`packages/app/${entry}`)).toBe(true);
    }
  });

  it('matches whole names only, case-sensitively', () => {
    for (const relativePath of [
      'node_modules2',
      'my-node_modules',
      'Node_Modules',
      'x.claude/worktrees',
      '.claude',
      'worktrees',
      'src',
      '',
    ]) {
      expect(isHardExcludedDirectory(relativePath)).toBe(false);
    }
  });

  it('also answers for paths below an excluded directory', () => {
    expect(isHardExcludedDirectory('node_modules/pkg/src')).toBe(true);
    expect(isHardExcludedDirectory('.claude/worktrees/sub')).toBe(true);
  });

  it('does not exclude names below agent configuration, so nothing can hide there', () => {
    for (const relativePath of [
      '.claude/skills/build',
      '.claude/skills/pdf/node_modules',
      '.github/instructions/vendor',
      '.cursor/rules/dist',
      'skills/out',
      'packages/app/skills/demo/target',
      'tools/.agents/coverage',
    ]) {
      expect(isHardExcludedDirectory(relativePath)).toBe(false);
    }
    for (const name of AGENT_CONFIG_DIRECTORIES) {
      expect(isHardExcludedDirectory(`${name}/build`)).toBe(false);
      expect(isHardExcludedDirectory(`a/${name}/b/node_modules/`)).toBe(false);
    }
  });

  it('still applies exclusions above agent configuration, and .git and paths everywhere', () => {
    for (const relativePath of [
      'node_modules/pkg/.claude/skills/build',
      'build/.claude',
      'dist/skills/x',
      '.claude/skills/x/.git',
      '.claude/worktrees',
      'skills/.claude/worktrees/wt',
    ]) {
      expect(isHardExcludedDirectory(relativePath)).toBe(true);
    }
  });

  it('is the list walk.ts still exports', () => {
    expect(walkModule.HARD_EXCLUDED_DIRECTORIES).toBe(HARD_EXCLUDED_DIRECTORIES);
  });
});

describe('looksBinary', () => {
  it('finds a NUL byte within the first 8000 bytes only', () => {
    expect(BINARY_SNIFF_BYTES).toBe(8000);
    const at = (index: number): Uint8Array => {
      const bytes = new Uint8Array(index + 1).fill(0x61);
      bytes[index] = 0;
      return bytes;
    };
    expect(looksBinary(new Uint8Array())).toBe(false);
    expect(looksBinary(new TextEncoder().encode('# plain text ş'))).toBe(false);
    expect(looksBinary(at(0))).toBe(true);
    expect(looksBinary(at(BINARY_SNIFF_BYTES - 1))).toBe(true);
    expect(looksBinary(at(BINARY_SNIFF_BYTES))).toBe(false);
  });

  it('never calls UTF-16 text with a byte order mark binary', () => {
    expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe(false);
    expect(looksBinary(new Uint8Array([0xfe, 0xff, 0x00, 0x41]))).toBe(false);
    expect(looksBinary(new Uint8Array([0xff, 0x00]))).toBe(true);
    expect(looksBinary(new Uint8Array([0xff]))).toBe(false);
  });
});

describe('defaultIsCandidate', () => {
  it('accepts the files classify() recognizes and nothing else', () => {
    const accepted = [
      'AGENTS.md',
      'Agents.md',
      'a/b/CLAUDE.md',
      '.claude/settings.json',
      '.cursor/rules/style.mdc',
      '.cursorrules',
      '.mcp.json',
      'skills/x/SKILL.md',
    ];
    const rejected = ['README.md', 'package.json', 'src/index.ts', '.claude/notes.txt', 'mdc'];
    for (const relativePath of accepted) expect(defaultIsCandidate(relativePath)).toBe(true);
    for (const relativePath of rejected) expect(defaultIsCandidate(relativePath)).toBe(false);
    for (const relativePath of [...accepted, ...rejected]) {
      const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
      expect(defaultIsCandidate(relativePath)).toBe(
        isCandidateBasename(name) && classify(relativePath) !== undefined,
      );
    }
  });
});
