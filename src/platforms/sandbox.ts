/**
 * The `sandbox` settings of a Claude Code settings file that widen what sandboxed or unsandboxed
 * Bash commands may do, or what runs without a prompt, for the security inventory. Values that
 * only restrict the sandbox (`denyRead`, `denyWrite`, `deniedDomains`, `credentials` entries) are
 * not listed, nor is `ignoreViolations`: "The sandbox still blocks the access; only the report is
 * suppressed". Pure.
 *
 * Every key below has the scope "Any file" in the settings reference, unless it says otherwise
 * (SOURCES.claudeSettingsReference, "Sandbox settings", checked 2026-11-18), and the sandboxing
 * page lists the keys that loosen the sandbox, which Claude Code ignores in a repository's files
 * only while the sandbox is admin-required by managed settings or `--settings`
 * (SOURCES.claudeSandboxing, "Repository settings under an admin-required sandbox"). The
 * repository cannot show that, so they are listed as effective.
 */
import { isTable, type JsonPath, own, type SpannedDocument } from '../parse/json-access.js';

/** One sandbox setting, as the inventory lists it: a permission `key` = `value`. */
export interface SandboxGrant {
  /** `sandbox.<name>`, `sandbox.filesystem.<name>` or `sandbox.network.<name>`. */
  readonly key: string;
  readonly value: string;
  readonly path: JsonPath;
  /** It opens everything of its kind, such as every host or the home directory. */
  readonly broad: boolean;
  /** False where Claude Code ignores the value in project and local settings. */
  readonly effective: boolean;
}

/**
 * Boolean keys and the value that widens. `effective: false` for keys whose scope is "User or
 * managed": Claude Code "ignores a `true` in a project's `.claude/settings.json` or
 * `.claude/settings.local.json`" for `allowNestedUserNamespaces`, and the same scope applies to
 * `allowAppleEvents` and `filesystem.disabled`.
 */
const SWITCHES: readonly {
  readonly path: readonly string[];
  readonly widens: boolean;
  readonly broad: boolean;
  readonly effective: boolean;
}[] = [
  // "`false`: Bash commands run unsandboxed": a project's `false` beats a user's `true`, which
  // the admin-required table names as a setting Claude Code otherwise takes from the repository.
  { path: ['enabled'], widens: false, broad: true, effective: true },
  // "`false`: Claude Code runs commands unsandboxed when the sandbox can't start".
  { path: ['failIfUnavailable'], widens: false, broad: false, effective: true },
  // "`true`: Claude Code runs sandboxed Bash commands without a permission prompt".
  { path: ['autoAllowBashIfSandboxed'], widens: true, broad: true, effective: true },
  // "`true`: Claude can retry a command outside the sandbox with the `dangerouslyDisableSandbox`
  // parameter after the sandbox blocks it". The default, but a project's `true` beats its own
  // `false` in `settings.json` from `settings.local.json`.
  { path: ['allowUnsandboxedCommands'], widens: true, broad: false, effective: true },
  // "This reduces security", and "a potential data exfiltration path through the trust service".
  { path: ['enableWeakerNestedSandbox'], widens: true, broad: false, effective: true },
  { path: ['enableWeakerNetworkIsolation'], widens: true, broad: false, effective: true },
  // "User or managed".
  { path: ['allowAppleEvents'], widens: true, broad: false, effective: false },
  { path: ['allowNestedUserNamespaces'], widens: true, broad: false, effective: false },
  { path: ['filesystem', 'disabled'], widens: true, broad: false, effective: false },
  // "Let sandboxed commands connect to every Unix socket".
  { path: ['network', 'allowAllUnixSockets'], widens: true, broad: true, effective: true },
  // "listen on network ports … and connect to any port on localhost" on macOS.
  { path: ['network', 'allowLocalBinding'], widens: true, broad: false, effective: true },
];

