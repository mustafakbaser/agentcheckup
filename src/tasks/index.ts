/**
 * `agentcheckup tasks`: findings that need judgment, as tasks for a coding agent. Pure: the CLI
 * scans and passes the result in. See docs/tasks.md.
 */
export {
  buildTasks,
  DEFAULT_MAX_TASKS,
  MAX_TASKS,
  preambleOf,
  TASK_ID_PATTERN,
  type TaskOptions,
  type TaskScan,
  taskId,
} from './build.js';
export { checkTasks, type OpenReason, openTasks, type TaskStatus } from './check.js';
export { FOR_YOU_FAMILIES, FOR_YOU_RULES } from './for-you.js';
export { TEMPLATE_RULE_IDS } from './templates.js';
export { shellWord } from './text.js';
export type {
  FixStep,
  ForYouItem,
  ForYouReason,
  Task,
  TaskAnchor,
  TaskExcerpt,
  TaskList,
  TaskLocation,
} from './types.js';
