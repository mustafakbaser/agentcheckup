import { RULESET_VERSION } from '../../core/meta.js';
import { joinRelative, pathStatus } from '../../core/paths.js';
import type { Artifact, Fix, Severity, Span } from '../../core/types.js';
import { jsonReplaceValue } from '../../fix/edits.js';
import { defineRule } from '../define.js';
import { editable, sharedFileGuidance } from '../json/fix-support.js';
import {
  at,
  FileFindings,
  isObject,
  type JsonObject,
  type JsonPath,
  MAX_FINDINGS_PER_FILE,
  own,
  type ParsedJson,
  projectRootOf,
  spanOf,
} from '../json/access.js';
import { codePointLabel, quote } from '../shared/format.js';
import { JSON_SOURCES } from '../json/sources.js';
import { SOURCES } from '../sources.js';

/** Component keys whose values are paths (or contain paths), as `[key path, component name]`. */
const COMPONENTS: readonly (readonly [JsonPath, string])[] = [
  [['commands'], 'commands'],
  [['agents'], 'agents'],
  [['skills'], 'skills'],
  [['hooks'], 'hooks'],
  [['mcpServers'], 'mcpServers'],
  [['lspServers'], 'lspServers'],
  [['outputStyles'], 'outputStyles'],
  [['workflows'], 'workflows'],
  [['types'], 'types'],
  [['themes'], 'themes'],
  [['monitors'], 'monitors'],
  [['experimental', 'themes'], 'themes'],
  [['experimental', 'monitors'], 'monitors'],
];

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_PREFIXES = ['claude-', 'anthropic-', 'anthropics-', 'cc-plugin-'];
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'claude',
  'anthropic',
  'anthropics',
  'claude-code',
  'claude-mods',
]);
const VENDOR_WORDS: ReadonlySet<string> = new Set(['claude', 'anthropic', 'anthropics']);

interface Problem {
  readonly span: Span | undefined;
  readonly severity: Severity;
  readonly message: string;
  readonly fix?: Fix;
}

const ID = 'settings/plugin-manifest';

/** Manifest keys whose components start processes: hooks, MCP and LSP servers, monitors. */
const PROCESS_KEYS: readonly JsonPath[] = [
  ['hooks'],
  ['mcpServers'],
  ['lspServers'],
  ['monitors'],
  ['experimental', 'monitors'],
];

/** Files Claude Code loads from a plugin by default, whose components start processes. */
const PROCESS_FILES = ['hooks/hooks.json', '.mcp.json', '.lsp.json'];

/**
 * Whether the plugin can start a process once its manifest is valid: an invalid manifest keeps
 * the whole plugin from installing, so fixing it activates everything the plugin declares. Such
 * fixes are `review` (ADR 0008); unknown paths count as present.
 */
function startsProcesses(
  root: JsonObject,
  pluginRoot: string,
  status: (path: string) => string,
): boolean {
  if (PROCESS_KEYS.some((path) => valueAt(root, path) !== undefined)) return true;
  return PROCESS_FILES.some((file) => {
    const path = joinRelative(pluginRoot, file);
    return path === undefined || status(path) !== 'missing';
  });
}

/** A description of the first character a plugin name may not contain, or undefined. */
export function forbiddenNameCharacter(name: string): string | undefined {
  for (const char of name) {
    const cp = char.codePointAt(0) ?? 0;
    if (char === ' ' || char === '\t') return 'a space';
    if (char === '@' || char === ':') return `"${char}"`;
    if (char === '/' || char === '\\') return 'a path separator';
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f))
      return `the control character ${codePointLabel(cp)}`;
    if (
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      cp === 0x200e ||
      cp === 0x200f ||
      cp === 0x061c
    ) {
      return `the bidirectional formatting character ${codePointLabel(cp)}`;
    }
  }
  return undefined;
}