/** List keys whose every entry widens, and which entries open everything of their kind. */
const LISTS: readonly {
  readonly path: readonly string[];
  readonly broad: (entry: string) => boolean;
}[] = [
  // "Name commands that Claude Code runs outside the sandbox"; `*` matches every command.
  { path: ['excludedCommands'], broad: isWildcard },
  // "Add paths where sandboxed commands can write".
  { path: ['filesystem', 'allowWrite'], broad: isRootOrHome },
  // "Re-open reading for specific paths inside a region that `denyRead` blocks".
  { path: ['filesystem', 'allowRead'], broad: isRootOrHome },
  // "Pre-allow domains for outbound traffic from sandboxed commands, so the sandbox doesn't
  // prompt for them".
  { path: ['network', 'allowedDomains'], broad: isWildcard },
  // "A socket path can grant broad access: allowing `/var/run/docker.sock`, for example, lets a
  // sandboxed command control the Docker daemon".
  { path: ['network', 'allowUnixSockets'], broad: () => false },
  { path: ['network', 'allowMachLookup'], broad: isWildcard },
];

/**
 * Proxy ports: "Once either port applies, your proxy is responsible for filtering everything sent
 * to it. Claude Code's own network controls, such as `allowedDomains`, … stop applying to that
 * traffic" (SOURCES.claudeSandboxing, "Custom proxy configuration"), so each is broad.
 */
const PORTS: readonly (readonly string[])[] = [
  ['network', 'httpProxyPort'],
  ['network', 'socksProxyPort'],
];

/** The widening sandbox settings of a Claude Code settings file, in a fixed order. */
export function sandboxGrants(doc: SpannedDocument): SandboxGrant[] {
  const root = doc.value;
  const sandbox = isTable(root) ? own(root, 'sandbox') : undefined;
  if (!isTable(sandbox)) return [];
  const out: SandboxGrant[] = [];
  const at = (path: readonly string[]): unknown => {
    let value: unknown = sandbox;
    for (const segment of path) value = isTable(value) ? own(value, segment) : undefined;
    return value;
  };
  const keyOf = (path: readonly string[]): string => ['sandbox', ...path].join('.');
  for (const { path, widens, broad, effective } of SWITCHES) {
    if (at(path) !== widens) continue;
    const grant = { key: keyOf(path), value: String(widens), path: ['sandbox', ...path] };
    out.push({ ...grant, broad, effective });
  }
  for (const { path, broad } of LISTS) {
    const entries = at(path);
    if (!Array.isArray(entries)) continue;
    (entries as readonly unknown[]).forEach((entry, index) => {
      if (typeof entry !== 'string') return;
      out.push({
        key: keyOf(path),
        value: entry,
        path: ['sandbox', ...path, index],
        broad: broad(entry),
        effective: true,
      });
    });
  }
  for (const path of PORTS) {
    const port = at(path);
    if (typeof port !== 'number' && typeof port !== 'string') continue;
    out.push({
      key: keyOf(path),
      value: String(port),
      path: ['sandbox', ...path],
      broad: true,
      effective: true,
    });
  }
  return out;
}

/**
 * True when a settings file turns the sandbox on without choosing `autoAllowBashIfSandboxed`.
 * Before Claude Code v2.1.325 that key defaulted to `true`, so such a file made every sandboxed
 * Bash command run without a prompt: "Changed sandboxed Bash commands to follow the normal
 * permission flow by default" (SOURCES.claudeChangelog, 2.1.325; the settings reference says
 * "Before v2.1.324, the default was `true`").
 */
export function enablesLegacyAutoAllow(doc: SpannedDocument): boolean {
  const root = doc.value;
  const sandbox = isTable(root) ? own(root, 'sandbox') : undefined;
  return (
    isTable(sandbox) &&
    own(sandbox, 'enabled') === true &&
    typeof own(sandbox, 'autoAllowBashIfSandboxed') !== 'boolean'
  );
}

function isWildcard(entry: string): boolean {
  const text = entry.trim();
  return text === '*' || text === '**';
}

/** `/`, `//`, `~` and `~/`: every file of the machine or of the user. */
function isRootOrHome(path: string): boolean {
  const text = path.trim();
  return text === '/' || text === '//' || text === '~' || text === '~/';
}
