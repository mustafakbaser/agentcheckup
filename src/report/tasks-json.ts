/**
 * `agentcheckup tasks --format json`: a {@link TaskList} as the object schemas/tasks.schema.json
 * describes.
 *
 * As in the other JSON reports, the object is built field by field in schema order, so key order
 * is fixed here and no stray runtime property reaches the output. A path that is absolute or
 * climbs out with `..` is an internal error and throws. Strings were redacted by the task
 * builder; serialization escapes display-dangerous characters (`forJsonOutput`).
 */
import { TOOL_NAME } from '../core/meta.js';
import type {
  FixStep,
  ForYouItem,
  Task,
  TaskAnchor,
  TaskExcerpt,
  TaskList,
  TaskLocation,
} from '../tasks/index.js';
import { forJsonOutput } from './sanitize.js';

export interface TasksReport {
  readonly schemaVersion: 1;
  readonly tool: { readonly name: string; readonly version: string };
  readonly ruleset: string;
  readonly pathBase: string;
  readonly untrusted: boolean;
  readonly preamble: readonly string[];
  readonly open: number;
  readonly readyFixes: { readonly safe: number; readonly review: number };
  readonly steps: readonly FixStep[];
  readonly tasks: readonly Task[];
  readonly omitted: number;
  readonly forYou: readonly ForYouItem[];
  readonly forYouOmitted: number;
  readonly check: { readonly command: string };
}

/** Thrown for a path the task report must not contain. */
export class UnsafeTaskPathError extends Error {
  constructor() {
    super('A task report path is absolute or leaves the working directory.');
    this.name = 'UnsafeTaskPathError';
  }
}

const DRIVE_LETTER = /^[a-z]:/i;

function checkedPath(path: string): string {
  if (
    path === '' ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    DRIVE_LETTER.test(path) ||
    path.split('/').includes('..')
  ) {
    throw new UnsafeTaskPathError();
  }
  return path;
}

function anchor(value: TaskAnchor): TaskAnchor {
  return value.kind === 'frontmatter' ? { kind: value.kind, key: value.key } : { kind: value.kind };
}

function excerpt(value: TaskExcerpt): TaskExcerpt {
  return {
    kind: value.kind,
    text: value.text,
    truncated: value.truncated,
    redacted: value.redacted,
  };
}

function location(value: TaskLocation): TaskLocation {
  return {
    line: value.line,
    anchor: anchor(value.anchor),
    message: value.message,
    hint: value.hint,
  };
}

function task(value: Task): Task {
  return {
    id: value.id,
    ruleId: value.ruleId,
    severity: value.severity,
    path: checkedPath(value.path),
    line: value.line,
    anchor: anchor(value.anchor),
    message: value.message,
    template: value.template,
    hint: value.hint,
    why: value.why,
    do: [...value.do],
    constraints: [...value.constraints],
    askUser: value.askUser,
    ...(value.excerpt === undefined ? {} : { excerpt: excerpt(value.excerpt) }),
    examples: [...value.examples],
    guardRules: [...value.guardRules],
    also: value.also.map(location),
    omittedLocations: value.omittedLocations,
    check: { command: value.check.command },
  };
}

function forYou(value: ForYouItem): ForYouItem {
  return {
    ruleId: value.ruleId,
    severity: value.severity,
    path: checkedPath(value.path),
    line: value.line,
    count: value.count,
    title: value.title,
    reason: value.reason,
    note: value.note,
  };
}

export function toTasksReport(list: TaskList): TasksReport {
  if (list.pathBase !== '') checkedPath(list.pathBase);
  return {
    schemaVersion: 1,
    tool: { name: TOOL_NAME, version: list.version },
    ruleset: list.ruleset,
    pathBase: list.pathBase,
    untrusted: list.untrusted,
    preamble: [...list.preamble],
    open: list.open,
    readyFixes: { safe: list.readyFixes.safe, review: list.readyFixes.review },
    steps: list.steps.map((step) => ({ kind: step.kind, text: step.text, command: step.command })),
    tasks: list.tasks.map(task),
    omitted: Math.max(0, list.open - list.tasks.length),
    forYou: list.forYou.map(forYou),
    forYouOmitted: list.forYouOmitted,
    check: { command: list.check.command },
  };
}

/** Pretty JSON (2-space indent, trailing newline) for `tasks --format json`. */
export function formatTasksJson(list: TaskList): string {
  return `${forJsonOutput(JSON.stringify(toTasksReport(list), null, 2))}\n`;
}