/** Claude Code's reserved-name check: case-insensitive, any run of separators counts as one. */
export function isReservedName(name: string): boolean {
  let normalized = '';
  for (const char of name.toLowerCase()) {
    const code = char.charCodeAt(0);
    const alnum = (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39);
    if (alnum) normalized += char;
    else if (!normalized.endsWith('-')) normalized += '-';
  }
  while (normalized.startsWith('-')) normalized = normalized.slice(1);
  while (normalized.endsWith('-')) normalized = normalized.slice(0, -1);
  if (RESERVED_NAMES.has(normalized)) return true;
  if (RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  const words = normalized.split('-');
  return words.some(
    (word, i) =>
      word === 'official' &&
      (VENDOR_WORDS.has(words[i - 1] ?? '') || VENDOR_WORDS.has(words[i + 1] ?? '')),
  );
}

/** `MyPlugin_v2` -> `my-plugin-v2`. */
function kebab(name: string): string {
  let out = '';
  let previousLower = false;
  for (const char of name) {
    const code = char.charCodeAt(0);
    const upper = code >= 0x41 && code <= 0x5a;
    const lower = (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39);
    if (upper) {
      if (previousLower) out += '-';
      out += char.toLowerCase();
    } else if (lower) {
      out += char;
    } else if (out !== '' && !out.endsWith('-')) {
      out += '-';
    }
    previousLower = lower;
  }
  return out.endsWith('-') ? out.slice(0, -1) : out;
}

/** True for names of printable ASCII only. */
function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function renameFix(artifact: Artifact, name: string): Fix | undefined {
  const renamed = kebab(name);
  if (!isAscii(name) || !KEBAB.test(renamed) || isReservedName(renamed)) return undefined;
  const change = jsonReplaceValue(artifact, ['name'], renamed);
  if (change === undefined) return undefined;
  return {
    id: `${ID}#kebab-name`,
    class: 'review',
    title: `Rename the plugin from ${quote(name)} to ${quote(renamed)}`,
    changes: [change],
    notes: [
      `Claude Code namespaces the plugin's commands and skills by its name, so /${name}:… becomes /${renamed}:…; update documentation and marketplace entries that use the old name.`,
    ],
  };
}

/** The `./` the manifest needs in front of a relative path that otherwise resolves. */
function prefixFix(
  artifact: Artifact,
  entry: PathEntry,
  component: string,
  pluginRoot: string,
  status: (path: string) => string,
  review: boolean,
): Fix | undefined {
  const { value } = entry;
  if (
    value === '' ||
    value.startsWith('/') ||
    value.startsWith('~') ||
    value.includes('\\') ||
    value.includes('://') ||
    value.split('/').includes('..')
  ) {
    return undefined;
  }
  const prefixed = `./${value}`;
  const resolved = joinRelative(pluginRoot, prefixed);
  if (resolved === undefined || status(resolved) !== 'exists') return undefined;
  const change = jsonReplaceValue(artifact, entry.path, prefixed);
  if (change === undefined) return undefined;
  return {
    id: `${ID}#dot-slash`,
    class: review ? 'review' : 'safe',
    title: `Write ${quote(prefixed)} in "${component}"`,
    changes: [change],
    ...(review
      ? {
          notes: [
            'The manifest becomes valid, so Claude Code installs the plugin with every hook and server it declares.',
          ],
        }
      : {}),
  };
}

function checkName(
  artifact: Artifact | undefined,
  doc: ParsedJson,
  root: JsonObject,
  problems: Problem[],
): void {
  const span = spanOf(doc, ['name']);
  const name = own(root, 'name');
  if (name === undefined) {
    problems.push({
      span: undefined,
      severity: 'error',
      message:
        'Plugin manifest has no "name", the only required field, so Claude Code reports an invalid manifest and the plugin cannot be installed.',
    });
    return;
  }
  if (typeof name !== 'string' || name.length === 0) {
    problems.push({
      span,
      severity: 'error',
      message:
        'Plugin "name" is empty or not a string, so Claude Code reports an invalid manifest and the plugin cannot be installed.',
    });
    return;
  }
  const forbidden = forbiddenNameCharacter(name);
  if (forbidden !== undefined) {
    problems.push({
      span,
      severity: 'error',
      message: `Plugin name ${quote(name)} contains ${forbidden}, which Claude Code does not allow in a name, so the plugin cannot be installed.`,
    });
    return;
  }
  if (!KEBAB.test(name)) {
    const fix = artifact === undefined ? undefined : renameFix(artifact, name);
    problems.push({
      span,
      severity: 'warn',
      message: `Plugin name ${quote(name)} is not kebab-case, and "claude plugin validate" warns about it. Use lowercase words joined by hyphens, such as ${quote(kebab(name) || 'my-plugin')}.`,
      ...(fix === undefined ? {} : { fix }),
    });
  }
  if (isReservedName(name)) {
    problems.push({
      span,
      severity: 'warn',
      message: `Plugin name ${quote(name)} is reserved because it passes as one of Anthropic's own plugins. "claude plugin validate" reports an error and "claude plugin init" and "claude plugin tag" refuse it, though Claude Code still installs and loads the plugin.`,
    });
  }
}

interface PathEntry {
  readonly value: string;
  readonly path: JsonPath;
}

/** Path strings under a component key: a string, an array of strings, or `commands` sources. */
function pathEntries(value: unknown, base: JsonPath, component: string): PathEntry[] {
  if (typeof value === 'string') return [{ value, path: base }];
  const out: PathEntry[] = [];
  if (Array.isArray(value)) {
    value.forEach((item: unknown, i) => {
      if (typeof item === 'string') out.push({ value: item, path: [...base, i] });
    });
  } else if (component === 'commands' && isObject(value)) {
    for (const key of Object.keys(value)) {
      const entry = value[key];
      if (!isObject(entry)) continue;
      const source = own(entry, 'source');
      if (typeof source === 'string') out.push({ value: source, path: [...base, key, 'source'] });
    }
  }
  return out;
}

function valueAt(root: JsonObject, path: JsonPath): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isObject(current) || typeof segment !== 'string') return undefined;
    current = own(current, segment);
  }
  return current;
}

