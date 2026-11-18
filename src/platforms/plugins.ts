/**
 * Plugin settings a repository's settings file declares: `enabledPlugins` (plugin specs turned on
 * or off) and `extraKnownMarketplaces` (marketplaces registered for the repository). Claude Code's
 * `.claude/settings.json` and the Copilot CLI's `.github/copilot/settings.json` share the format
 * (SOURCES.copilotCliConfigDir: "Declarative plugin auto-install"; SOURCES.vscodeAgentPlugins).
 * Pure: it reads only the parsed document. The security inventory lists each entry as a
 * permission, so the gate sees a plugin or a marketplace added or changed.
 */
import { isTable, type JsonPath, own, type SpannedDocument } from '../parse/json-access.js';

/** One plugin setting: its permission key, its value as reports show it, where it is. */
export interface PluginSettingItem {
  /** `enabledPlugins.<spec>` or `extraKnownMarketplaces.<name>`. */
  readonly key: string;
  /**
   * `true` or `false` for a plugin; for a marketplace the short form of its source
   * ({@link marketplaceSourceShown}), not redacted yet.
   */
  readonly value: string;
  readonly path: JsonPath;
  /** For a marketplace: the raw `source` value, which the item's digest covers once redacted. */
  readonly source?: unknown;
  /** For a marketplace: its `autoUpdate`, when it is a boolean. */
  readonly autoUpdate?: boolean;
}

/**
 * The plugin settings of `doc`: each `enabledPlugins` entry with a boolean value, then each
 * `extraKnownMarketplaces` entry whose value is an object. With `marketplaceAlias`, the alias key
 * is read when the canonical key is absent; keys are still `extraKnownMarketplaces.<name>`.
 */
export function pluginSettingItems(
  doc: SpannedDocument,
  options: { readonly marketplaceAlias?: string } = {},
): PluginSettingItem[] {
  const root = doc.value;
  if (!isTable(root)) return [];
  const items: PluginSettingItem[] = [];
  const plugins = own(root, 'enabledPlugins');
  if (isTable(plugins)) {
    for (const name of Object.keys(plugins)) {
      const value = plugins[name];
      if (typeof value !== 'boolean') continue;
      items.push({
        key: `enabledPlugins.${name}`,
        value: String(value),
        path: ['enabledPlugins', name],
      });
    }
  }
  const alias = options.marketplaceAlias;
  const canonical = own(root, 'extraKnownMarketplaces');
  const [field, marketplaces] =
    canonical === undefined && alias !== undefined
      ? [alias, own(root, alias)]
      : ['extraKnownMarketplaces', canonical];
  if (isTable(marketplaces)) {
    for (const name of Object.keys(marketplaces)) {
      const entry = marketplaces[name];
      if (!isTable(entry)) continue;
      const source = own(entry, 'source');
      const autoUpdate = own(entry, 'autoUpdate');
      items.push({
        key: `extraKnownMarketplaces.${name}`,
        value: marketplaceSourceShown(source),
        path: [field, name],
        source,
        ...(typeof autoUpdate === 'boolean' ? { autoUpdate } : {}),
      });
    }
  }
  return items;
}

/**
 * A marketplace source in short form, not redacted: `github:<repo>`, `git:<url>`, `url:<url>`,
 * `file:<path>`, `directory:<path>`, `settings:<name>`, or `unknown` for any other shape.
 */
export function marketplaceSourceShown(source: unknown): string {
  if (!isTable(source)) return 'unknown';
  const kind = own(source, 'source');
  const field = (key: string): string | undefined => {
    const value = own(source, key);
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };
  const shown = (prefix: string, value: string | undefined): string =>
    value === undefined ? 'unknown' : `${prefix}:${value}`;
  switch (kind) {
    case 'github':
      return shown('github', field('repo'));
    case 'git':
      return shown('git', field('url'));
    case 'url':
      return shown('url', field('url'));
    case 'file':
      return shown('file', field('path'));
    case 'directory':
      return shown('directory', field('path'));
    case 'settings':
      return shown('settings', field('name'));
    default:
      return 'unknown';
  }
}
