/**
 * Cursor's configuration files that run commands or let its agents do more without asking, as
 * Cursor documents them (checked 2026-11-18). Shared by the security inventory, the Cursor load
 * plan and risk/remote-script-execution. Pure.
 *
 * - `.cursor/worktrees.json` (SOURCES.cursorWorktrees): "`setup-worktree-unix`",
 *   "`setup-worktree-windows`" and "`setup-worktree`" each accept "An array of shell commands:
 *   executed sequentially in the worktree" or "A string filepath: path to a script file relative
 *   to `.cursor/worktrees.json`".
 * - `.cursor/environment.json` (SOURCES.cursorCloudAgentSetup, SOURCES.cursorCloudAgentBuilds):
 *   "Cursor runs the install script (`install` in `environment.json`) when it creates a Build";
 *   "After an agent boots from a Build, Cursor runs the `start` command and then any configured
 *   `terminals`"; `build.dockerfile` names a Dockerfile relative to `.cursor/`; and
 *   `repositoryDependencies`: "Anyone who can edit the file can add repos to every agent's git
 *   credentials". The shape of a `terminals` entry is not documented: agentcheckup reads objects
 *   with a string `command`, and a file with any other shape is not analyzed.
 * - `.cursor/cli.json` (SOURCES.cursorCliPermissions, SOURCES.cursorCliConfiguration):
 *   "Permissions are set in `~/.cursor/cli-config.json` (global) or `<project>/.cursor/cli.json`
 *   (project-specific)", and "Only permissions can be configured at the project level".
 * - `.cursor/sandbox.json` (SOURCES.cursorSandbox, SOURCES.cursorRunModes): "Applies to one
 *   project directory. Commit it when the project should share the same sandbox rules", and "the
 *   project file wins over `~/.cursor/sandbox.json`".
 * - `.cursor/permissions.json` (SOURCES.cursorPermissions): `mcpAllowlist`, `terminalAllowlist`
 *   and the Auto-review `autoRun.allow_instructions` and `autoRun.block_instructions`; "When both
 *   exist, Cursor concatenates the arrays inside every field".
 *
 * A known key whose value has a shape the documentation does not describe makes the file
 * incomplete (`complete: false`), so the gate fails closed on it.
 */
import { dirnamePosix, normalizeRelative } from '../core/paths.js';
import type { ArtifactKind } from '../core/types.js';
import { isObject, type JsonObject, type JsonPath, own } from '../parse/json-access.js';
import { hookInventoryIds } from './inventory-ids.js';

/** Kinds of the files this module reads. */
export const CURSOR_CONFIG_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'cursor-worktrees',
  'cursor-environment',
  'cursor-cli',
  'cursor-sandbox',
  'cursor-permissions',
]);

/** Kinds whose files declare commands Cursor runs on its own. */
export const CURSOR_COMMAND_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'cursor-worktrees',
  'cursor-environment',
]);

/** Kinds whose files declare permissions. `environment.json` grants repository access. */
export const CURSOR_PERMISSION_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'cursor-cli',
  'cursor-sandbox',
  'cursor-permissions',
  'cursor-environment',
]);

/**
 * Kinds whose agent is documented to ignore the file when it does not parse: "If neither file
 * is present, both are unparseable, or no file contains a given key, Cursor falls back to the
 * IDE allowlist for that key" (SOURCES.cursorPermissions).
 */
export const CURSOR_INERT_WHEN_INVALID: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'cursor-permissions',
]);

/** The setup keys of `.cursor/worktrees.json`, in the order the documentation lists them. */
export const WORKTREE_SETUP_KEYS = [
  'setup-worktree-unix',
  'setup-worktree-windows',
  'setup-worktree',
] as const;

/** One command Cursor runs from a configuration file. */
export interface CursorCommand {
  /** The key that declares it: a setup key, `install`, `start`, `terminals`, `build.dockerfile`. */
  readonly event: string;
  /** Path of the string in the document. */
  readonly path: JsonPath;
  /** The string as written: a command line, or the path of a script or Dockerfile. */
  readonly command: string;
  /** `command`: a shell command. `script`: a script file. `dockerfile`: a Dockerfile. */
  readonly type: 'command' | 'script' | 'dockerfile';
  /** For `script` and `dockerfile`: the root-relative path of the file, when it can be told. */
  readonly script?: string;
  /** What else decides what runs, for the digest: a Dockerfile's build context. */
  readonly detail?: unknown;
}

export interface CursorCommands {
  readonly commands: readonly CursorCommand[];
  /** False when a known key has a shape agentcheckup does not read. */
  readonly complete: boolean;
}

/** One permission value a Cursor configuration file sets. */
export interface CursorGrant {
  /** The JSON path of the list or setting, such as `permissions.allow` or `networkPolicy.deny`. */
  readonly key: string;
  readonly value: string;
  readonly path: JsonPath;
  /** True when the value grants everything of its kind ({@link cursorBroadCapability}). */
  readonly broad: boolean;
}

