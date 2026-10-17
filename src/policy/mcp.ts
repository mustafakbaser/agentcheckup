/**
 * What an MCP server runs, in the terms of a policy's allowlist, and whether an allowlist entry
 * matches it. Fails closed: a server whose package or version cannot be told matches nothing.
 */
import type { McpServerItem, PackageSpec } from '../inventory/types.js';
import { normalizeImage, pep440Core, pep503, semverCore } from './parse.js';
import type { AllowEntry } from './types.js';

/**
 * What a server runs:
 * - `package`: a package from npm or PyPI, or a container image, whose name is known. `version`
 *   is `''` when the command gives none.
 * - `local`: a script from the repository.
 * - `remote`: a server reached over the network; `origin` is its URL origin.
 * - `unknown`: the command cannot be read as a known launcher, or its package cannot be told.
 */
export type ServerTarget =
  | {
      readonly kind: 'package';
      readonly ecosystem: NonNullable<PackageSpec['ecosystem']>;
      readonly name: string;
      readonly version: string;
      readonly pin: PackageSpec['pin'];
    }
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'remote'; readonly origin: string }
  | { readonly kind: 'unknown' };

/** What `server` runs. A server with a command is judged by the package it runs, not by any `url`. */
export function serverTarget(server: McpServerItem): ServerTarget {
  const spec = server.package;
  if (spec !== undefined) {
    if (spec.pin === 'local') return { kind: 'local', path: spec.name ?? '' };
    if (spec.pin === 'unknown' || spec.ecosystem === undefined || spec.name === undefined) {
      return { kind: 'unknown' };
    }
    return {
      kind: 'package',
      ecosystem: spec.ecosystem,
      name: spec.name,
      version: spec.version ?? '',
      pin: spec.pin,
    };
  }
  if (server.url !== undefined) return { kind: 'remote', origin: server.url.origin };
  return { kind: 'unknown' };
}

type PackageTarget = Extract<ServerTarget, { kind: 'package' }>;

/** A package in allowlist form, with its exact version or digest when it is pinned to one. */
function packageForm(target: PackageTarget): string {
  const { name, version, pin } = target;
  switch (target.ecosystem) {
    case 'npm':
      return pin === 'exact' ? `npm:${name}@${semverCore(version)}` : `npm:${name}`;
    case 'pypi':
      return pin === 'exact'
        ? `pypi:${pep503(name)}==${pep440Core(version)}`
        : `pypi:${pep503(name)}`;
    case 'oci':
      return pin === 'digest'
        ? `oci:${normalizeImage(name)}@${version.toLowerCase()}`
        : `oci:${normalizeImage(name)}`;
  }
}

/**
 * The server in allowlist form: `npm:<name>`, `pypi:<name>`, `oci:<image>` (with the exact
 * version or digest when pinned to one), its origin, `local:<path>`, or `unknown`.
 */
export function allowForm(target: ServerTarget): string {
  switch (target.kind) {
    case 'package':
      return packageForm(target);
    case 'local':
      return `local:${target.path}`;
    case 'remote':
      return target.origin;
    case 'unknown':
      return 'unknown';
  }
}

/** Scheme, host and port of an origin, as the URL parser writes them; undefined when it fails. */
function originParts(
  origin: string,
): { readonly scheme: string; readonly host: string; readonly port: string } | undefined {
  if (!URL.canParse(origin)) return undefined;
  const url = new URL(origin);
  return { scheme: url.protocol.slice(0, -1), host: url.hostname, port: url.port };
}

/** True when `entry` allows the package `target`. */
function packageAllowed(entry: AllowEntry, target: PackageTarget): boolean {
  const { ecosystem, name, version, pin } = target;
  switch (entry.kind) {
    case 'npm':
      return (
        ecosystem === 'npm' &&
        name === entry.name &&
        (entry.version === undefined || (pin === 'exact' && semverCore(version) === entry.version))
      );
    case 'pypi':
      return (
        ecosystem === 'pypi' &&
        pep503(name) === entry.name &&
        (entry.version === undefined || (pin === 'exact' && pep440Core(version) === entry.version))
      );
    case 'oci':
      return (
        ecosystem === 'oci' &&
        normalizeImage(name) === entry.image &&
        (entry.digest === undefined || (pin === 'digest' && version.toLowerCase() === entry.digest))
      );
    case 'origin':
      return false;
  }
}

/**
 * True when `entry` allows a package or remote server. Package entries match by ecosystem and
 * name (PyPI names as PEP 503 normalizes them, images with Docker's defaults) and, when they give
 * one, by the exact version or digest the server pins. Origins match by scheme, host and port; a
 * `*.` entry matches every host below its suffix on a label boundary, never the suffix itself.
 */
export function entryAllows(entry: AllowEntry, target: ServerTarget): boolean {
  if (target.kind === 'package') return packageAllowed(entry, target);
  if (target.kind !== 'remote' || entry.kind !== 'origin') return false;
  const server = originParts(target.origin);
  if (server?.scheme !== entry.scheme || server.port !== entry.port) return false;
  if (!entry.wildcard) return server.host === entry.host;
  return server.host.endsWith(`.${entry.host}`);
}
