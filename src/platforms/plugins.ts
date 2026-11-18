/**
 * Plugin settings a repository's settings file declares: `enabledPlugins`, which turns plugins on
 * or off, and `extraKnownMarketplaces`, which registers marketplaces. Shared by the security
 * inventory for Claude Code's `.claude/settings.json` and `.claude/settings.local.json`, which the
 * GitHub Copilot CLI and Copilot cloud read too, and for Copilot's own repository settings. Pure.
 *
 * - Claude Code: `enabledPlugins` is an "object mapping `plugin-name@marketplace-name` to a
 *   Boolean", in "Any file"; "Project settings take precedence over user settings, so setting a
 *   plugin to `false` in `~/.claude/settings.json` doesn't disable a plugin that the project's
 *   `.claude/settings.json` enables". `extraKnownMarketplaces` registers "each marketplace it
 *   doesn't already know", after the workspace trust dialog; `additionalMarketplaces` is its
 *   alias, and "If you set both spellings in one file, Claude Code uses the canonical value and
 *   ignores the alias" (SOURCES.claudeSettingsReference, checked 2026-11-18).
 * - Copilot CLI: "The CLI also reads `.claude/settings.json` and `.claude/settings.local.json` for
 *   the shared cross-tool subset of repository settings (such as … `enabledPlugins`,
 *   `extraKnownMarketplaces`, and `hooks`)", where `enabledPlugins` is "Declarative plugin
 *   auto-install", and "The plugin-related keys … are also read by Copilot in the cloud"
 *   (SOURCES.copilotCliConfigDir, checked 2026-11-18).
 */
import { isTable, type JsonPath, own, type SpannedDocument } from '../parse/json-access.js';

/** One plugin setting, as the inventory lists it: a permission `key` = `value`. */
export interface PluginSettingItem {
  /** `enabledPlugins.<plugin>` or `extraKnownMarketplaces.<name>`, whichever spelling is read. */
  readonly key: string;
  /** `true` or `false` for a plugin; the marketplace's source, unredacted ({@link marketplaceSourceShown}). */
  readonly value: string;
  /** Where the entry is in the file. */
  readonly path: JsonPath;
  /** For a marketplace: its raw `source` value, which the caller redacts before digesting it. */
  readonly source?: unknown;
  /**
   * For a marketplace: its `autoUpdate` when it is a Boolean. `true` makes Claude Code "refresh
   * that marketplace and update its installed plugins in the background after startup".
   */
  readonly autoUpdate?: boolean;
}

const ENABLED_PLUGINS = 'enabledPlugins';
const MARKETPLACES = 'extraKnownMarketplaces';

/**
 * The plugin settings of a settings file, in document order: each `enabledPlugins` entry with a
 * Boolean value, then each `extraKnownMarketplaces` entry that is an object. With
 * `marketplaceAlias`, that key is read too, only when the file has no `extraKnownMarketplaces`;
 * its entries keep the canonical key, so renaming the key changes no item.
 */
export function pluginSettingItems(
  doc: SpannedDocument,
  options: { readonly marketplaceAlias?: string } = {},
): PluginSettingItem[] {
  const root = doc.value;
  if (!isTable(root)) return [];
  const out: PluginSettingItem[] = [];
  const plugins = own(root, ENABLED_PLUGINS);
  if (isTable(plugins)) {
    for (const name of Object.keys(plugins)) {
      const value = plugins[name];
      if (typeof value !== 'boolean') continue;
      out.push({
        key: `${ENABLED_PLUGINS}.${name}`,
        value: String(value),
        path: [ENABLED_PLUGINS, name],
      });
    }
  }
  const { marketplaceAlias } = options;
  const at =
    own(root, MARKETPLACES) === undefined && marketplaceAlias !== undefined
      ? marketplaceAlias
      : MARKETPLACES;
  const marketplaces = own(root, at);
  if (isTable(marketplaces)) {
    for (const name of Object.keys(marketplaces)) {
      const entry = marketplaces[name];
      if (!isTable(entry)) continue;
      const source = own(entry, 'source');
      const autoUpdate = own(entry, 'autoUpdate');
      out.push({
        key: `${MARKETPLACES}.${name}`,
        value: marketplaceSourceShown(source),
        path: [at, name],
        source,
        ...(typeof autoUpdate === 'boolean' ? { autoUpdate } : {}),
      });
    }
  }
  return out;
}

/** The longest source value shown, before the caller's redaction. */
const MAX_SHOWN = 200;

/**
 * A marketplace's source in short form: `github:<repo>`, `git:<url>`, `url:<url>`,
 * `file:<path>`, `directory:<path>`, `settings:<name>`, or `unknown` for another shape. The
 * source types are those of the settings reference ("Marketplace source types"). The value is
 * not redacted: callers redact it as they redact every shown value.
 */
export function marketplaceSourceShown(source: unknown): string {
  if (!isTable(source)) return 'unknown';
  const type = own(source, 'source');
  const field =
    type === 'github'
      ? 'repo'
      : type === 'git' || type === 'url'
        ? 'url'
        : type === 'file' || type === 'directory'
          ? 'path'
          : type === 'settings'
            ? 'name'
            : undefined;
  if (typeof type !== 'string' || field === undefined) return 'unknown';
  const value = own(source, field);
  if (typeof value !== 'string') return type;
  return `${type}:${value.length > MAX_SHOWN ? `${value.slice(0, MAX_SHOWN)}…` : value}`;
}

/** True for a permission key of {@link pluginSettingItems}, whatever the name after the dot. */
export function isPluginSettingKey(key: string): boolean {
  return key.startsWith(`${ENABLED_PLUGINS}.`) || key.startsWith(`${MARKETPLACES}.`);
}
