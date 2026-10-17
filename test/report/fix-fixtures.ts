/**
 * Hand-built fix runs for the fix output tests (src/report/fix-diff.ts, fix-json.ts,
 * suggestions.ts). Independent of the planner: these modules render what the planner and the
 * applier produce, so the inputs are synthetic.
 */
import { createHash } from 'node:crypto';
import type { Finding, Fix, LineEnding } from '../../src/core/types.js';
import type { FileState, FixEffect, FixSkipReason, PlannedFix } from '../../src/fix/index.js';
import type { ChangedFile, FileVersion, FixRun } from '../../src/report/fix-diff.js';
import { HOSTILE, HOSTILE_ALL } from './hostile.js';

/** A GitHub token that mcp/literal-secret's detector reports: `ghp_` and 36 base62 characters. Built from parts so that secret scanners do not flag the source. */
export const GITHUB_TOKEN = ['ghp', 'Zq8Lm2Xv9Rt4Wp7Ks1Nd6Hf3Jb5Gc0Ty8Ua2'].join('_');
/** An OpenAI-style key (marker `T3BlbkFJ`), found only by the detector in the tests. Built from parts so that secret scanners do not flag the source. */
export const OPENAI_KEY = [
  'sk-proj-',
  'Ab3Cd5Ef7Gh9',
  'T3Blbk',
  'FJ',
  'Km2Np4Qr6St8Uv0Wx1Yz3Bc5De7',
].join('');

function lineEndingOf(text: string): LineEnding {
  let lf = 0;
  let crlf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charAt(i - 1) === '\r') crlf++;
    else lf++;
  }
  if (lf > 0 && crlf > 0) return 'mixed';
  if (crlf > 0) return 'crlf';
  return lf > 0 ? 'lf' : 'none';
}

export function version(text: string, state: Partial<FileState> = {}): FileVersion {
  return {
    text,
    state: {
      sha256: createHash('sha256').update(text).digest('hex'),
      encoding: 'utf-8',
      bom: false,
      lineEnding: lineEndingOf(text),
      ...state,
    },
  };
}

export function edited(
  path: string,
  before: string,
  after: string,
  states: { before?: Partial<FileState>; after?: Partial<FileState> } = {},
): ChangedFile {
  return {
    op: 'edit',
    path,
    before: version(before, states.before),
    after: version(after, states.after),
  };
}

export function created(path: string, text: string): ChangedFile {
  return { op: 'create', path, after: version(text) };
}

export function renamed(from: string, path: string, before: string, after: string): ChangedFile {
  return { op: 'rename', path, from, before: version(before), after: version(after) };
}

let fingerprint = 0x1a2b3c;

/** A planned fix with fresh fingerprints. */
export function planned(
  ruleId: string,
  fix: Omit<Fix, 'id'> & { id?: string },
  options: {
    effects?: readonly FixEffect[];
    status?: 'planned' | 'applied';
    findings?: readonly string[];
  } = {},
): PlannedFix {
  fingerprint += 0x101;
  return {
    fix: { id: `${ruleId}#fix`, ...fix },
    ruleId,
    findings: options.findings ?? [`${fingerprint.toString(16)}:1`],
    effects: options.effects ?? [],
    status: options.status ?? 'planned',
  };
}

/** `fix` as applied by `--write`. */
export function applied(fix: PlannedFix): PlannedFix {
  return {
    fix: fix.fix,
    ruleId: fix.ruleId,
    findings: fix.findings,
    effects: fix.effects,
    status: 'applied',
  };
}

export function skipped(ruleId: string, fix: Omit<Fix, 'id'>, reason: FixSkipReason): PlannedFix {
  fingerprint += 0x101;
  return {
    fix: { id: `${ruleId}#fix`, ...fix },
    ruleId,
    findings: [`${fingerprint.toString(16)}:1`],
    effects: [],
    status: 'skipped',
    reason,
  };
}

export function introduced(ruleId: string, path: string, line: number, message: string): Finding {
  const position = { line, column: 1 };
  return {
    ruleId,
    severity: 'info',
    category: 'clarity',
    message,
    path,
    range: { start: position, end: position },
    related: [],
    platforms: ['claude-code'],
    fingerprint: 'feedface:1',
  };
}

export const CLAUDE_BEFORE = '# Acme API\n\nUse pnpm.\nRun tests with pnpm test.\n';
const STYLE_BEFORE = '# Style\n\nUse tabs.\nPrefer named exports.';
const MCP_BEFORE =
  '{\n  "mcpServers": {\n    "docs": {\n      "url": "https://docs.example.com/mcp"\n    }\n  }\n}\n';
const MCP_INSERT = MCP_BEFORE.indexOf('"url"');
const SKILL_BEFORE = '---\nname: release-notes\n---\n\n# Release notes\n\nWrite the notes.\n';
const SKILL_INSERT = SKILL_BEFORE.indexOf('---\n\n');

