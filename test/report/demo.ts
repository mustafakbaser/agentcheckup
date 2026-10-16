/**
 * The demo repository of the fix design (docs/research/2026-10-16-fix-design.md, section 1) as a
 * hand-built ScanResult: a CLAUDE.md that shadows AGENTS.md (safe fix), a Cursor rule saved as
 * .md (review), an MCP server with "url" but no "type" (review), a skill without a description
 * (review) and an import of a missing file (manual, with guidance). Root load plans for Claude
 * Code, Codex and Cursor say what each agent misses. Independent of rules and loaders, like
 * fixtures.ts.
 */
import type { BaselineDiff } from '../../src/core/baseline-types.js';
import type { ScanResult } from '../../src/core/engine.js';
import type { Finding, Fix } from '../../src/core/types.js';
import type { LoadPlan } from '../../src/platforms/load/types.js';
import {
  baselineDiff,
  contextReport,
  entry,
  itemDiff,
  plan,
  planDelta,
  size,
  skip,
} from '../helpers/context.js';
import { at, finding, makeResult, rule } from './fixtures.js';
import { HOSTILE, HOSTILE_ALL } from './hostile.js';

export const DEMO_RULES = {
  shadowed: rule('instr/agents-md-ignored-by-claude', 'loading', 'warn', {
    title: 'Claude Code skips AGENTS.md next to a CLAUDE.md',
    rationale:
      'Claude Code reads `CLAUDE.md`, not `AGENTS.md`. Import it with `@AGENTS.md`.\n\nSecond paragraph.',
    platforms: ['claude-code'],
    fix: { classes: ['safe', 'review'], summary: 'Imports AGENTS.md from CLAUDE.md.' },
  }),
  mdFile: rule('cursor/md-file-ignored', 'loading', 'error', {
    title: 'Cursor ignores .md files in .cursor/rules',
    rationale: 'Cursor loads only `.mdc` files from `.cursor/rules`.',
    platforms: ['cursor'],
    fix: { classes: ['safe', 'review'], summary: 'Renames the file to .mdc.' },
  }),
  unresolved: rule('instr/import-unresolved', 'correctness', 'error', {
    title: 'Imported file does not exist',
    platforms: ['claude-code'],
  }),
  urlWithoutType: rule('mcp/url-without-type', 'loading', 'error', {
    title: 'MCP server has a url but no type',
    platforms: ['claude-code'],
    fix: { classes: ['review'], summary: 'Adds the transport type.' },
  }),
  noDescription: rule('skill/description-missing', 'loading', 'error', {
    title: 'Skill has no description',
    platforms: ['codex'],
    fix: { classes: ['review'], summary: 'Copies the first body line.' },
  }),
} as const;

const importFix: Fix = {
  id: 'instr/agents-md-ignored-by-claude#import',
  class: 'safe',
  title: 'add "@AGENTS.md" as line 1 of CLAUDE.md',
  changes: [
    { kind: 'edit', path: 'CLAUDE.md', edits: [{ offset: 0, length: 0, text: '@AGENTS.md\n\n' }] },
  ],
};

const renameFix: Fix = {
  id: 'cursor/md-file-ignored#always-apply',
  class: 'review',
  title: 'rename to style.mdc with "alwaysApply: true"',
  changes: [
    { kind: 'rename', from: '.cursor/rules/style.md', to: '.cursor/rules/style.mdc' },
    {
      kind: 'edit',
      path: '.cursor/rules/style.mdc',
      edits: [{ offset: 0, length: 0, text: '---\nalwaysApply: true\n---\n' }],
    },
  ],
};

const typeFix: Fix = {
  id: 'mcp/url-without-type#http',
  class: 'review',
  title: 'Add "type": "http" to MCP server docs',
  changes: [
    {
      kind: 'edit',
      path: '.mcp.json',
      edits: [{ offset: 42, length: 0, text: '"type": "http",\n      ' }],
    },
  ],
};

const descriptionFix: Fix = {
  id: 'skill/description-missing#copy',
  class: 'review',
  title: 'Copy the first body line into "description"',
  changes: [
    {
      kind: 'edit',
      path: '.agents/skills/release-notes/SKILL.md',
      edits: [{ offset: 4, length: 0, text: 'description: "Release notes"\n' }],
    },
  ],
};

