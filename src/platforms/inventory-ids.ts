/**
 * Ids of security inventory items (src/inventory), computed where the loaders need them so a
 * load entry can point at its item through `LoadEntry.inventoryId`. `file` is the root-relative
 * path of the artifact that declares the item, never a symlink alias.
 */
import { hash53 } from '../core/fingerprint.js';

/** `mcp:<file>#<name>`. */
export function mcpInventoryId(file: string, name: string): string {
  return `mcp:${file}#${name}`;
}

/**
 * `hook:<file>#<event>:<digest of command>`, where the digest is `hash53` of the command text
 * (empty for handlers without a `command`). The second and later handlers with the same event
 * and command in one file add their 1-based occurrence number: `…:<digest>:2`.
 */
export function hookInventoryId(
  file: string,
  event: string,
  command: string,
  occurrence: number,
): string {
  const id = `hook:${file}#${event}:${hash53(command)}`;
  return occurrence <= 1 ? id : `${id}:${String(occurrence)}`;
}
