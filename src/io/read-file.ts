/**
 * Bounded reads of files named on the command line, such as the `--baseline` report. The file
 * may come from anywhere, including an earlier run on a hostile repository, so it is treated like
 * scanned content (docs/adr/0003):
 *
 * - The last path component must be a regular file, not a symlink, FIFO, device or directory.
 *   The open uses SAFE_OPEN_FLAGS and checks the opened file against the lstat-ed one, so a
 *   file swapped in between is caught (see readRegularFile).
 * - The size is bounded before and after opening.
 * - JSON is parsed into null-prototype objects, so no key (`__proto__`, `constructor`) can reach
 *   a prototype, and nesting is bounded.
 */
import type { BigIntStats } from 'node:fs';
import { lstat } from 'node:fs/promises';

import { errorCode } from './paths.js';
import { readRegularFile } from './safe-read.js';

/** A report from a scan of a very large repository stays far below this. */
export const DEFAULT_INPUT_MAX_BYTES = 64 * 1024 * 1024;

/** Objects and arrays nest at most this deep. A report nests fewer than ten levels. */
export const DEFAULT_JSON_MAX_DEPTH = 64;

/** A file named on the command line could not be read or parsed. The CLI exits with code 2. */
export class InputFileError extends Error {
  override readonly name = 'InputFileError';
}

export interface ReadInputOptions {
  /** How the file is named in error messages, such as `Baseline file`. */
  readonly label: string;
  /** Default {@link DEFAULT_INPUT_MAX_BYTES}. */
  readonly maxBytes?: number;
}

export interface ReadJsonOptions extends ReadInputOptions {
  /** Default {@link DEFAULT_JSON_MAX_DEPTH}. */
  readonly maxDepth?: number;
}

/**
 * Reads `filePath` as UTF-8 text, without a BOM. Throws {@link InputFileError} when the file is
 * missing, a symlink, not a regular file, larger than `maxBytes`, unreadable or not UTF-8.
 */
export async function readTextInput(filePath: string, options: ReadInputOptions): Promise<string> {
  const { label } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_INPUT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative integer, got ${String(maxBytes)}`);
  }
  let stats: BigIntStats;
  try {
    // bigint: the identity readRegularFile checks the opened file against (see FileIdentity).
    stats = await lstat(filePath, { bigint: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new InputFileError(`${label} not found: ${filePath}`, { cause: error });
    }
    throw new InputFileError(
      `Cannot read ${label.toLowerCase()} ${filePath}: ${code ?? 'unknown error'}`,
      {
        cause: error,
      },
    );
  }
  if (stats.isSymbolicLink()) {
    throw new InputFileError(
      `Refusing to read ${label.toLowerCase()} ${filePath}: it is a symbolic link, not a regular file.`,
    );
  }
  if (!stats.isFile()) {
    throw new InputFileError(
      `Refusing to read ${label.toLowerCase()} ${filePath}: it is not a regular file.`,
    );
  }
  const size = Number(stats.size);
  if (size > maxBytes) throw tooLarge(label, filePath, size, maxBytes);

  const outcome = await readRegularFile(filePath, stats, maxBytes);
  if (!outcome.ok) {
    switch (outcome.reason) {
      case 'too-large':
        throw tooLarge(label, filePath, outcome.size, maxBytes);
      case 'special-file':
        throw new InputFileError(
          `Refusing to read ${label.toLowerCase()} ${filePath}: it is not a regular file.`,
        );
      case 'unreadable':
        throw new InputFileError(
          `Cannot read ${label.toLowerCase()} ${filePath}: ${outcome.code ?? 'it changed while being read'}`,
        );
    }
  }
  try {
    // fatal: invalid UTF-8 is an error, not silently replaced text. The BOM is dropped.
    return new TextDecoder('utf-8', { fatal: true }).decode(outcome.bytes);
  } catch (error) {
    throw new InputFileError(`${label} ${filePath} is not valid UTF-8 text.`, { cause: error });
  }
}

/**
 * Reads and parses a JSON file: {@link readTextInput}, then {@link parseJsonInput}. The caller
 * validates the shape.
 */
export async function readJsonInput(filePath: string, options: ReadJsonOptions): Promise<unknown> {
  const text = await readTextInput(filePath, options);
  return parseJsonInput(text, options);
}

/**
 * Parses JSON into plain data whose objects have a null prototype. Throws
 * {@link InputFileError} for invalid JSON or nesting deeper than `maxDepth`. The parse error
 * names the position only, never the input text.
 */
export function parseJsonInput(text: string, options: ReadJsonOptions): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof SyntaxError ? positionOf(error.message) : '';
    throw new InputFileError(`${options.label} is not valid JSON${detail}.`, { cause: error });
  }
  return withNullPrototypes(value, options.maxDepth ?? DEFAULT_JSON_MAX_DEPTH, options.label);
}

/** `at position 12` from a JSON.parse message, or nothing. Input text in it is never echoed. */
function positionOf(message: string): string {
  const match = /\bposition (\d{1,12})\b/.exec(message);
  return match?.[1] === undefined ? '' : ` (at position ${match[1]})`;
}

type Container = Record<string, unknown> | unknown[];

interface Slot {
  readonly holder: Container;
  readonly key: string | number;
  readonly depth: number;
}

/**
 * Replaces every object in a JSON value by a null-prototype copy with the same own keys.
 * Iterative, with an explicit stack: input depth never reaches the call stack. Arrays stay
 * arrays. Each object is copied once, top-down, so the original tree becomes garbage while the
 * copy is built.
 */
function withNullPrototypes(value: unknown, maxDepth: number, label: string): unknown {
  const root: unknown[] = [value];
  const stack: Slot[] = [{ holder: root, key: 0, depth: 0 }];
  for (let slot = stack.pop(); slot !== undefined; slot = stack.pop()) {
    const { holder, key, depth } = slot;
    const current = read(holder, key);
    if (typeof current !== 'object' || current === null) continue;
    if (depth >= maxDepth) {
      throw new InputFileError(
        `${label} nests objects or arrays more than ${maxDepth} levels deep.`,
      );
    }
    if (Array.isArray(current)) {
      const items = current as unknown[];
      for (let index = items.length - 1; index >= 0; index--) {
        if (isContainer(items[index])) stack.push({ holder: items, key: index, depth: depth + 1 });
      }
      continue;
    }
    const source = current as Record<string, unknown>;
    const copy = Object.create(null) as Record<string, unknown>;
    for (const name of Object.keys(source)) {
      // defineProperty: `__proto__` becomes an ordinary own key, never a prototype.
      Object.defineProperty(copy, name, {
        value: source[name],
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (isContainer(source[name])) stack.push({ holder: copy, key: name, depth: depth + 1 });
    }
    write(holder, key, copy);
  }
  return root[0];
}

function isContainer(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function read(holder: Container, key: string | number): unknown {
  return Array.isArray(holder) ? holder[key as number] : holder[key as string];
}

function write(holder: Container, key: string | number, value: unknown): void {
  if (Array.isArray(holder)) holder[key as number] = value;
  else
    Object.defineProperty(holder, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
}

function tooLarge(label: string, filePath: string, size: number, maxBytes: number): InputFileError {
  return new InputFileError(
    `Refusing to read ${label.toLowerCase()} ${filePath}: ${size} bytes exceeds the ${maxBytes}-byte limit.`,
  );
}