export const DEMO_FINDINGS: readonly Finding[] = [
  finding(
    DEMO_RULES.noDescription,
    '.agents/skills/release-notes/SKILL.md',
    'Skill "release-notes" has no description, so Codex skips it.',
    { fingerprint: 'd0d0d0d0d0d001:1', fix: descriptionFix },
  ),
  finding(
    DEMO_RULES.mdFile,
    '.cursor/rules/style.md',
    'Cursor loads only .mdc files from .cursor/rules, so it ignores "style.md".',
    { fingerprint: 'd0d0d0d0d0d002:1', fix: renameFix },
  ),
  finding(
    DEMO_RULES.urlWithoutType,
    '.mcp.json',
    'MCP server "docs" has "url" but no "type", so Claude Code skips it.',
    { range: at(4, 5, 4, 11), fingerprint: 'd0d0d0d0d0d003:1', fix: typeFix },
  ),
  finding(
    DEMO_RULES.shadowed,
    'AGENTS.md',
    'Claude Code reads "CLAUDE.md" in this directory and skips this AGENTS.md.',
    {
      fingerprint: 'd0d0d0d0d0d004:1',
      related: [
        { path: 'CLAUDE.md', message: 'Claude Code reads this file instead of AGENTS.md.' },
      ],
      fix: importFix,
    },
  ),
  finding(
    DEMO_RULES.unresolved,
    'CLAUDE.md',
    'Imported file "docs/setup.md" does not exist, so Claude Code cannot load it.',
    {
      range: at(3, 5, 3, 19),
      fingerprint: 'd0d0d0d0d0d005:1',
      guidance: 'create docs/setup.md or correct the path; no file named setup.md exists',
    },
  ),
];

const claude: LoadPlan = plan('claude-code', {
  entries: [entry('instructions', 'CLAUDE.md', { position: 1, size: size(200) })],
  skipped: [
    skip('rule', '.cursor/rules/style.md', 'not-read', { evidence: [] }),
    skip('mcp-server', '.mcp.json', 'url-without-type', {
      name: 'docs',
      ruleId: 'mcp/url-without-type',
      fix: 'review',
      evidence: ['claudeMcp'],
    }),
    skip('instructions', 'AGENTS.md', 'shadowed-by-claude-md', {
      ruleId: 'instr/agents-md-ignored-by-claude',
      size: size(788),
      fix: 'safe',
    }),
    skip('import', 'CLAUDE.md', 'import-unresolved', {
      name: 'docs/setup.md',
      ruleId: 'instr/import-unresolved',
    }),
  ],
});

const codex: LoadPlan = plan('codex', {
  entries: [
    entry('instructions', 'AGENTS.md', {
      position: 1,
      size: size(788),
      evidence: ['codexAgentsMd'],
    }),
  ],
  skipped: [
    skip('skill', '.agents/skills/release-notes/SKILL.md', 'no-description', {
      ruleId: 'skill/description-missing',
      size: size(3100),
      fix: 'review',
      evidence: ['codexAgentsMd'],
    }),
  ],
});

const cursor: LoadPlan = plan('cursor', {
  entries: [
    entry('instructions', 'AGENTS.md', { position: 1, size: size(788), evidence: ['cursorRules'] }),
    entry('instructions', 'CLAUDE.md', { position: 2, size: size(200), evidence: ['cursorRules'] }),
  ],
  skipped: [
    skip('rule', '.cursor/rules/style.md', 'not-mdc', {
      ruleId: 'cursor/md-file-ignored',
      size: size(1240),
      fix: 'review',
      evidence: ['cursorRules'],
    }),
  ],
});

/** The demo repository's scan, with root load plans. */
export const demoResult: ScanResult = {
  ...makeResult({
    artifacts: [
      { path: '.agents/skills/release-notes/SKILL.md', kind: 'skill', readers: ['codex'] },
      { path: '.cursor/rules/style.md', kind: 'cursor-rule-md', readers: ['cursor'] },
      { path: '.mcp.json', kind: 'mcp-json', readers: ['claude-code'] },
      { path: 'AGENTS.md', kind: 'agents-md', readers: ['codex', 'cursor'] },
      { path: 'CLAUDE.md', kind: 'claude-md', readers: ['claude-code', 'cursor'] },
    ],
    findings: DEMO_FINDINGS,
    score: { score: 58, grade: 'D', capped: false },
    rules: Object.values(DEMO_RULES),
  }),
  context: contextReport([claude, codex, cursor]),
};