/** The demo repository of the design: four fixes, one skipped, a create and a manual step. */
export const sampleRun: FixRun = {
  mode: 'dry-run',
  fixes: [
    planned(
      'instr/agents-md-ignored-by-claude',
      {
        id: 'instr/agents-md-ignored-by-claude#import',
        class: 'safe',
        title: 'Add "@AGENTS.md" as line 1 of CLAUDE.md',
        changes: [
          {
            kind: 'edit',
            path: 'CLAUDE.md',
            edits: [{ offset: 0, length: 0, text: '@AGENTS.md\n\n' }],
          },
        ],
      },
      { effects: [{ kind: 'tokens', agent: 'claude-code', cwd: '', before: 50, after: 247 }] },
    ),
    planned(
      'cursor/md-file-ignored',
      {
        id: 'cursor/md-file-ignored#rename',
        class: 'review',
        title: 'Rename .cursor/rules/style.md to style.mdc with "alwaysApply: true"',
        changes: [
          { kind: 'rename', from: '.cursor/rules/style.md', to: '.cursor/rules/style.mdc' },
          {
            kind: 'edit',
            path: '.cursor/rules/style.mdc',
            edits: [{ offset: 0, length: 0, text: '---\nalwaysApply: true\n---\n' }],
          },
        ],
        notes: ['-i offers: globs, description'],
      },
      { effects: [{ kind: 'tokens', agent: 'cursor', cwd: '', before: 304, after: 614 }] },
    ),
    planned(
      'mcp/url-without-type',
      {
        id: 'mcp/url-without-type#type',
        class: 'review',
        title: 'Add "type": "http" to MCP server docs',
        changes: [
          {
            kind: 'edit',
            path: '.mcp.json',
            edits: [{ offset: MCP_INSERT, length: 0, text: '"type": "http",\n      ' }],
          },
        ],
        notes: ['Claude Code will offer to start it; `claude -p` starts it without asking.'],
      },
      {
        effects: [
          {
            kind: 'gate',
            class: 'mcp',
            id: 'mcp:.mcp.json#docs',
            change: 'changed',
            summary: 'Changed MCP server docs (http, https://docs.example.com)',
          },
        ],
      },
    ),
    planned('skill/description-missing', {
      id: 'skill/description-missing#copy',
      class: 'review',
      title: 'Copy a description into .agents/skills/release-notes/SKILL.md',
      changes: [
        {
          kind: 'edit',
          path: '.agents/skills/release-notes/SKILL.md',
          edits: [{ offset: SKILL_INSERT, length: 0, text: 'description: "Release notes"\n' }],
        },
      ],
      notes: ['copied from the body; reword it to say when to use the skill'],
    }),
    planned(
      'instr/agents-md-ignored-by-claude',
      {
        id: 'instr/agents-md-ignored-by-claude#create',
        class: 'review',
        title: 'Create packages/api/CLAUDE.md that imports AGENTS.md',
        changes: [{ kind: 'create', path: 'packages/api/CLAUDE.md', text: '@AGENTS.md\n' }],
      },
      {
        effects: [
          { kind: 'tokens', agent: 'claude-code', cwd: 'packages/api', before: 120, after: 410 },
        ],
      },
    ),
    skipped(
      'json/duplicate-key',
      {
        class: 'safe',
        title: 'Delete the first "docs" in .mcp.json',
        changes: [
          { kind: 'edit', path: '.mcp.json', edits: [{ offset: 20, length: 2, text: '' }] },
        ],
      },
      'conflict',
    ),
  ],
  files: [
    edited('CLAUDE.md', CLAUDE_BEFORE, `@AGENTS.md\n\n${CLAUDE_BEFORE}`),
    renamed(
      '.cursor/rules/style.md',
      '.cursor/rules/style.mdc',
      STYLE_BEFORE,
      `---\nalwaysApply: true\n---\n${STYLE_BEFORE}`,
    ),
    edited(
      '.mcp.json',
      MCP_BEFORE,
      `${MCP_BEFORE.slice(0, MCP_INSERT)}"type": "http",\n      ${MCP_BEFORE.slice(MCP_INSERT)}`,
    ),
    edited(
      '.agents/skills/release-notes/SKILL.md',
      SKILL_BEFORE,
      `${SKILL_BEFORE.slice(0, SKILL_INSERT)}description: "Release notes"\n${SKILL_BEFORE.slice(SKILL_INSERT)}`,
    ),
    created('packages/api/CLAUDE.md', '@AGENTS.md\n'),
  ],
  manual: [
    {
      ruleId: 'instr/import-unresolved',
      path: 'CLAUDE.md',
      line: 3,
      guidance: 'create docs/setup.md or correct the path',
    },
  ],
  verification: { resolved: 5, remaining: 1, introduced: [] },
};

