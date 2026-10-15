/**
 * Does a piece of English text address an AI agent, try to override its instructions, or ask it to
 * hide something? Word-sequence matching over `words()`, so the cost is linear in the text.
 */
import { words } from './english.js';

/** Words that name the agent being addressed. Ambiguous words (cursor, model, bot) are left out. */
const AGENT_WORDS: ReadonlySet<string> = new Set([
  'ai',
  'llm',
  'llms',
  'assistant',
  'assistants',
  'agent',
  'agents',
  'claude',
  'codex',
  'copilot',
  'gemini',
  'chatgpt',
  'gpt',
]);
const OVERRIDE_VERBS: ReadonlySet<string> = new Set(['ignore', 'disregard', 'forget']);
const OVERRIDE_SCOPE: ReadonlySet<string> = new Set([
  'previous',
  'prior',
  'above',
  'earlier',
  'preceding',
  'all',
  'any',
  'your',
  'system',
  'original',
  'existing',
  'other',
]);
const OVERRIDE_OBJECTS: ReadonlySet<string> = new Set([
  'instruction',
  'instructions',
  'rule',
  'rules',
  'guideline',
  'guidelines',
  'directive',
  'directives',
  'prompt',
  'prompts',
  'context',
  'constraints',
  'restrictions',
  'policy',
  'policies',
  'safeguards',
  'guardrails',
]);
const NOTE_WORDS: ReadonlySet<string> = new Set([
  'note',
  'notes',
  'message',
  'instructions',
  'instruction',
  'reminder',
  'hint',
]);
const GREETINGS: ReadonlySet<string> = new Set(['attention', 'dear', 'hey', 'hello', 'hi']);
const FILLERS: ReadonlySet<string> = new Set(['the', 'all', 'any', 'every', 'you', 'coding', 'ai']);
/** Words allowed in a heading that addresses the agent, such as "Note for AI agents reading this". */
const ADDRESS_WORDS: ReadonlySet<string> = new Set([
  ...AGENT_WORDS,
  ...NOTE_WORDS,
  ...GREETINGS,
  ...FILLERS,
  'to',
  'for',
  'reading',
  'this',
  'these',
  'important',
  'only',
  'code',
  'language',
  'model',
  'models',
  'other',
]);
/** First words of an imperative sentence after a vocative ("Claude, never ..."). */
const IMPERATIVE_STARTS: ReadonlySet<string> = new Set([
  'please',
  'you',
  'always',
  'never',
  'do',
  "don't",
  'make',
  'ensure',
  'remember',
  'prefer',
  'avoid',
  'ignore',
  'skip',
  'use',
]);
const MODALS: ReadonlySet<string> = new Set(['must', 'should', 'shall']);
/** Words that may precede an agent word in "<agent> must": "AI agents must", "the agent should". */
const MODAL_QUALIFIERS: ReadonlySet<string> = new Set([
  'the',
  'all',
  'any',
  'ai',
  'coding',
  'llm',
  'these',
  'every',
  'other',
]);
const ADJECTIVES: ReadonlySet<string> = new Set([
  'coding',
  'helpful',
  'ai',
  'autonomous',
  'software',
  'large',
]);
const IDENTITY: ReadonlySet<string> = new Set([...AGENT_WORDS, 'chatbot', 'language']);
const NEGATIONS: ReadonlySet<string> = new Set(['not', "don't", 'never', 'dont']);
const ALWAYS_SECRET: ReadonlySet<string> = new Set(['reveal', 'disclose']);
const TELL_VERBS: ReadonlySet<string> = new Set([
  'tell',
  'mention',
  'inform',
  'notify',
  'alert',
  'show',
  'report',
]);
const WITHOUT_VERBS: ReadonlySet<string> = new Set([
  'telling',
  'informing',
  'asking',
  'notifying',
  'alerting',
  'mentioning',
]);
const PEOPLE: ReadonlySet<string> = new Set([
  'user',
  'users',
  'human',
  'humans',
  'developer',
  'developers',
  'reviewer',
  'reviewers',
  'maintainer',
  'maintainers',
  'anyone',
  'operator',
  'owner',
  'them',
]);

