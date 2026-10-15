import type { BaselineDiff, ItemDiff } from './baseline-types.js';
import type { ScanResult } from './engine.js';
import type { Inventory } from '../inventory/types.js';
import type { ContextReport, LoadPlan } from '../platforms/load/types.js';

/**
 * Prefixes every path in a scan result with `prefix` (a POSIX directory, no trailing slash) and
 * records the prefix in `pathBase`.
 *
 * Paths in a ScanResult are relative to the scanned directory. GitHub annotations and SARIF
 * locations resolve against the repository root, and terminal users expect paths relative to
 * where they ran the command. The CLI therefore rebases onto the working directory when
 * scanning a subdirectory; otherwise alerts would land on the wrong files.
 *
 * Rebased: finding, artifact, skipped and symlink paths; load-plan working directories, entry,
 * skip and out-of-scope paths, import chains, matrix rows and limit subjects; inventory files;
 * baseline paths. Ids that embed a path (`<kind>:<path>…`: plan entries, skips, inventory
 * items, `inventoryId`, baseline id lists and gate hits other than `unicode`) get the prefix
 * after their kind, so they keep matching `<kind>:${path}`. Not rebased, because they are text
 * as written rather than repository paths: `patterns` (globs), hook `script` and `command`, MCP
 * `command` and `args`, hidden-scope locations, limit labels, and summaries. A limit subject is
 * always a path (a group of files uses its working directory, `''` at the root), so it is
 * rebased like one.
 */
export function rebaseResult(result: ScanResult, prefix: string): ScanResult {
  if (prefix === '' || prefix === '.') return result;
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const join = (path: string): string => (path === '' ? base : `${base}/${path}`);
  const mapped = mapPaths(result, join);
  const previous = result.pathBase ?? '';
  return { ...mapped, pathBase: previous === '' ? base : `${base}/${previous}` };
}

/**
 * Removes `pathBase` from every path that {@link rebaseResult} rebased, giving paths relative
 * to the scanned directory again. `--baseline` compares two reports this way, so a baseline
 * written from another working directory still matches. Paths outside `pathBase` (malformed
 * input) are left as they are.
 */
export function stripPathBase(result: ScanResult): ScanResult {
  const base = result.pathBase ?? '';
  if (base === '') return result;
  const strip = (path: string): string => {
    if (path === base) return '';
    return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
  };
  const { pathBase: _removed, ...rest } = mapPaths(result, strip);
  return rest;
}

type PathMap = (path: string) => string;

/** Tags of `incomplete` entries written as `<tag>:<path>`. Anything else is a plain path. */
const INCOMPLETE_TAGS = ['markdown-budget', 'unparsed', 'unread', 'invalid-json'] as const;

/**
 * `<kind>:<path>…` with the path mapped. Adding or removing a directory prefix only touches the
 * start of the path, so whatever follows it (`#name`, `=value`) can be mapped along with it.
 * Ids without a kind are left alone.
 */
function mapId(id: string, map: PathMap): string {
  const colon = id.indexOf(':');
  if (colon < 0) return id;
  return `${id.slice(0, colon + 1)}${map(id.slice(colon + 1))}`;
}

function mapIncomplete(entry: string, map: PathMap): string {
  for (const tag of INCOMPLETE_TAGS) {
    if (entry.startsWith(`${tag}:`)) return `${tag}:${map(entry.slice(tag.length + 1))}`;
  }
  return map(entry);
}

function mapPlan(plan: LoadPlan, map: PathMap): LoadPlan {
  return {
    ...plan,
    cwd: map(plan.cwd),
    entries: plan.entries.map((entry) => ({
      ...entry,
      id: mapId(entry.id, map),
      path: map(entry.path),
      realPath: map(entry.realPath),
      ...(entry.via === undefined ? {} : { via: entry.via.map(map) }),
      ...(entry.inventoryId === undefined ? {} : { inventoryId: mapId(entry.inventoryId, map) }),
    })),
    skipped: plan.skipped.map((entry) => ({
      ...entry,
      id: mapId(entry.id, map),
      path: map(entry.path),
    })),
    outOfScope: plan.outOfScope.map((entry) => ({ ...entry, path: map(entry.path) })),
    limits: plan.limits.map((limit) => ({ ...limit, subject: map(limit.subject) })),
    incomplete: plan.incomplete.map((entry) => mapIncomplete(entry, map)),
  };
}

function mapContext(context: ContextReport, map: PathMap): ContextReport {
  return {
    ...context,
    plans: context.plans.map((plan) => mapPlan(plan, map)),
    ...(context.matrix === undefined
      ? {}
      : {
          matrix: {
            rows: context.matrix.rows.map((row) => ({ ...row, path: map(row.path) })),
          },
        }),
  };
}

function mapInventory(inventory: Inventory, map: PathMap): Inventory {
  const item = <T extends { readonly id: string; readonly file: string }>(value: T): T => ({
    ...value,
    id: mapId(value.id, map),
    file: map(value.file),
  });
  return {
    mcpServers: inventory.mcpServers.map(item),
    hooks: inventory.hooks.map(item),
    permissions: inventory.permissions.map(item),
    env: inventory.env.map(item),
    incomplete: inventory.incomplete.map((entry) => mapIncomplete(entry, map)),
  };
}

function mapItemDiff(diff: ItemDiff, map: PathMap): ItemDiff {
  return {
    added: diff.added.map((id) => mapId(id, map)),
    removed: diff.removed.map((id) => mapId(id, map)),
    changed: diff.changed.map((entry) => ({ ...entry, id: mapId(entry.id, map) })),
  };
}

function mapBaseline(diff: BaselineDiff, map: PathMap): BaselineDiff {
  return {
    ...diff,
    findings: {
      ...diff.findings,
      resolved: diff.findings.resolved.map((entry) => ({ ...entry, path: map(entry.path) })),
    },
    inventory: mapItemDiff(diff.inventory, map),
    context: diff.context.map((delta) => ({
      ...delta,
      cwd: map(delta.cwd),
      entries: mapItemDiff(delta.entries, map),
      skipped: mapItemDiff(delta.skipped, map),
      limits: delta.limits.map((limit) => ({ ...limit, subject: map(limit.subject) })),
    })),
    gate: {
      ...diff.gate,
      hits: diff.gate.hits.map((hit) =>
        // A unicode hit's id is a finding fingerprint, not a path.
        hit.class === 'unicode' ? hit : { ...hit, id: mapId(hit.id, map) },
      ),
    },
  };
}

function mapPaths(result: ScanResult, map: PathMap): ScanResult {
  return {
    ...result,
    artifacts: result.artifacts.map((artifact) => ({ ...artifact, path: map(artifact.path) })),
    findings: result.findings.map((finding) => ({
      ...finding,
      path: map(finding.path),
      related: finding.related.map((related) => ({ ...related, path: map(related.path) })),
    })),
    score: {
      ...result.score,
      artifacts: result.score.artifacts.map((artifact) => ({
        ...artifact,
        path: map(artifact.path),
      })),
    },
    skipped: result.skipped.map((entry) => ({ ...entry, path: map(entry.path) })),
    unresolvedSymlinks: result.unresolvedSymlinks.map((entry) => ({
      ...entry,
      path: map(entry.path),
    })),
    inventory: mapInventory(result.inventory, map),
    ...(result.context === undefined ? {} : { context: mapContext(result.context, map) }),
    ...(result.baseline === undefined ? {} : { baseline: mapBaseline(result.baseline, map) }),
  };
}
