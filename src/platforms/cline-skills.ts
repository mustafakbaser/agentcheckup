/**
 * How Cline reads a SKILL.md or a workflow, from `parseSkillConfigFromMarkdown` and
 * `parseWorkflowConfigFromMarkdown` in the SDK's user-instruction-config-loader.ts
 * (SOURCES.clineInstructionLoaderSource, cline/cline a42df8c), and what text it loads from a rule
 * file ({@link clineBody}). The skill rules and instr/empty-file use these functions to say when
 * Cline drops a file, and the Cline load plan uses the same functions, so both always agree.
 *
 * The SDK strips a byte order mark, finds the frontmatter only between a `---` line at the start
 * and the next `---` line, and parses the YAML with the `yaml` package, which agentcheckup's
 * parser follows (YAML 1.2, core schema, unique keys). It then throws, and drops the file, at the
 * first of these problems, in this order:
 * 1. `invalid-yaml`: the YAML does not parse (skill/frontmatter-invalid). YAML that is a list or a
 *    scalar gives no fields instead, and the file is named after its folder.
 * 2. `no-body`: nothing but whitespace after the frontmatter. No rule reports an empty skill.
 * 3. `name-type`: `name` is set and is not text (skill/name-format).
 * 4. `description-type`: a skill's `description` is set and is not text
 *    (skill/description-missing). Workflows have no description.
 * 5. `flag-type`: `disabled` is set and is not a boolean, or `disabled` is not set and `enabled`
 *    is set and is not a boolean (skill/field-type).
 *
 * An empty or missing `name` falls back to the folder name. A frontmatter block that is not
 * closed, or that is not YAML, is part of the body.
 */
import type { FrontmatterResult } from '../parse/types.js';
import { invalidCause } from './codex-skills.js';
import { isBlank } from './load/codex-text.js';

/** Why Cline drops a skill or workflow; see the module comment for the order. */
export type ClineSkipReason =
  'invalid-yaml' | 'no-body' | 'name-type' | 'description-type' | 'flag-type';

/** A field of the wrong type that makes Cline drop the file. */
export type ClineTypedField = 'name' | 'description' | 'disabled' | 'enabled';

/**
 * What Cline makes of a SKILL.md or workflow:
 * - `read`: its fields (none without frontmatter) and the body Cline loads.
 * - `skipped`: dropped for `reason`; `field` names the field of the wrong type.
 * - `unchecked`: agentcheckup stopped parsing the frontmatter, so it cannot tell.
 */
export type ClineRead =
  | {
      readonly kind: 'read';
      readonly fields: Readonly<Record<string, unknown>>;
      readonly body: string;
    }
  | { readonly kind: 'skipped'; readonly reason: ClineSkipReason; readonly field?: ClineTypedField }
  | { readonly kind: 'unchecked' };

const NO_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({});

/** True when `value` is set (not absent or null) and fails `test`. */
function wrongType(value: unknown, test: (value: unknown) => boolean): boolean {
  return value !== undefined && value !== null && !test(value);
}

const isText = (value: unknown): boolean => typeof value === 'string';
const isBoolean = (value: unknown): boolean => typeof value === 'boolean';

interface Parsed {
  readonly kind: 'parsed';
  readonly fields: Readonly<Record<string, unknown>>;
  readonly body: string;
}

/** The parsed fields and body, before the field checks, or why Cline cannot get them. */
function parse(text: string, frontmatter: FrontmatterResult): ClineRead | Parsed {
  if (frontmatter.kind === 'valid') {
    return { kind: 'parsed', fields: frontmatter.data.values, body: clineBody(text, frontmatter) };
  }
  if (frontmatter.kind === 'invalid') {
    const cause = invalidCause(text, frontmatter)?.kind;
    if (cause === 'limit') return { kind: 'unchecked' };
    if (cause !== 'not-a-mapping') return { kind: 'skipped', reason: 'invalid-yaml' };
  }
  return { kind: 'parsed', fields: NO_FIELDS, body: clineBody(text, frontmatter) };
}

/**
 * The text Cline loads from a rule, workflow, skill or AGENTS.md: what follows frontmatter that
 * parses, also as a list or a scalar, else the whole file. A rule whose YAML does not parse loads
 * whole, as Cline's documentation says (it fails open); a skill or workflow is dropped instead.
 */
export function clineBody(text: string, frontmatter: FrontmatterResult): string {
  if (frontmatter.kind === 'valid') return text.slice(frontmatter.bodyOffset);
  if (frontmatter.kind === 'invalid' && invalidCause(text, frontmatter)?.kind === 'not-a-mapping') {
    return text.slice(frontmatter.bodyOffset);
  }
  return text;
}

/** True when Cline gets nothing from the file: {@link clineBody} is blank. */
export function clineBodyBlank(text: string, frontmatter: FrontmatterResult): boolean {
  return isBlank(clineBody(text, frontmatter));
}

/**
 * How Cline reads the SKILL.md (`role: 'skill'`) or workflow (`role: 'workflow'`) with this
 * decoded text and parsed frontmatter.
 */
export function clineRead(
  text: string,
  frontmatter: FrontmatterResult,
  role: 'skill' | 'workflow',
): ClineRead {
  const parsed = parse(text, frontmatter);
  if (parsed.kind !== 'parsed') return parsed;
  const { fields, body } = parsed;
  const skipped = (reason: ClineSkipReason, field?: ClineTypedField): ClineRead => ({
    kind: 'skipped',
    reason,
    ...(field === undefined ? {} : { field }),
  });
  if (isBlank(body)) return skipped('no-body');
  if (wrongType(fields['name'], isText)) return skipped('name-type', 'name');
  if (role === 'skill' && wrongType(fields['description'], isText)) {
    return skipped('description-type', 'description');
  }
  const disabled = fields['disabled'];
  if (wrongType(disabled, isBoolean)) return skipped('flag-type', 'disabled');
  // The SDK reads `enabled` only when `disabled` is not set (`disabled ?? enabled`).
  if ((disabled === undefined || disabled === null) && wrongType(fields['enabled'], isBoolean)) {
    return skipped('flag-type', 'enabled');
  }
  return { kind: 'read', fields, body };
}

/**
 * The reason Cline drops the SKILL.md, or undefined when it reads it or agentcheckup cannot tell.
 */
export function clineSkillSkip(
  text: string,
  frontmatter: FrontmatterResult,
): ClineSkipReason | undefined {
  const read = clineRead(text, frontmatter, 'skill');
  return read.kind === 'skipped' ? read.reason : undefined;
}

/** The rule that reports each reason Cline drops a skill; `no-body` has none. */
export const CLINE_SKIP_RULE: Readonly<Record<ClineSkipReason, string | undefined>> = {
  'invalid-yaml': 'skill/frontmatter-invalid',
  'no-body': undefined,
  'name-type': 'skill/name-format',
  'description-type': 'skill/description-missing',
  'flag-type': 'skill/field-type',
};