/** The demo scan as a pull request that adds the shadowing CLAUDE.md and the Cursor .md rule. */
export const demoBaseline: BaselineDiff = baselineDiff({
  findings: { new: 2, unchanged: 3, resolved: [] },
  context: [
    planDelta('claude-code', 197, 50, {
      skipped: itemDiff({ added: ['instructions:AGENTS.md'] }),
    }),
    planDelta('codex', 197, 197),
    planDelta('cursor', 197, 247, {
      skipped: itemDiff({ added: ['rule:.cursor/rules/style.md'] }),
    }),
  ],
  gate: { classes: [], hits: [] },
});

export const demoBaselineResult: ScanResult = {
  ...demoResult,
  findings: demoResult.findings.map((item) => ({
    ...item,
    baseline:
      item.ruleId === 'instr/agents-md-ignored-by-claude' ||
      item.ruleId === 'cursor/md-file-ignored'
        ? ('new' as const)
        : ('unchanged' as const),
  })),
  baseline: demoBaseline,
};

/**
 * The demo with hostile text in every field the new feedback writes: skip paths, names and
 * importers, fix titles, guidance, and a rule id that must not become a link.
 */
export const hostileDemoResult: ScanResult = (() => {
  const hostileFix: Fix = {
    id: 'cursor/md-file-ignored#hostile',
    class: 'safe',
    title: HOSTILE_ALL,
    changes: [
      {
        kind: 'edit',
        path: HOSTILE.stopCommands,
        edits: [
          { offset: 3, length: 2, text: HOSTILE_ALL },
          { offset: 0, length: 0, text: '\u001b]8;;https://evil.example\u001b\\x' },
        ],
      },
    ],
  };
  const findings: Finding[] = [
    finding(DEMO_RULES.mdFile, HOSTILE.stopCommands, HOSTILE.fakeError, {
      fingerprint: 'e0e0e0e0e0e001:1',
      fix: hostileFix,
    }),
    finding(DEMO_RULES.unresolved, HOSTILE.html, HOSTILE.addMask, {
      fingerprint: 'e0e0e0e0e0e002:1',
      guidance: `${HOSTILE.links}\n::error::guidance ${HOSTILE.osc8Link} ${HOSTILE.markdownSyntax}`,
    }),
    finding(rule('evil:rule,title=x', 'loading', 'warn'), HOSTILE.tablePipes, HOSTILE.mentions, {
      fingerprint: 'e0e0e0e0e0e003:1',
      fix: {
        ...hostileFix,
        id: 'evil#x',
        class: 'review',
        title: `x\r\n::warning::fake ${HOSTILE.html}`,
      },
    }),
  ];
  const hostilePlan = plan('cursor', {
    entries: [entry('instructions', HOSTILE.stopCommands, { position: 1, size: size(40) })],
    skipped: [
      skip('rule', HOSTILE.stopCommands, 'not-mdc', {
        ruleId: 'cursor/md-file-ignored',
        size: size(400),
        fix: 'safe',
      }),
      skip('import', HOSTILE.html, 'import-unresolved', {
        name: `::error::${HOSTILE.osc52Clipboard}`,
        ruleId: 'instr/import-unresolved',
      }),
      skip('mcp-server', HOSTILE.links, 'url-without-type', {
        name: HOSTILE.mentions,
        ruleId: 'evil:rule,title=x',
        fix: 'review',
      }),
      skip('skill', `.agents/skills/${HOSTILE.bidiOverride}/SKILL.md`, 'no-description', {
        size: size(8),
      }),
      skip('hook', HOSTILE.tablePipes, 'unknown-event', { name: HOSTILE.issueRefs }),
    ],
  });
  const claudePlan = plan('claude-code', {
    entries: [entry('rule', HOSTILE.stopCommands, { trigger: 'on-path', size: size(40) })],
  });
  return {
    ...makeResult({ findings, score: { score: 10, grade: 'F', capped: false } }),
    context: contextReport([claudePlan, hostilePlan]),
  };
})();