export interface CursorGrants {
  readonly grants: readonly CursorGrant[];
  readonly complete: boolean;
}

/**
 * Inventory ids of the commands of one file, in the hook format of src/platforms/inventory-ids.ts:
 * `hook:<file>#<event>:<digest of the redacted command>`, numbered where they repeat. The
 * inventory and the Cursor load plan both name them so.
 */
export function cursorCommandIds(file: string, commands: readonly CursorCommand[]): string[] {
  return hookInventoryIds(
    file,
    commands.map(({ event, command }) => ({ event, handler: { command } })),
  );
}

/** A path relative to the directory of `file`, or undefined when it is absolute or leaves the scan. */
function besideFile(file: string, relative: string): string | undefined {
  if (relative.startsWith('/') || relative.startsWith('~') || /^[a-z]:[\\/]/i.test(relative)) {
    return undefined;
  }
  const directory = dirnamePosix(file);
  return normalizeRelative(directory === '' ? relative : `${directory}/${relative}`);
}

/**
 * The commands of a `.cursor/worktrees.json` or `.cursor/environment.json` (`file` is its
 * root-relative path), in document order.
 */
export function cursorCommands(kind: ArtifactKind, file: string, root: unknown): CursorCommands {
  if (!isObject(root)) return { commands: [], complete: root === undefined };
  return kind === 'cursor-worktrees'
    ? worktreeCommands(file, root)
    : environmentCommands(file, root);
}

function worktreeCommands(file: string, root: JsonObject): CursorCommands {
  const commands: CursorCommand[] = [];
  let complete = true;
  for (const event of WORKTREE_SETUP_KEYS) {
    const value = own(root, event);
    if (value === undefined) continue;
    if (typeof value === 'string') {
      const script = besideFile(file, value);
      commands.push({
        event,
        path: [event],
        command: value,
        type: 'script',
        ...(script === undefined ? {} : { script }),
      });
    } else if (Array.isArray(value)) {
      (value as unknown[]).forEach((item, index) => {
        if (typeof item === 'string') {
          commands.push({ event, path: [event, index], command: item, type: 'command' });
        } else complete = false;
      });
    } else complete = false;
  }
  return { commands, complete };
}

function environmentCommands(file: string, root: JsonObject): CursorCommands {
  const commands: CursorCommand[] = [];
  let complete = true;
  for (const event of ['install', 'start']) {
    const value = own(root, event);
    if (value === undefined) continue;
    if (typeof value === 'string') {
      commands.push({ event, path: [event], command: value, type: 'command' });
    } else complete = false;
  }
  const terminals = own(root, 'terminals');
  if (Array.isArray(terminals)) {
    (terminals as unknown[]).forEach((terminal, index) => {
      const command = isObject(terminal) ? own(terminal, 'command') : undefined;
      if (typeof command === 'string') {
        commands.push({
          event: 'terminals',
          path: ['terminals', index, 'command'],
          command,
          type: 'command',
        });
      } else complete = false;
    });
  } else if (terminals !== undefined) complete = false;
  const build = own(root, 'build');
  if (isObject(build)) {
    const dockerfile = own(build, 'dockerfile');
    const context = own(build, 'context');
    if (typeof dockerfile === 'string') {
      const script = besideFile(file, dockerfile);
      commands.push({
        event: 'build.dockerfile',
        path: ['build', 'dockerfile'],
        command: dockerfile,
        type: 'dockerfile',
        ...(script === undefined ? {} : { script }),
        ...(context === undefined ? {} : { detail: { context } }),
      });
    } else if (dockerfile !== undefined) complete = false;
  } else if (build !== undefined) complete = false;
  return { commands, complete };
}

/**
 * The permission values of a Cursor configuration file that let an agent do more, or, for lists
 * whose last segment is `deny` or `block_instructions`, less. Values that only restrict, or that
 * are the documented default, are not listed:
 * - `.cursor/cli.json`: each string of `permissions.allow` and `permissions.deny`.
 * - `.cursor/sandbox.json`: `type` set to `insecure_none` ("disables the sandbox entirely"), each
 *   path in `additionalReadwritePaths`, `additionalReadonlyPaths` and `additionalReadPaths`,
 *   `readBoundary` set to `system` ("per-repo replaces per-user"), `networkPolicy.default` set to
 *   `allow`, each `networkPolicy.allow` and `networkPolicy.deny` pattern, and
 *   `enableSharedBuildCache` set to `true` (sandboxed and unsandboxed commands share caches).
 * - `.cursor/permissions.json`: each `mcpAllowlist` and `terminalAllowlist` entry, and each
 *   `autoRun.allow_instructions` and `autoRun.block_instructions` sentence.
 * - `.cursor/environment.json`: each `repositoryDependencies` entry.
 * A list that is not an array of strings is incomplete; permissions.json drops non-string entries
 * ("Non-string entries inside either array are silently dropped").
 */
