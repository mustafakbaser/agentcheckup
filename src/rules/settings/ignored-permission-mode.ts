import { RULESET_VERSION } from '../../core/meta.js';
import type { Fix } from '../../core/types.js';
import { jsonRemoveProperty } from '../../fix/edits.js';
import { IGNORED_MODES } from '../../platforms/permissions.js';
import { defineRule } from '../define.js';
import { at, isObject, own, ownObject, spanOf } from '../json/access.js';
import { editable, sharedFileGuidance } from '../json/fix-support.js';
import { SOURCES } from '../sources.js';

const ID = 'settings/ignored-permission-mode';

export const ignoredPermissionModeRule = defineRule({
  meta: {
    id: ID,
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
    fix: {
      classes: ['review'],
      summary:
        'Removes "defaultMode" from the project or local settings. A review fix: Claude Code before v2.1.257 applied "bypassPermissions" from these files.',
    },
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
      const canEdit = editable(artifact);
      const change = canEdit
        ? jsonRemoveProperty(artifact, ['permissions', 'defaultMode'])
        : undefined;
      const fix: Fix | undefined =
        change === undefined
          ? undefined
          : {
              id: `${ID}#remove`,
              class: 'review',
              title: `Remove "defaultMode": "${mode}", which Claude Code ignores here`,
              changes: [change],
              notes: [
                mode === 'bypassPermissions'
                  ? 'Claude Code before v2.1.257 applied "bypassPermissions" from this file; without it, those versions ask for permission again.'
                  : 'Current Claude Code versions behave the same; the setting only misleads readers of this file.',
              ],
            };
      context.report({
        artifact,
        ...at(spanOf(doc, ['permissions', 'defaultMode'])),
        message: `"defaultMode": "${mode}" has no effect here: since v2.1.257, Claude Code ignores "auto" and "bypassPermissions" in project and local settings. Set it in ~/.claude/settings.json or managed settings, or pass --permission-mode.`,
        ...(fix === undefined ? {} : { fix }),
        ...(canEdit ? {} : { guidance: sharedFileGuidance(artifact) }),
      });
    }
  },
});
