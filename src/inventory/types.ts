/**
 * Security inventory: every MCP server, hook, permission and environment override that the
 * repository configures, in configuration files and in the frontmatter of Claude Code skills,
 * commands and subagents, whether or not an agent loads it today. Unlike a load plan it does not
 * depend on the working directory. Load entries point to items through `LoadEntry.inventoryId`.
 * Pure data. See docs/adr/0007-model-what-each-agent-loads.md.
 *
 * The inventory never holds credential values. MCP `env` and `headers` keep names only,
 * secret-looking arguments are redacted, and endpoint values are cut to their URL origin.
 */
import type { PlatformId } from '../core/types.js';

export interface Inventory {
  readonly mcpServers: readonly McpServerItem[];
  readonly hooks: readonly HookItem[];
  readonly permissions: readonly PermissionItem[];
  readonly env: readonly EnvItem[];
  /**
   * Config files that could not be analyzed, so items may be missing: files in Cline's
   * `.clinerules/hooks/`, `.cline/hooks/` and `.cline/plugins/` (no documented format),
   * Cascade's `.devin/hooks.json`, a `.codex/config.toml` past a parser limit or in UTF-16, a
   * skill, command or subagent whose frontmatter is past a parser limit, files the walk skipped,
   * `invalid-json:<path>` and `invalid-toml:<path>`.
   */
  readonly incomplete: readonly string[];
}

/** Fields every inventory item has. */
interface ItemBase {
  /**
   * Stable identity, relative to the scan root, used to match items against a baseline:
   * `mcp:<file>#<name>`, `hook:<file>#<event>:<digest of command>` (plus an occurrence number
   * for repeats), `perm:<file>#<key>=<value>`, `env:<file>#<key>`.
   */
  readonly id: string;
  /** The config file that declares the item. */
  readonly file: string;
  /** 1-based line of the declaration. */
  readonly line: number;
  /** Agents that read `file`. */
  readonly platforms: readonly PlatformId[];
  /**
   * hash53 of the canonical entry, values included. Same id with a different digest means the
   * item changed.
   */
  readonly digest: string;
}

/**
 * How an MCP server's code is fetched. Pin:
 * - `exact`: one exact version, such as `1.4.0`.
 * - `digest`: a content digest, such as an OCI `sha256:` digest.
 * - `range`: a version range, such as `^1.4.0`.
 * - `tag`: a moving tag, such as `latest` or an image tag.
 * - `none`: no version, so the newest one runs.
 * - `local`: a path inside the repository.
 * - `unknown`: the command could not be read as a known launcher.
 */
export interface PackageSpec {
  readonly launcher:
    'npx' | 'pnpm-dlx' | 'bunx' | 'yarn-dlx' | 'uvx' | 'pipx' | 'docker' | 'local' | 'unknown';
  readonly ecosystem?: 'npm' | 'pypi' | 'oci';
  readonly name?: string;
  readonly version?: string;
  readonly pin: 'exact' | 'digest' | 'range' | 'tag' | 'none' | 'local' | 'unknown';
}

/** One MCP server entry. */
export interface McpServerItem extends ItemBase {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse' | 'ws' | 'unknown';
  /** The `type` value as written, when present. */
  readonly declaredType?: string;
  readonly command?: string;
  /** Secret-looking arguments are redacted. */
  readonly args?: readonly string[];
  readonly package?: PackageSpec;
  /** For remote servers: origin only, never the path or query. */
  readonly url?: { readonly origin: string; readonly tls: boolean; readonly loopback: boolean };
  /** Names only, never values. */
  readonly envKeys: readonly string[];
  /** Names only, never values. */
  readonly headerKeys: readonly string[];
  /** What each agent that reads `file` does with the server today. */
  readonly status: Readonly<Partial<Record<PlatformId, 'loads' | 'needs-approval' | 'skipped'>>>;
  /**
   * `subagent` for a server declared in a subagent's frontmatter, which connects only while that
   * subagent runs. Absent for a server in a configuration file.
   */
  readonly scope?: 'subagent';
}

/** One hook command. */
export interface HookItem extends ItemBase {
  readonly event: string;
  /** False when the event name is not a documented event, so the hook never runs. */
  readonly known: boolean;
  readonly matcher?: string;
  readonly type?: string;
  readonly command?: string;
  /** The repository script the command runs, when it can be told. */
  readonly script?: string;
  /** True when an error or timeout in the hook lets the action go ahead. */
  readonly failsOpen: boolean;
  /** True when the command downloads and runs a script. */
  readonly remoteScript: boolean;
  /**
   * Where a hook declared in frontmatter applies. `subagent`: only while that subagent runs.
   * `skill`: from the turn a skill or command is invoked to the end of the session. Absent for a
   * hook in a configuration file, which applies to every session.
   */
  readonly scope?: 'subagent' | 'skill';
}

/**
 * One permission value, such as `permissions.allow` = `Bash(curl:*)`. Keys:
 * `permissions.allow`, `ask`, `deny`, `defaultMode`, `additionalDirectories`,
 * `enableAllProjectMcpServers`, `enabledMcpjsonServers`, the `allowed-tools` of a skill or
 * command, a subagent's `permissionMode`, the `agent` every Claude Code session starts as,
 * Gemini CLI trust, and Codex's `approval_policy`, `sandbox_mode`,
 * `sandbox_workspace_write.network_access`, `sandbox_workspace_write.writable_roots` and MCP tool
 * approval modes (`mcp_servers.<name>.default_tools_approval_mode`,
 * `mcp_servers.<name>.tools.<tool>.approval_mode`).
 */
export interface PermissionItem extends ItemBase {
  readonly key: string;
  readonly value: string;
  /** True when the value grants wide access, such as any shell command. */
  readonly broad: boolean;
  /** False when the agent ignores the value where it is set. */
  readonly effective: boolean;
}

/**
 * One environment override: settings `env`, a settings key that runs a command (such as
 * `apiKeyHelper`), or a sensitive name in an MCP server's `env`. Class:
 * - `endpoint`: sends traffic elsewhere, such as `ANTHROPIC_BASE_URL` or a proxy.
 * - `credential`: holds a secret.
 * - `tls`: changes certificate checks.
 * - `code-exec`: makes the agent or its runtime run code.
 * - `other`: none of the above.
 */
export interface EnvItem extends ItemBase {
  readonly key: string;
  readonly class: 'endpoint' | 'credential' | 'tls' | 'code-exec' | 'other';
  /**
   * For `endpoint`, the URL origin. For `tls`, the value when it is an on/off switch (0, 1, true,
   * false, yes, no). Never set otherwise: other values may be secrets.
   */
  readonly shown?: string;
}
