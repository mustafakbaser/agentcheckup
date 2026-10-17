import { RULESET_VERSION } from '../../core/meta.js';
import { codexIgnoredKeys, type IgnoredKey } from '../../platforms/codex-config.js';
import { defineRule } from '../define.js';
import { at, FileFindings, keySpanOf, pathLabel } from '../json/access.js';
import { quote } from '../shared/format.js';
import { SOURCES } from '../sources.js';

const ID = 'codex/ignored-project-key';

function message(ignored: IgnoredKey): string {
  const key = quote(pathLabel(ignored.path));
  switch (ignored.reason) {
    case 'removed':
      return `Codex removes ${key} from project config files and warns at startup ("Ignored unsupported project-local config keys"), so it has no effect here.`;
    case 'before-project':
      return `Codex reads ${key} before it loads project config files, to find the project and decide whether to trust it, so it has no effect here.`;
    case 'user-only':
      return `Codex reads ${key}, which records the hooks a user trusts, only from the user's own configuration and session, so it trusts or enables no hook here.`;
  }
}

export const ignoredProjectKeyRule = defineRule({
  meta: {
    id: ID,
    title: 'Codex ignores this key in a project config file',
    rationale: [
      'Repository content must not choose where Codex sends credentials or which local commands it runs, so Codex removes some keys from a project `.codex/config.toml` and warns at startup: `model_provider`, `model_providers`, `profile`, `profiles`, `notify`, `otel`, `openai_base_url`, `chatgpt_base_url`, `apps_mcp_product_sku`, `responses_api_metadata`, the two `experimental_realtime_*` URLs, some `features` and the `tui.keymap.chat` permission-mode keys.',
      'Other keys have no effect there either: Codex reads `project_root_markers` and `projects` before it loads project files, to find the project root and decide whether to trust it, and it reads `hooks.state`, the record of trusted hooks, only from user and session configuration.',
      'Move the setting to your user configuration (`~/.codex/config.toml`), or delete it.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'warn',
    appliesTo: ['codex-config'],
    platforms: ['codex'],
    sources: [
      SOURCES.codexConfigLoader,
      SOURCES.codexAgentsMdSource,
      SOURCES.codexHookState,
      SOURCES.codexConfigBasic,
      SOURCES.codexConfigReference,
    ],
    since: RULESET_VERSION,
  },
  defaultOptions: undefined,
  check(context) {
    if (!context.targets.has('codex')) return;
    for (const artifact of context.artifacts) {
      const doc = context.toml(artifact);
      if (!doc.ok) continue;
      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, 'keys Codex ignores');
      for (const ignored of codexIgnoredKeys(doc)) {
        findings.report({
          artifact,
          ...at(keySpanOf(doc, ignored.path)),
          message: message(ignored),
          platforms: ['codex'],
          guidance: 'move this setting to ~/.codex/config.toml, or delete it',
        });
      }
      findings.finish();
    }
  },
});