export function cursorGrants(kind: ArtifactKind, root: unknown): CursorGrants {
  const grants: CursorGrant[] = [];
  let complete = true;
  if (!isObject(root)) return { grants, complete: root === undefined };
  const push = (path: readonly string[], value: string, index?: number): void => {
    const key = path.join('.');
    grants.push({
      key,
      value,
      path: index === undefined ? path : [...path, index],
      broad: cursorBroadCapability(kind, key, value) !== undefined,
    });
  };
  const list = (path: readonly string[], dropOthers = false): void => {
    let holder: unknown = root;
    for (const segment of path) holder = isObject(holder) ? own(holder, segment) : undefined;
    if (holder === undefined) return;
    if (!Array.isArray(holder)) {
      complete = false;
      return;
    }
    (holder as unknown[]).forEach((item, index) => {
      if (typeof item === 'string') push(path, item, index);
      else if (!dropOthers) complete = false;
    });
  };
  const object = (key: string): JsonObject | undefined => {
    const value = own(root, key);
    if (value !== undefined && !isObject(value)) complete = false;
    return isObject(value) ? value : undefined;
  };

  if (kind === 'cursor-cli') {
    if (object('permissions') !== undefined) {
      list(['permissions', 'allow']);
      list(['permissions', 'deny']);
    }
  } else if (kind === 'cursor-sandbox') {
    if (own(root, 'type') === 'insecure_none') push(['type'], 'insecure_none');
    for (const key of [
      'additionalReadwritePaths',
      'additionalReadonlyPaths',
      'additionalReadPaths',
    ]) {
      list([key]);
    }
    if (own(root, 'readBoundary') === 'system') push(['readBoundary'], 'system');
    const network = object('networkPolicy');
    if (network !== undefined) {
      if (own(network, 'default') === 'allow') push(['networkPolicy', 'default'], 'allow');
      list(['networkPolicy', 'allow']);
      list(['networkPolicy', 'deny']);
    }
    if (own(root, 'enableSharedBuildCache') === true) push(['enableSharedBuildCache'], 'true');
  } else if (kind === 'cursor-permissions') {
    list(['mcpAllowlist'], true);
    list(['terminalAllowlist'], true);
    if (object('autoRun') !== undefined) {
      list(['autoRun', 'allow_instructions'], true);
      list(['autoRun', 'block_instructions'], true);
    }
  } else if (kind === 'cursor-environment') {
    list(['repositoryDependencies']);
  }
  return { grants, complete };
}

/** `/`, `~` and their variants: a path that reaches every file of the machine or the user. */
function isRootOrHome(path: string): boolean {
  const text = path.trim();
  return text === '/' || text === '//' || text === '/**' || text === '~' || text === '~/';
}

/** Specifiers of a CLI permission token that match everything of their kind. */
const EVERY_PATH: ReadonlySet<string> = new Set(['**', '**/*', '/**', '/**/*']);

/**
 * What a broad Cursor permission value lets an agent do, for the gate summary, or undefined for a
 * value that is not broad:
 * - CLI tokens (SOURCES.cursorCliPermissions): `Shell(*)` and `Shell(*:*)` ("The `commandBase` is
 *   the first token in the command line. Supports glob patterns"), `Write(**)` and the like,
 *   `Mcp(*:*)` ("Allow all MCP tools (use with caution)") and `WebFetch(*)` ("Allow fetches from
 *   any domain (use with caution)").
 * - `mcpAllowlist` `*:*` ("All tools from all servers", SOURCES.cursorPermissions).
 * - sandbox.json (SOURCES.cursorSandbox): `type` `insecure_none`, `networkPolicy.default` `allow`
 *   and an extra path that is the file system root or the home directory.
 */
export function cursorBroadCapability(
  kind: ArtifactKind | undefined,
  key: string,
  value: string,
): string | undefined {
  if (kind === 'cursor-cli' && key === 'permissions.allow') {
    const open = value.indexOf('(');
    if (open === -1 || !value.endsWith(')')) return undefined;
    const tool = value.slice(0, open);
    const specifier = value.slice(open + 1, -1).trim();
    if (tool === 'Shell' && (specifier === '*' || specifier === '*:*')) {
      return 'runs any shell command';
    }
    if (tool === 'Write' && EVERY_PATH.has(specifier)) return 'writes any file';
    if (tool === 'Mcp' && specifier === '*:*') return 'runs any MCP tool';
    if (tool === 'WebFetch' && specifier === '*') return 'fetches from any domain';
    return undefined;
  }
  if (kind === 'cursor-permissions' && key === 'mcpAllowlist' && value.trim() === '*:*') {
    return 'runs any MCP tool';
  }
  if (kind !== 'cursor-sandbox') return undefined;
  if (key === 'type' && value === 'insecure_none') return 'turns the sandbox off';
  if (key === 'networkPolicy.default' && value === 'allow') {
    return 'any network access in the sandbox';
  }
  if (
    (key === 'additionalReadwritePaths' ||
      key === 'additionalReadonlyPaths' ||
      key === 'additionalReadPaths') &&
    isRootOrHome(value)
  ) {
    return 'the file system root or home directory';
  }
  return undefined;
}
