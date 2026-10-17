/**
 * `agentcheckup tasks`: the task list as a Markdown prompt for a coding agent
 * (`claude "$(npx agentcheckup tasks)"`). The shape is in docs/tasks.md.
 *
 * The prompt mixes trusted and untrusted text, and keeps them apart:
 *
 * - Trusted: the header, the preamble, templates (why, do, constraints, examples, what to ask)
 *   and commands. Every command is a fixed agentcheckup invocation pinned to the version that
 *   wrote the prompt; no command from the repository is ever an instruction.
 * - Untrusted, as data: paths and frontmatter keys in code spans (`codeSpan`: control,
 *   bidirectional and tag characters as `<U+XXXX>`, delimiters longer than any backtick run),
 *   messages and hints through `forMarkdown`, excerpts in `~~~~untrusted` blocks whose fence is
 *   longer than any tilde run inside. The preamble tells the agent that all of it is data.
 *
 * The whole output passes `guardWorkflowCommands`, so a line from the repository cannot act as a
 * GitHub Actions workflow command when the prompt is printed in a CI log.
 */
import type { Task, TaskAnchor, TaskExcerpt, TaskList } from '../tasks/index.js';
import { codeSpan, tildeFence } from '../tasks/text.js';
import { forMarkdown, guardWorkflowCommands } from './sanitize.js';
import { plural, SEVERITY_LABELS } from './text.js';

export const UNTRUSTED_BANNER =
  'untrusted repository: review this prompt before giving it to an agent with write access';

function where(path: string, line: number, anchor: TaskAnchor): string {
  switch (anchor.kind) {
    case 'file':
      return codeSpan(path);
    case 'line':
      return `${codeSpan(path)} line ${line}`;
    case 'frontmatter':
      return `${codeSpan(path)} line ${line}, frontmatter key ${codeSpan(anchor.key)}`;
  }
}

/** Items joined with "; " and ended with a period, as in "Do: keep the meaning; append …." */
function inline(items: readonly string[]): string {
  const text = items.join('; ');
  return text.endsWith('.') ? text : `${text}.`;
}

function excerptLines(excerpt: TaskExcerpt): string[] {
  const fence = tildeFence(excerpt.text);
  const notes = [
    ...(excerpt.truncated ? ['It is cut; read the file for the rest.'] : []),
    ...(excerpt.redacted ? ['Credentials in it are redacted.'] : []),
  ];
  return [
    excerpt.kind === 'value' ? 'Current value:' : 'Outline:',
    `${fence}untrusted`,
    ...excerpt.text.split('\n'),
    fence,
    ...notes,
  ];
}

function example(text: string): string[] {
  if (!text.includes('\n')) return [codeSpan(text)];
  const fence = '`'.repeat(3);
  return [fence, ...text.split('\n'), fence];
}

function examplesLines(examples: readonly string[]): string[] {
  if (examples.length === 0) return [];
  const label = examples.length === 1 ? 'Example:' : 'Examples:';
  if (examples.every((text) => !text.includes('\n'))) {
    return [`${label} ${examples.map(codeSpan).join('; ')}`];
  }
  return [label, ...examples.flatMap(example)];
}

function taskLines(task: Task, index: number, open: number): string[] {
  const severity = SEVERITY_LABELS[task.severity];
  const also = task.also.map((location) => {
    const hint =
      location.hint !== null && location.hint !== task.hint
        ? ` Hint: ${forMarkdown(location.hint)}`
        : '';
    const at =
      location.anchor.kind === 'frontmatter' ? `, key ${codeSpan(location.anchor.key)}` : '';
    return `Also at line ${location.line}${at}: ${forMarkdown(location.message)}${hint}`;
  });
  return [
    `## ${index + 1}/${open} · ${task.id} · ${task.ruleId} (${severity})`,
    `File: ${where(task.path, task.line, task.anchor)}`,
    `Problem: ${forMarkdown(task.message)}`,
    ...(task.hint === null ? [] : [`Hint: ${forMarkdown(task.hint)}`]),
    ...also,
    ...(task.omittedLocations > 0
      ? [`And ${plural(task.omittedLocations, 'more finding')} of this rule in this file.`]
      : []),
    ...(task.why === '' ? [] : [`Why: ${task.why}`]),
    ...(task.excerpt === undefined ? [] : excerptLines(task.excerpt)),
    ...(task.do.length === 0 ? [] : [`Do: ${inline(task.do)}`]),
    `Constraints: ${inline(task.constraints)}`,
    ...(task.askUser === null ? [] : [`Ask the user: ${inline([task.askUser])}`]),
    ...examplesLines(task.examples),
    `Check: ${codeSpan(task.check.command)} exits 0.`,
  ];
}

function stepsLines(list: TaskList): string[] {
  if (list.steps.length === 0) return [];
  return ['## 0 · Ready fixes', ...list.steps.map((step, index) => `${index + 1}. ${step.text}`)];
}

function forYouLines(list: TaskList): string[] {
  if (list.forYou.length === 0) return [];
  return [
    '## For you',
    "These need the user's decision. Do not change them; list them for the user when you finish.",
    ...list.forYou.map((item) => {
      const count = item.count > 1 ? `, ${plural(item.count, 'finding')}` : '';
      return `- ${codeSpan(item.path)} line ${item.line} · ${item.ruleId} (${SEVERITY_LABELS[item.severity]}${count}): ${item.title}. ${capitalized(item.note)}`;
    }),
    ...(list.forYouOmitted > 0
      ? [`- And ${plural(list.forYouOmitted, 'more file or rule', 'more files or rules')}.`]
      : []),
  ];
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatTasksMarkdown(list: TaskList): string {
  const header = `# agentcheckup tasks · ${list.open} open · agentcheckup ${list.version} · ruleset ${list.ruleset}`;
  // A blank line after the banner, or the next line would continue the block quote.
  const banner = list.untrusted ? [`> ${UNTRUSTED_BANNER}`, ''] : [];
  if (list.open === 0 && list.steps.length === 0 && list.forYou.length === 0) {
    const lines = [header, ...banner, ...(banner.length > 0 ? [] : [''])];
    return `${[...lines, 'Nothing to do: no finding needs an agent or you.'].join('\n')}\n`;
  }
  const blocks: string[][] = [
    [header, ...banner, 'Rules for every task:', ...list.preamble.map((rule) => `- ${rule}`)],
    stepsLines(list),
    ...list.tasks.map((task, index) => taskLines(task, index, list.open)),
    list.tasks.length < list.open
      ? [
          `Showing ${list.tasks.length} of ${plural(list.open, 'open task')}. When these are done, run ${codeSpan(list.rerun.command)} for the rest.`,
        ]
      : [],
    forYouLines(list),
    [
      '## Final check',
      `Run ${codeSpan(list.check.command)}. It exits 0 when no task is open, and 1 with the open tasks listed otherwise.`,
    ],
  ];
  const text = blocks
    .filter((block) => block.length > 0)
    .map((block) => block.join('\n'))
    .join('\n\n');
  return guardWorkflowCommands(`${text}\n`);
}