function within(
  list: readonly string[],
  from: number,
  span: number,
  set: ReadonlySet<string>,
): number {
  const end = Math.min(list.length, from + span);
  for (let i = from; i < end; i++) if (set.has(list[i] ?? '')) return i;
  return -1;
}

/** "ignore all previous instructions", "disregard your rules", "system prompt". */
function overridesInstructions(list: readonly string[]): boolean {
  for (let i = 0; i < list.length; i++) {
    const word = list[i] ?? '';
    if (word === 'system' && list[i + 1] === 'prompt') return true;
    if (!OVERRIDE_VERBS.has(word)) continue;
    const scope = within(list, i + 1, 4, OVERRIDE_SCOPE);
    if (scope !== -1 && within(list, scope + 1, 4, OVERRIDE_OBJECTS) !== -1) return true;
  }
  return false;
}

/** "AI agents reading this: ...", "Claude, never ...", "note for agents", "if you are an AI". */
function addressesAgent(text: string, list: readonly string[]): boolean {
  const trimmed = text.trimStart();
  const colon = trimmed.indexOf(':');
  if (colon > 0 && colon <= 48 && !trimmed.slice(0, colon).includes('.')) {
    const head = words(trimmed.slice(0, colon));
    if (
      head.some((word) => AGENT_WORDS.has(word)) &&
      head.every((word) => ADDRESS_WORDS.has(word))
    ) {
      return true;
    }
  }
  const comma = trimmed.indexOf(',');
  if (comma > 0 && comma <= 24) {
    const head = words(trimmed.slice(0, comma));
    const after = words(trimmed.slice(comma + 1, comma + 40))[0] ?? '';
    if (head.length === 1 && AGENT_WORDS.has(head[0] ?? '') && IMPERATIVE_STARTS.has(after))
      return true;
  }
  for (let i = 0; i < list.length; i++) {
    const word = list[i] ?? '';
    const next = list[i + 1] ?? '';
    if (NOTE_WORDS.has(word) && (next === 'to' || next === 'for')) {
      let j = i + 2;
      while (j < list.length && j < i + 5 && FILLERS.has(list[j] ?? '')) j++;
      if (AGENT_WORDS.has(list[j] ?? '')) return true;
    }
    if (GREETINGS.has(word)) {
      const j = FILLERS.has(next) ? i + 2 : i + 1;
      if (AGENT_WORDS.has(list[j] ?? '')) return true;
    }
    const youAre = (word === 'you' && next === 'are') || word === "you're";
    const asA = word === 'as' && (next === 'an' || next === 'a');
    if (youAre || asA) {
      let j = word === "you're" ? i + 1 : i + 2;
      if (list[j] === 'an' || list[j] === 'a') j++;
      for (let step = 0; step < 3; step++) {
        const candidate = list[j] ?? '';
        if (IDENTITY.has(candidate) && (candidate !== 'language' || list[j + 1] === 'model')) {
          return true;
        }
        if (!ADJECTIVES.has(candidate)) break;
        j++;
      }
    }
    if (AGENT_WORDS.has(word) && MODALS.has(next)) {
      const previous = list[i - 1];
      if (previous === undefined || MODAL_QUALIFIERS.has(previous)) return true;
    }
  }
  return false;
}

/** "do not tell the user", "never reveal", "without telling anyone", "secretly". */
function asksForConcealment(list: readonly string[]): boolean {
  for (let i = 0; i < list.length; i++) {
    const word = list[i] ?? '';
    if (word === 'secretly' || word === 'covertly') return true;
    if (word === 'without' && WITHOUT_VERBS.has(list[i + 1] ?? '')) {
      if (within(list, i + 2, 3, PEOPLE) !== -1) return true;
    }
    if (!NEGATIONS.has(word)) continue;
    const verbIndex = list[i + 1] === 'ever' ? i + 2 : i + 1;
    const verb = list[verbIndex] ?? '';
    if (ALWAYS_SECRET.has(verb)) return true;
    if (TELL_VERBS.has(verb) && within(list, verbIndex + 1, 4, PEOPLE) !== -1) return true;
  }
  return false;
}

/** True when `text` reads as an instruction aimed at an AI agent. */
export function looksLikeAgentInstruction(text: string): boolean {
  const list = words(text);
  return overridesInstructions(list) || addressesAgent(text, list) || asksForConcealment(list);
}