function checkPath(
  entry: PathEntry,
  component: string,
  pluginRoot: string,
  status: (path: string) => string,
): Omit<Problem, 'span'> | undefined {
  const { value } = entry;
  if (component === 'skills' && (value === '.' || value === './')) return undefined;
  if (component === 'mcpServers' && value.toLowerCase().startsWith('https://')) return undefined;
  if (!value.startsWith('./')) {
    return {
      severity: 'error',
      message: `Component path ${quote(value)} in "${component}" does not start with "./", so the manifest fails validation.`,
    };
  }
  if (value.split('/').includes('..')) {
    return {
      severity: 'error',
      message: `Component path ${quote(value)} in "${component}" contains "..". Claude Code does not load a path outside the plugin directory, and "claude plugin validate" reports a path traversal error.`,
    };
  }
  const resolved = joinRelative(pluginRoot, value);
  if (resolved !== undefined && status(resolved) === 'missing') {
    return {
      severity: 'error',
      message: `Component path ${quote(value)} in "${component}" does not exist, so Claude Code does not load it ("${component} path not found").`,
    };
  }
  return undefined;
}

export const pluginManifestRule = defineRule({
  meta: {
    id: ID,
    title: 'Plugin manifest has an invalid name or component path',
    rationale: [
      '`name` is the only required field in `.claude-plugin/plugin.json`. Without it, or with spaces, `@`, `:`, path separators, control or bidirectional characters in it, the manifest is invalid and the plugin cannot be installed. A `homepage` that does not parse as a URL makes the plugin fail to load. Every component path must start with `./`, stay inside the plugin directory and exist, or the manifest fails validation or the component does not load. `skills` also accepts `"."`, and `mcpServers` an `https://` bundle URL.',
      'Two problems are warnings, because the plugin still loads: a name that is not kebab-case, which `claude plugin validate` warns about, and a reserved name (starting with `claude-`, `anthropic-`, `anthropics-` or `cc-plugin-`, a name such as `claude-code`, or `official` next to `claude` or `anthropic`), which `claude plugin validate` reports as an error and `claude plugin init` and `claude plugin tag` refuse.',
      'Fix the field the finding points to.',
    ].join('\n\n'),
    category: 'loading',
    severity: 'error',
    appliesTo: ['claude-plugin-manifest'],
    platforms: ['claude-code'],
    sources: [SOURCES.claudePlugins, JSON_SOURCES.claudePluginTroubleshooting],
    since: RULESET_VERSION,
    fix: {
      classes: ['safe', 'review'],
      summary:
        'Adds the missing "./" in front of a component path that exists (a review fix when the plugin declares hooks or servers, which then load), and renames a plugin whose name is not kebab-case (review). Other problems are left to you.',
    },
  },
  defaultOptions: undefined,
  check(context) {
    for (const artifact of context.artifacts) {
      const doc = context.json(artifact);
      if (!doc.ok) continue;
      const root = doc.value;
      if (!isObject(root)) {
        context.report({
          artifact,
          message:
            'Plugin manifest is not a JSON object, so Claude Code reports an invalid manifest and the plugin cannot be installed.',
        });
        continue;
      }
      const canEdit = editable(artifact);
      const problems: Problem[] = [];
      checkName(canEdit ? artifact : undefined, doc, root, problems);

      const homepage = own(root, 'homepage');
      if (typeof homepage === 'string' && !URL.canParse(homepage)) {
        problems.push({
          span: spanOf(doc, ['homepage']),
          severity: 'error',
          message: `"homepage" value ${quote(homepage)} is not a valid URL, so Claude Code does not load the plugin.`,
        });
      }

      const pluginRoot = projectRootOf(artifact);
      const status = (path: string): string => pathStatus(context.snapshot, path);
      const review = startsProcesses(root, pluginRoot, status);
      for (const [keyPath, component] of COMPONENTS) {
        for (const entry of pathEntries(valueAt(root, keyPath), keyPath, component)) {
          const problem = checkPath(entry, component, pluginRoot, status);
          if (problem === undefined) continue;
          // Problems are listed in this order, those past the cap without their fixes.
          const listed = problems.length < MAX_FINDINGS_PER_FILE;
          const fix =
            canEdit && listed && !entry.value.startsWith('./')
              ? prefixFix(artifact, entry, component, pluginRoot, status, review)
              : undefined;
          problems.push({
            ...problem,
            span: spanOf(doc, entry.path),
            ...(fix === undefined ? {} : { fix }),
          });
        }
      }

      const findings = new FileFindings((descriptor) => {
        context.report(descriptor);
      }, 'manifest problems');
      for (const problem of problems) {
        findings.report({
          artifact,
          ...at(problem.span),
          severity: problem.severity,
          message: problem.message,
          ...(problem.fix === undefined ? {} : { fix: problem.fix }),
          ...(canEdit ? {} : { guidance: sharedFileGuidance(artifact) }),
        });
      }
      findings.finish();
    }
  },
});
