/**
 * Reads the `--policy` file. A policy decides whether a run fails, so it is read like every file
 * named on the command line (see read-file.ts): a regular file, not a symlink, bounded in size,
 * and parsed into null-prototype objects. src/policy validates what it says.
 *
 * The digest covers the file's bytes, so `shasum -a 256 policy.json` prints the digest that
 * reports show, and a reader can check which policy a run used.
 */
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { relativeInsideRoot } from './paths.js';
import { decodeTextInput, parseJsonInput, readInputBytes } from './read-file.js';

/** A policy is a short list of rules; this leaves room for long allowlists. */
export const POLICY_MAX_BYTES = 256 * 1024;

const LABEL = 'Policy file';

export interface PolicyFile {
  /** The parsed document, for parsePolicy. */
  readonly json: unknown;
  /** Lowercase hex SHA-256 of the file's bytes. */
  readonly sha256: string;
}

/**
 * Reads and parses the policy file at `filePath`, and hashes the bytes it parsed. Throws
 * InputFileError (exit 2) for a file that is missing, a symlink, not a regular file, larger than
 * {@link POLICY_MAX_BYTES}, unreadable, not UTF-8 or not JSON.
 */
export async function readPolicyFile(filePath: string): Promise<PolicyFile> {
  const bytes = await readInputBytes(filePath, { label: LABEL, maxBytes: POLICY_MAX_BYTES });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const json = parseJsonInput(decodeTextInput(bytes, filePath, LABEL), { label: LABEL });
  return { json, sha256 };
}

/**
 * Whether `filePath` lies inside the directory `root`, with symlinks resolved in both, so a
 * policy reached through a linked directory still counts as inside. A path that cannot be
 * resolved is compared as written. Only for a report note: it decides nothing about reading.
 */
export async function isInsideDirectory(filePath: string, root: string): Promise<boolean> {
  const [realFile, realRoot] = await Promise.all([resolveLinks(filePath), resolveLinks(root)]);
  return relativeInsideRoot(realRoot, realFile) !== undefined;
}

async function resolveLinks(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}
