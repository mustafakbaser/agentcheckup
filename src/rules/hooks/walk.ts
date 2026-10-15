import type { Artifact, ArtifactKind } from '../../core/types.js';
import { isObject, type JsonObject, type JsonPath, own, type ParsedJson } from '../json/access.js';
import { GEMINI_CONFIG_KEYS, HOOK_EVENTS, type HookPlatform } from './events.js';

const HOOK_PLATFORM_BY_KIND: Readonly<Partial<Record<ArtifactKind, HookPlatform>>> = {
  'claude-settings': 'claude-code',
  'codex-hooks': 'codex',
  'cursor-hooks': 'cursor',
  'gemini-settings': 'gemini',
};

/** The platform that reads hooks from this kind of file. */
export function hookPlatformOf(artifact: Artifact): HookPlatform | undefined {
  return HOOK_PLATFORM_BY_KIND[artifact.kind];
}

export interface HookEvent {
  readonly name: string;
  readonly path: JsonPath;
  readonly entries: unknown;
}

/** Keys of the top-level `hooks` object, except Gemini CLI's configuration keys. */
export function hookEvents(doc: ParsedJson, platform: HookPlatform): HookEvent[] {
  const root = doc.value;
  if (!isObject(root)) return [];
  const hooks = own(root, 'hooks');
  if (!isObject(hooks)) return [];
  return Object.keys(hooks)
    .filter((name) => !(platform === 'gemini' && GEMINI_CONFIG_KEYS.has(name)))
    .map((name) => ({ name, path: ['hooks', name], entries: hooks[name] }));
}

export interface HookHandler {
  readonly event: string;
  readonly handler: JsonObject;
  /** Path of the handler object. */
  readonly path: JsonPath;
  /** `type`, with Cursor's default of "command" applied. */
  readonly type: string | undefined;
}

/**
 * Hook handlers in document order, for events the platform fires. Handlers under unknown event
 * names never run (hooks/unknown-event reports them), so rules about how a hook runs skip them.
 * Claude Code, Codex and Gemini CLI nest handlers as `hooks.<Event>[i].hooks[j]`; Cursor lists
 * them directly as `hooks.<event>[i]`.
 */
export function hookHandlers(doc: ParsedJson, platform: HookPlatform): HookHandler[] {
  const out: HookHandler[] = [];
  const known = HOOK_EVENTS[platform];
  for (const event of hookEvents(doc, platform)) {
    if (!known.includes(event.name) || !Array.isArray(event.entries)) continue;
    event.entries.forEach((entry: unknown, i) => {
      if (!isObject(entry)) return;
      if (platform === 'cursor') {
        const type = own(entry, 'type');
        out.push({
          event: event.name,
          handler: entry,
          path: [...event.path, i],
          type: typeof type === 'string' ? type : 'command',
        });
        return;
      }
      const inner = own(entry, 'hooks');
      if (!Array.isArray(inner)) return;
      inner.forEach((handler: unknown, j) => {
        if (!isObject(handler)) return;
        const type = own(handler, 'type');
        out.push({
          event: event.name,
          handler,
          path: [...event.path, i, 'hooks', j],
          type: typeof type === 'string' ? type : undefined,
        });
      });
    });
  }
  return out;
}
