import { RULESET_VERSION } from '../../core/meta.js';
import { IGNORED_MODES } from '../../platforms/permissions.js';
import { defineRule } from '../define.js';
import { at, isObject, own, ownObject, spanOf } from '../json/access.js';
import { SOURCES } from '../sources.js';

export const ignoredPermissionModeRule = defineRule({
  meta: {
    id: 'settings/ignored-permission-mode',
    title: 'Claude Code ignores this permission mode in project settings',
    rationale: [
      'Since v2.1.257, Claude Code ignores the `permissions.defaultMode` values `auto` and `bypassPermissions` in project settings (`.claude/settings.json`) and local settings (`.claude/settings.local.json`); before that version, `bypassPermissions` took effect from any file. A team that commits one of these values does not get the mode it set.',
      'Set the mode in `~/.claude/settings.json` or managed settings, or pass `--permission-mode` for one session.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'warn',
    appliesTo: ['claude-settings'],
    platforms: ['claude-code'],
    sources: [SOURCES.claudeSettings],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const doc = context.json(artifact);
      if (!doc.ok || !isObject(doc.value)) continue;
      const permissions = ownObject(doc.value, 'permissions');
      if (permissions === undefined) continue;
      const mode = own(permissions, 'defaultMode');
      if (typeof mode !== 'string' || !IGNORED_MODES.has(mode)) continue;
      context.report({
        artifact,
        ...at(spanOf(doc, ['permissions', 'defaultMode'])),
        message: `"defaultMode": "${mode}" has no effect here: since v2.1.257, Claude Code ignores "auto" and "bypassPermissions" in project and local settings. Set it in ~/.claude/settings.json or managed settings, or pass --permission-mode.`,
      });
    }
  },
});