/** The sample after `--write --review`: every planned fix applied. */
export const writtenRun: FixRun = {
  ...sampleRun,
  mode: 'write',
  fixes: sampleRun.fixes.map((fix) => (fix.status === 'planned' ? applied(fix) : fix)),
  verification: {
    resolved: 5,
    remaining: 1,
    introduced: [
      introduced(
        'skill/description-quality',
        '.agents/skills/release-notes/SKILL.md',
        3,
        'The description does not say when to use the skill.',
      ),
    ],
  },
};

const SECRET_BEFORE = `{\n  "mcpServers": {\n    "github": {\n      "command": "npx",\n      "env": {\n        "GITHUB_TOKEN": "${GITHUB_TOKEN}"\n      }\n    }\n  }\n}\n`;
const SECRET_AT = SECRET_BEFORE.indexOf(GITHUB_TOKEN);
export const ROTATE =
  'Revoke and rotate this credential now. Editing the file does not remove it from git history.';

/** mcp/literal-secret's fix, plus a token in a file another fix only touches nearby. */
export const secretRun: FixRun = {
  mode: 'dry-run',
  fixes: [
    planned('mcp/literal-secret', {
      id: 'mcp/literal-secret#env',
      class: 'review',
      title: 'Read GITHUB_TOKEN from the environment in .mcp.json',
      changes: [
        {
          kind: 'edit',
          path: '.mcp.json',
          edits: [{ offset: SECRET_AT, length: GITHUB_TOKEN.length, text: '${GITHUB_TOKEN}' }],
        },
      ],
      warning: ROTATE,
      notes: [`replaces ${GITHUB_TOKEN}`],
    }),
    planned('instr/agents-md-ignored-by-claude', {
      class: 'safe',
      title: 'Add "@AGENTS.md" as line 1 of CLAUDE.md',
      changes: [
        {
          kind: 'edit',
          path: 'CLAUDE.md',
          edits: [{ offset: 0, length: 0, text: '@AGENTS.md\n' }],
        },
      ],
    }),
  ],
  files: [
    edited(
      '.mcp.json',
      SECRET_BEFORE,
      `${SECRET_BEFORE.slice(0, SECRET_AT)}\${GITHUB_TOKEN}${SECRET_BEFORE.slice(SECRET_AT + GITHUB_TOKEN.length)}`,
    ),
    edited(
      'CLAUDE.md',
      `# API\nexport OPENAI_API_KEY=${OPENAI_KEY}\n`,
      `@AGENTS.md\n# API\nexport OPENAI_API_KEY=${OPENAI_KEY}\n`,
    ),
  ],
  manual: [
    {
      ruleId: 'mcp/literal-secret',
      path: '.claude/settings.json',
      line: 4,
      guidance: `move ${GITHUB_TOKEN} into your shell environment`,
    },
  ],
  verification: { resolved: 2, remaining: 1, introduced: [] },
};

const HOSTILE_PATH = 'evil\u001b]52;c;cHduZWQ=\u0007/CLAUDE.md';
const HOSTILE_TEXT = [
  '::stop-commands::x',
  '  ::error::fake annotation',
  HOSTILE.osc52Clipboard,
  HOSTILE.osc8Link,
  HOSTILE.bidiOverride,
  HOSTILE.tags,
  HOSTILE.carriageReturn,
  HOSTILE.c1Csi,
  HOSTILE.nulAndDel,
  '',
].join('\n');

/** Hostile text in every untrusted field: paths, file content, titles, notes, guidance. */
export const hostileRun: FixRun = {
  mode: 'dry-run',
  fixes: [
    planned(
      'evil:rule,title=x',
      {
        class: 'review',
        title: HOSTILE_ALL,
        changes: [
          { kind: 'edit', path: HOSTILE_PATH, edits: [{ offset: 0, length: 0, text: 'x\n' }] },
        ],
        notes: [HOSTILE.stopCommands, HOSTILE.fakeError],
        warning: HOSTILE.addMask,
      },
      {
        effects: [
          {
            kind: 'gate',
            class: 'hooks',
            id: 'hook:.claude/settings.json#0',
            change: 'added',
            summary: HOSTILE.osc8Link,
          },
          { kind: 'tokens', agent: 'codex', cwd: HOSTILE.bidiIsolates, before: 1, after: 2 },
        ],
      },
    ),
  ],
  files: [
    edited(
      HOSTILE_PATH,
      HOSTILE_TEXT,
      `x\n${HOSTILE_TEXT.replace(HOSTILE.tags, `${HOSTILE.tags}\n${HOSTILE.zeroWidth}`)}::add-mask::y\n`,
    ),
  ],
  manual: [
    {
      ruleId: 'evil:rule,title=x',
      path: 'notes\n::stop-commands::x/AGENTS.md',
      line: 2,
      guidance: HOSTILE_ALL,
    },
  ],
  verification: {
    resolved: 1,
    remaining: 1,
    introduced: [introduced('risk/hidden-unicode', HOSTILE_PATH, 1, HOSTILE.fakeError)],
  },
};
