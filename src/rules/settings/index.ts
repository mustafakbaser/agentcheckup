import type { AnyRule } from '../../core/types.js';
import { autoApproveProjectMcpRule } from './auto-approve-project-mcp.js';
import { ignoredPermissionModeRule } from './ignored-permission-mode.js';
import { localFileNotIgnoredRule } from './local-file-not-ignored.js';
import { pluginManifestRule } from './plugin-manifest.js';

export const settingsRules: readonly AnyRule[] = [
  autoApproveProjectMcpRule,
  ignoredPermissionModeRule,
  localFileNotIgnoredRule,
  pluginManifestRule,
];
