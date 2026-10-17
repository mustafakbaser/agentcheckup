/**
 * Richer scan feedback (docs/adr/0008-write-fixes-to-the-scanned-repository.md): what each agent
 * misses, `why`, `fix` and `how` lines, fix counts, rule-doc hyperlinks, and the same
 * information in Markdown, GitHub annotations and SARIF, on the demo repository of the fix
 * design and on hostile input.
 */
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../../src/core/engine.js';
import { rebaseResult } from '../../src/core/rebase.js';
import type { Finding, Fix } from '../../src/core/types.js';
import {
  DETAIL_LEVELS,
  docsUrl,
  firstParagraph,
  fixCounts,
  fixOf,
  guidanceOf,
  impactOf,
  isDetailLevel,
  joinNames,
  needsWords,
  planIndex,
  whyText,
} from '../../src/report/feedback.js';
import { formatContextMarkdown } from '../../src/report/context-markdown.js';
import { formatContextText } from '../../src/report/context-text.js';
import { formatGithub } from '../../src/report/github.js';
import { formatMarkdown } from '../../src/report/markdown.js';
import { formatSarif, toSarif, toSarifFix } from '../../src/report/sarif.js';
import { formatStylish, plainStyle } from '../../src/report/stylish.js';
import { contextReport, plan, size, skip } from '../helpers/context.js';
import {
  DEMO_FINDINGS,
  DEMO_RULES,
  demoBaselineResult,
  demoResult,
  hostileDemoResult,
} from './demo.js';
import { at, finding, makeResult, richResult, rule } from './fixtures.js';
import { HOSTILE_ALL, hostileResult } from './hostile.js';
import {
  ansiStyle,
  hasEscOrBel,
  parseWorkflowCommand,
  stripKnownSgr,
  tagStyle,
  unsafeCodePoints,
} from './safety.js';

const plain = (
  result: ScanResult,
  options: Omit<Parameters<typeof formatStylish>[1], 'style'> = {},
) => formatStylish(result, { style: plainStyle, ...options });

function lines(output: string): string[] {
  return output === '' ? [] : output.replace(/\n$/, '').split('\n');
}

const sarifSchema = JSON.parse(
  readFileSync(new URL('../schemas/sarif-2.1.0.json', import.meta.url), 'utf8'),
) as object;
const validateSarif = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(
  sarifSchema,
);

const OSC8 = '\u001b]8;;';
const ST = '\u001b\\';

/**
 * The OSC 8 sequences in `text` (an opening one carries a URL, a closing one an empty string)
 * and the text without them.
 */
function osc8(text: string): { readonly urls: string[]; readonly rest: string } {
  const urls: string[] = [];
  let rest = '';
  let from = 0;
  for (;;) {
    const start = text.indexOf(OSC8, from);
    const end = start < 0 ? -1 : text.indexOf(ST, start + OSC8.length);
    if (end < 0) break;
    urls.push(text.slice(start + OSC8.length, end));
    rest += text.slice(from, start);
    from = end + ST.length;
  }
  return { urls, rest: rest + text.slice(from) };
}

describe('feedback helpers', () => {
  it('names the detail levels', () => {
    expect(DETAIL_LEVELS).toEqual(['compact', 'default', 'verbose']);
    expect(isDetailLevel('verbose')).toBe(true);
    expect(isDetailLevel('VERBOSE')).toBe(false);
    expect(isDetailLevel('toString')).toBe(false);
  });

  it('builds docs URLs only for plain rule ids', () => {
    expect(docsUrl('cursor/md-file-ignored')).toBe(
      'https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/cursor/md-file-ignored.md',
    );
    for (const id of ['evil:rule,title=x', '../x/y', 'a/b/c', 'A/b', 'a/b\u001b', 'a/-b', '']) {
      expect(docsUrl(id)).toBeUndefined();
    }
  });

  it('shows no fix or guidance for a suppressed finding, and no opt-in fix in a pull request', () => {
    const fix = DEMO_FINDINGS[3]!.fix!;
    const active = finding(DEMO_RULES.shadowed, 'AGENTS.md', 'x', { fix, guidance: 'do it' });
    const suppressed = { ...active, suppressed: { kind: 'inline' as const, reason: 'ok' } };
    expect(fixOf(active, 'terminal')).toBe(fix);
    expect(fixOf(suppressed, 'terminal')).toBeUndefined();
    expect(guidanceOf(active)).toBe('do it');
    expect(guidanceOf(suppressed)).toBeUndefined();
    expect(guidanceOf({ ...active, guidance: ' \n' })).toBeUndefined();

    const secret = finding(rule('mcp/literal-secret', 'risk', 'error'), '.mcp.json', 'x', {
      fix: { ...fix, id: 'mcp/literal-secret#env', class: 'review' },
    });
    expect(fixOf(secret, 'terminal')?.class).toBe('review');
    expect(fixOf(secret, 'pull-request')).toBeUndefined();
    expect(fixCounts([active, suppressed, secret], 'terminal')).toEqual({
      safe: 1,
      review: 1,
      input: 0,
      manual: 0,
    });
    expect(fixCounts([active, suppressed, secret], 'pull-request')).toEqual({
      safe: 1,
      review: 0,
      input: 0,
      manual: 1,
    });
  });

  describe('a fix that needs the user’s words', () => {
    const meta = rule('skill/description-quality', 'clarity', 'info');
    const words: Fix = {
      id: 'skill/description-quality#when-clause',
      class: 'review',
      title: 'Add a "Use when ..." sentence to "description" in skills/pdf/SKILL.md',
      changes: [],
      input: {
        field: 'skill-when-clause',
        question: 'Add a sentence that says when to use this skill?',
        label: 'a "Use when ..." clause',
        initial: 'Use when ',
        target: {
          kind: 'frontmatter',
          path: 'skills/pdf/SKILL.md',
          key: 'description',
          prefix: 'Extracts text. ',
        },
      },
    };
    const asking = finding(meta, 'skills/pdf/SKILL.md', 'The description does not say when.', {
      fix: words,
      range: at(3, 14, 3, 29),
    });
    const ready = finding(DEMO_RULES.shadowed, 'AGENTS.md', 'x', {
      fix: DEMO_FINDINGS[3]!.fix!,
    });
    const result = makeResult({ findings: [asking, ready] });

    it('is counted apart from fixes that need review, in every channel', () => {
      expect(needsWords(words)).toBe(true);
      expect(needsWords(DEMO_FINDINGS[3]!.fix!)).toBe(false);
      for (const channel of ['terminal', 'pull-request'] as const) {
        expect(fixCounts([asking, ready], channel)).toEqual({
          safe: 1,
          review: 0,
          input: 1,
          manual: 0,
        });
      }
    });

    it('reads "needs your words (fix -i)" in stylish and GitHub output, never "fixable (review)"', () => {
      const compact = plain(result, { level: 'compact' });
      const fixLines = (output: string): string[] =>
        lines(output).filter((line) => line.includes('your words') || line.includes('Fixes:'));
      expect(compact).not.toContain('fixable (review)');
      expect(fixLines(compact)).toMatchInlineSnapshot(`
        [
          "  3:14  info  The description does not say when.  skill/description-quality  needs your words (fix -i)",
        ]
      `);
      expect(fixLines(plain(result))).toMatchInlineSnapshot(`
        [
          "              fix  needs your words (fix -i): Add a "Use when ..." sentence to "description" in skills/pdf/SKILL.md",
          "Fixes: 1 safe (agentcheckup fix --write) · 1 needs your words (agentcheckup fix -i)",
        ]
      `);
      const annotation = lines(formatGithub(result)).find((line) =>
        line.includes('skill/description-quality'),
      );
      expect(annotation?.split('%0A')).toMatchInlineSnapshot(`
        [
          "::notice file=skills/pdf/SKILL.md,line=3,col=14,endLine=3,endColumn=29,title=skill/description-quality (fix%3A needs your words)::The description does not say when.",
          "Fix (needs your words, agentcheckup fix -i): Add a "Use when ..." sentence to "description" in skills/pdf/SKILL.md",
          "Docs: https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/skill/description-quality.md",
        ]
      `);
    });

    it('reads "needs your words (fix -i)" in Markdown, with the command after the preview line', () => {
      const output = formatMarkdown(result);
      const row = output.split('\n').find((line) => line.includes('skill/description-quality'));
      expect(row?.endsWith(' | needs your words (fix -i) |')).toBe(true);
      expect(output).not.toMatch(/description-quality.*\| review \|/);
      expect(output).toContain(
        '\n\nPreview 1 fix locally: `npx agentcheckup fix` · 1 needs your words: `npx agentcheckup fix -i`\n\n',
      );
      // Only fixes that need words: no preview, but the command that asks for them.
      const alone = formatMarkdown(makeResult({ findings: [asking, asking] }));
      expect(alone).toContain('\n\n2 fixes need your words: `npx agentcheckup fix -i`\n\n');
      expect(alone).not.toContain('Preview');
      expect(formatMarkdown(result, { level: 'compact' })).not.toContain('your words');
    });

    it('marks the SARIF result with "needs your words (fix -i)" and offers no SARIF fix', () => {
      const log = toSarif(result);
      const [words, safe] = log.runs[0].results;
      expect(words?.ruleId).toBe('skill/description-quality');
      expect(words?.fixes).toBeUndefined();
      expect(words?.properties).toEqual({ fix: 'needs your words (fix -i)' });
      // A ready fix keeps its SARIF form and gets no such property.
      expect(safe?.fixes?.[0]?.properties).toEqual({ class: 'safe' });
      expect(safe?.properties).toBeUndefined();
      const parsed = JSON.parse(formatSarif(result)) as object;
      expect(validateSarif(parsed), JSON.stringify(validateSarif.errors)).toBe(true);
    });
  });

  it('joins names and takes the first paragraph', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['Codex'])).toBe('Codex');
    expect(joinNames(['Codex', 'Cursor'])).toBe('Codex and Cursor');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
    expect(firstParagraph('\n\n  One\n  two.\n\nThree.')).toBe('One two.');
    expect(firstParagraph('')).toBe('');
  });

  it('says what the plans add: tokens missed, who still loads the file', () => {
    expect(whyText({ skippers: ['Cursor'], tokens: 310, loaders: [] }, '≈')).toBe(
      'Cursor never loads these ≈310 tokens.',
    );
    expect(whyText({ skippers: ['Claude Code'], tokens: 1, loaders: ['Codex'] }, '~')).toBe(
      'Claude Code never loads these ~1 token; Codex does.',
    );
    expect(whyText({ skippers: ['Codex', 'Cursor'], tokens: 1234, loaders: ['A', 'B'] }, '≈')).toBe(
      'Codex and Cursor never load these ≈1,234 tokens; A and B do.',
    );
    expect(whyText({ skippers: ['Codex'], loaders: ['Claude Code', 'Cursor'] }, '≈')).toBe(
      'Claude Code and Cursor still load it.',
    );
    expect(whyText({ skippers: ['Codex'], loaders: ['Cursor'] }, '≈')).toBe(
      'Cursor still loads it.',
    );
  });

  it('adds no why line when the plans know nothing the message lacks', () => {
    const plans = planIndex(demoResult);
    const facts = DEMO_FINDINGS.map((item) => plans.facts(item));
    // The import of a missing file and the MCP server: no size, nobody else loads them.
    expect(facts.map((item) => item !== undefined)).toEqual([true, true, false, true, false]);
    expect(planIndex(richResult).facts(richResult.findings[0]!)).toBeUndefined();
    const suppressed = {
      ...DEMO_FINDINGS[3]!,
      suppressed: { kind: 'config' as const, reason: 'r' },
    };
    expect(plans.facts(suppressed)).toBeUndefined();
  });

  it('finds the root plans after a rebase, and only them', () => {
    const rebased = rebaseResult(demoResult, 'sub/dir');
    expect(impactOf(rebased)?.rows.map((row) => row.subject.text)).toEqual([
      'docs',
      'sub/dir/AGENTS.md',
      'docs/setup.md',
      'release-notes',
      'sub/dir/.cursor/rules/style.md',
    ]);
    const facts = planIndex(rebased).facts(rebased.findings[3]!);
    expect(facts).toEqual({ skippers: ['Claude Code'], tokens: 197, loaders: ['Codex', 'Cursor'] });

    const nested = {
      ...demoResult,
      context: contextReport(demoResult.context!.plans.map((item) => ({ ...item, cwd: 'pkg' }))),
    };
    expect(impactOf(nested)?.rows).toEqual([]);
    expect(impactOf(richResult)).toBeUndefined();
  });

  it('leaves out skips whose findings are all suppressed, and files an agent does not read', () => {
    const suppressed: ScanResult = {
      ...demoResult,
      findings: demoResult.findings.map((item) =>
        item.ruleId === 'cursor/md-file-ignored'
          ? { ...item, suppressed: { kind: 'inline', reason: 'Kept for Devin' } }
          : item,
      ),
    };
    const rows = impactOf(suppressed)?.rows ?? [];
    expect(rows.map((row) => row.agent)).toEqual([
      'claude-code',
      'claude-code',
      'claude-code',
      'codex',
    ]);
    expect(
      impactOf(demoResult)?.rows.some((row) => row.subject.text === '.cursor/rules/style.md'),
    ).toBe(true);
  });

  it('lists only the skips a change adds when the baseline has plan deltas', () => {
    const fresh = impactOf(demoBaselineResult, { onlyNew: true });
    expect(fresh?.onlyNew).toBe(true);
    expect(fresh?.rows.map((row) => `${row.agent} ${row.subject.text}`)).toEqual([
      'claude-code AGENTS.md',
      'cursor .cursor/rules/style.md',
    ]);
    expect(impactOf(demoBaselineResult)?.rows).toHaveLength(5);
    // Without plan deltas at the root, the whole state.
    const noDeltas = {
      ...demoBaselineResult,
      baseline: { ...demoBaselineResult.baseline!, context: [] },
    };
    expect(impactOf(noDeltas, { onlyNew: true })).toMatchObject({ onlyNew: false });
    expect(impactOf(noDeltas, { onlyNew: true })?.rows).toHaveLength(5);
  });
});

describe('formatStylish feedback', () => {
  it.each(DETAIL_LEVELS)('demo at the %s level matches the snapshot', async (level) => {
    await expect(plain(demoResult, { level })).toMatchFileSnapshot(
      `__snapshots__/stylish.demo-${level}.txt`,
    );
  });

  it('demo, styled and ASCII, match their snapshots', async () => {
    await expect(formatStylish(demoResult, { style: tagStyle })).toMatchFileSnapshot(
      '__snapshots__/stylish.demo-styled.txt',
    );
    const ascii = plain(demoResult, { ascii: true });
    expect(ascii).toMatch(/^[\t\n\x20-\x7e]*$/);
    await expect(ascii).toMatchFileSnapshot('__snapshots__/stylish.demo-ascii.txt');
  });

  it('defaults to the default level', () => {
    expect(plain(demoResult)).toBe(plain(demoResult, { level: 'default' }));
  });

  it('starts with what each agent misses, then why and fix lines, and ends with the commands', () => {
    const output = plain(demoResult);
    expect(output.startsWith('What each agent misses\n  Claude Code  ')).toBe(true);
    expect(output).toContain(
      '               AGENTS.md is skipped: a CLAUDE.md on the path is read instead (≈197 tokens)      fix: safe\n',
    );
    expect(output).toContain(
      '               docs/setup.md is skipped: CLAUDE.md imports it, but the import does not resolve  manual\n',
    );
    expect(output).toContain(
      '                why  Claude Code never loads these ≈197 tokens; Codex and Cursor do.\n' +
        '                fix  safe: add "@AGENTS.md" as line 1 of CLAUDE.md\n',
    );
    expect(output).toContain(
      '              how  create docs/setup.md or correct the path; no file named setup.md exists\n',
    );
    expect(
      output.endsWith(
        'Fixes: 1 safe (agentcheckup fix --write) · 3 need review (agentcheckup fix -i) · 1 manual\n' +
          'Rule docs: agentcheckup explain <rule-id>\n',
      ),
    ).toBe(true);
  });

  it('keeps the compact level to the findings, with a fixable tag', () => {
    const output = plain(demoResult, { level: 'compact' });
    expect(output).not.toContain('What each agent misses');
    expect(output).not.toMatch(/^ +(?:why|fix|how) {2}/m);
    expect(output).not.toContain('Fixes:');
    expect(output).not.toContain('Rule docs:');
    expect(output).toContain('instr/agents-md-ignored-by-claude  fixable\n');
    expect(output).toContain('cursor/md-file-ignored  fixable (review)\n');
    expect(output).toMatch(/instr\/import-unresolved\n/);
  });

  it('shows rationale, docs and sources only at the verbose level', () => {
    const verbose = plain(demoResult, { level: 'verbose' });
    expect(verbose).toContain(
      '                docs    https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/instr/agents-md-ignored-by-claude.md\n' +
        '                about   Claude Code reads CLAUDE.md, not AGENTS.md. Import it with @AGENTS.md.\n' +
        '                source  Claude Code memory documentation: https://docs.anthropic.com/en/docs/claude-code/memory\n',
    );
    expect(verbose).not.toContain('Second paragraph');
    expect(plain(demoResult)).not.toContain('docs/rules/');
  });

  it('skips the impact summary without load plans, and the footer without fixes', () => {
    const { context: _context, ...withoutContext } = demoResult;
    const noContext = plain(withoutContext);
    expect(noContext).not.toContain('What each agent misses');
    expect(noContext).not.toContain('why  ');
    expect(noContext).toContain('fix  safe: add "@AGENTS.md"');
    const noFixes = plain(
      makeResult({
        findings: [
          finding(DEMO_RULES.unresolved, 'CLAUDE.md', 'Missing.', { guidance: 'Add it.' }),
        ],
        score: { score: 90, grade: 'A', capped: false },
      }),
    );
    expect(noFixes).toContain('how  Add it.');
    expect(noFixes).not.toContain('Fixes:');
    expect(noFixes).toContain('Rule docs: agentcheckup explain <rule-id>');
    expect(plain(makeResult({ score: { score: 100, grade: 'A', capped: false } }))).not.toContain(
      'Rule docs',
    );
  });

  it('caps what each agent misses', () => {
    const skips = Array.from({ length: 14 }, (_, index) =>
      skip('rule', `.cursor/rules/r${String(index).padStart(2, '0')}.md`, 'not-mdc', {
        ruleId: 'cursor/md-file-ignored',
        size: size(40 * (index + 1)),
      }),
    );
    const many = { ...demoResult, context: contextReport([plan('cursor', { skipped: skips })]) };
    const output = plain(many);
    expect(output).toContain('.cursor/rules/r09.md is skipped');
    expect(output).not.toContain('.cursor/rules/r10.md is skipped');
    expect(output).toContain('\n  … and 4 more: agentcheckup context\n');
  });

  it('aligns the fix column, letting very long lines run past it', () => {
    const long = skip('rule', `.cursor/rules/${'x'.repeat(90)}.md`, 'not-mdc', { fix: 'review' });
    const short = skip('rule', '.cursor/rules/a.md', 'not-mdc', { fix: 'safe' });
    const output = plain({
      ...demoResult,
      context: contextReport([plan('cursor', { skipped: [long, short] })]),
    });
    const rows = output.split('\n').slice(1, 3);
    expect(rows[0]).toMatch(
      /^ {2}Cursor {2}\.cursor\/rules\/a\.md is skipped: only \.mdc files are read here {2}fix: safe$/,
    );
    expect(rows[1]).toMatch(/x\.md is skipped: only \.mdc files are read here {2}fix: review$/);
  });
});

describe('OSC 8 hyperlinks', () => {
  it('appear only when the caller turns them on', () => {
    expect(hasEscOrBel(plain(demoResult))).toBe(false);
    expect(hasEscOrBel(formatStylish(demoResult, { style: ansiStyle }))).toBe(true);
    expect(osc8(formatStylish(demoResult, { style: ansiStyle })).urls).toEqual([]);
    const linked = formatStylish(demoResult, { style: ansiStyle, hyperlinks: true });
    const { urls } = osc8(linked);
    expect(urls.filter((url) => url !== '')).toEqual(
      [
        'skill/description-missing',
        'cursor/md-file-ignored',
        'mcp/url-without-type',
        'instr/agents-md-ignored-by-claude',
        'instr/import-unresolved',
      ].map((id) => `https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/${id}.md`),
    );
    expect(urls.filter((url) => url === '')).toHaveLength(5);
    expect(linked).toContain('Rule docs: click a rule id, or agentcheckup explain <rule-id>');
  });

  it('wrap the rule id and nothing else, at every level', () => {
    for (const level of DETAIL_LEVELS) {
      const linked = plain(demoResult, { level, hyperlinks: true });
      expect(linked).toContain(
        '\u001b]8;;https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/cursor/md-file-ignored.md\u001b\\cursor/md-file-ignored\u001b]8;;\u001b\\',
      );
      const stripped = osc8(linked).rest;
      expect(stripped.replace('click a rule id, or ', '')).toBe(plain(demoResult, { level }));
    }
  });

  it('are never written in ASCII mode or for ids that are not plain identifiers', () => {
    expect(hasEscOrBel(plain(demoResult, { ascii: true, hyperlinks: true }))).toBe(false);
    for (const result of [hostileResult, hostileDemoResult]) {
      const linked = formatStylish(result, {
        style: ansiStyle,
        hyperlinks: true,
        showSuppressed: true,
      });
      const { urls: all, rest } = osc8(stripKnownSgr(linked));
      const urls = all.filter((url) => url !== '');
      expect(
        urls.every((url) =>
          /^https:\/\/github\.com\/mustafakbaser\/agentcheckup\/blob\/main\/docs\/rules\/[a-z\d-]+\/[a-z\d-]+\.md$/.test(
            url,
          ),
        ),
      ).toBe(true);
      expect(urls.some((url) => url.includes('evil'))).toBe(false);
      // Every sequence is a docs link; hostile OSC 8 sequences in messages are shown as text.
      expect(hasEscOrBel(rest)).toBe(false);
      expect(unsafeCodePoints(rest, { newline: true })).toEqual([]);
    }
  });
});

describe('hostile text in fixes, guidance and plans', () => {
  it('stylish: no escape, no invisible character, no workflow command at any level', async () => {
    for (const level of DETAIL_LEVELS) {
      for (const result of [hostileDemoResult, hostileResult]) {
        for (const ascii of [false, true]) {
          const output = plain(result, { level, ascii, showSuppressed: true });
          expect(hasEscOrBel(output)).toBe(false);
          expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
          expect(output.split('\n').filter((line) => line.trimStart().startsWith('::'))).toEqual(
            [],
          );
        }
      }
    }
    await expect(plain(hostileDemoResult)).toMatchFileSnapshot(
      '__snapshots__/stylish.hostile-demo.txt',
    );
  });

  it('stylish: each finding stays on its lines, fix titles on one line', () => {
    const output = plain(hostileDemoResult);
    const fix = output.split('\n').filter((line) => /^ +fix {2}/.test(line));
    expect(fix).toHaveLength(2);
    expect(fix[1]).toContain('review: x⏎::warning::fake <img');
  });

  it('markdown: no raw HTML, mentions, links or table breaks', async () => {
    for (const result of [hostileDemoResult, hostileResult]) {
      const output = formatMarkdown(result);
      expect(output).not.toContain('<');
      expect(output).not.toMatch(/@[\p{L}\p{N}]/u);
      expect(output).not.toMatch(/(?<!&)#\d/);
      expect(output).not.toMatch(/javascript:/i);
      expect(output).not.toMatch(/(?<!\\)!\[/);
      expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
    }
    const output = formatMarkdown(hostileDemoResult);
    const table = output.split('\n').filter((line) => line.startsWith('| Cursor |'));
    expect(table).toHaveLength(5);
    for (const row of table) {
      let separators = 0;
      for (let index = 0; index < row.length; index++) {
        if (row.charAt(index) === '\\') index++;
        else if (row.charAt(index) === '|') separators++;
      }
      expect(separators).toBe(5);
    }
    await expect(output).toMatchFileSnapshot('__snapshots__/markdown.hostile-demo.txt');
  });

  it('github: one command per finding, added lines that cannot fake another', async () => {
    const output = formatGithub(hostileDemoResult);
    const commands = lines(output);
    expect(commands).toHaveLength(3);
    for (const line of commands) {
      expect(line).toMatch(/^::(?:error|warning|notice) [^\n\r:]*::[^\n\r]*$/);
      expect(unsafeCodePoints(line, { tab: true })).toEqual([]);
    }
    const parsed = commands.map(parseWorkflowCommand);
    // The message keeps its own lines; every added line starts with its label.
    expect(
      parsed[0]!.data
        .split('\n')
        .slice(2)
        .map((line) => line.split(':')[0]),
    ).toEqual(['Why', 'Fix (safe)', 'Docs']);
    expect(
      parsed[1]!.data
        .split('\n')
        .slice(3)
        .map((line) => line.split(':')[0]),
    ).toEqual(['How', 'Docs']);
    expect(parsed[2]!.properties['title']).toBe('evil:rule,title=x (fix: review)');
    expect(parsed[2]!.data.split('\n')).toEqual([
      'ping @octocat and @github/security-team, mail me@example.com',
      'Fix (review): x⏎::warning::fake <img src=x onerror=alert(1)> <script>alert(1)</script> &lt;b&gt;',
    ]);
    await expect(output).toMatchFileSnapshot('__snapshots__/github.hostile-demo.txt');
  });
});

describe('formatMarkdown feedback', () => {
  it('demo matches the snapshots, compact without any of it', async () => {
    await expect(formatMarkdown(demoResult)).toMatchFileSnapshot('__snapshots__/markdown.demo.txt');
    await expect(formatMarkdown(demoBaselineResult)).toMatchFileSnapshot(
      '__snapshots__/markdown.demo-baseline.txt',
    );
    const compact = formatMarkdown(demoResult, { level: 'compact' });
    expect(compact).not.toContain('What each agent misses');
    expect(compact).not.toContain('| Fix |');
    expect(compact).not.toContain('Preview');
    expect(formatMarkdown(demoResult, { level: 'verbose' })).toBe(formatMarkdown(demoResult));
  });

  it('puts what each agent misses above the findings, and the preview line after them', () => {
    const output = formatMarkdown(demoResult);
    expect(output.indexOf('### What each agent misses')).toBeLessThan(
      output.indexOf('### Findings'),
    );
    expect(output).toContain(
      '| Agent | Not loaded | Why | Fix |\n| :---- | :--------- | :-- | :-- |\n' +
        '| Claude Code | MCP server docs | &quot;url&quot; without &quot;type&quot; | review |\n',
    );
    expect(output).toContain(
      '| Claude Code | docs/setup\\.md | CLAUDE\\.md imports it, but the import does not resolve | — |\n',
    );
    expect(output).toContain('| \\.mcp\\.json:4 | error | ');
    expect(output).toContain(' | — |\n| AGENTS\\.md:1 | warning |');
    expect(output).toContain('\n\nPreview 4 fixes locally: `npx agentcheckup fix`\n\n---\n');
  });

  it('lists only the skips a pull request adds, with a baseline', () => {
    const output = formatMarkdown(demoBaselineResult);
    expect(output).toContain('### What this change makes each agent miss');
    expect(output).not.toContain('### What each agent misses');
    expect(output).not.toContain('release\\-notes | no description');
  });

  it('leaves the table out without plans or skips, and never suggests an opt-in fix', () => {
    expect(formatMarkdown(richResult)).not.toContain('What each agent misses');
    const quiet = {
      ...demoBaselineResult,
      baseline: {
        ...demoBaselineResult.baseline!,
        context: [{ ...demoBaselineResult.baseline!.context[1]! }],
      },
    };
    expect(formatMarkdown(quiet)).not.toContain('agent miss');
    const secret = makeResult({
      findings: [
        finding(rule('mcp/literal-secret', 'risk', 'error'), '.mcp.json', 'Token in plain text.', {
          fix: { ...DEMO_FINDINGS[3]!.fix!, class: 'review' },
        }),
      ],
      score: { score: 50, grade: 'F', capped: true },
    });
    const output = formatMarkdown(secret);
    expect(output).not.toContain('Preview');
    expect(output).toContain(' | — |');
    expect(formatGithub(secret)).not.toContain('fix%3A');
    expect(formatSarif(secret)).not.toContain('"fixes"');
  });

  it('keeps the impact table inside its budget, and the whole comment under the limit', () => {
    const skips = Array.from({ length: 300 }, (_, index) =>
      skip('rule', `.cursor/rules/${'<@'.repeat(80)}${index}.md`, 'not-mdc', {
        ruleId: 'cursor/md-file-ignored',
        size: size(400),
        fix: 'review',
      }),
    );
    const findings: Finding[] = Array.from({ length: 300 }, (_, index) =>
      finding(DEMO_RULES.mdFile, `x${index}.md`, HOSTILE_ALL, { fix: DEMO_FINDINGS[1]!.fix! }),
    );
    const result: ScanResult = {
      ...makeResult({ findings, score: { score: 0, grade: 'F', capped: false } }),
      context: contextReport([plan('cursor', { skipped: skips })]),
    };
    const output = formatMarkdown(result, { maxFindings: 300 });
    expect(output.length).toBeLessThan(65_536);
    const rows = output.split('\n').filter((line) => line.startsWith('| Cursor |'));
    expect(rows.length).toBeLessThanOrEqual(25);
    expect(output).toContain(`Showing ${rows.length} of 300 skips.`);
    expect(output).toContain('Preview 300 fixes locally');
  });
});

describe('formatGithub feedback', () => {
  it('demo matches the snapshot', async () => {
    await expect(formatGithub(demoResult)).toMatchFileSnapshot('__snapshots__/github.demo.txt');
    expect(formatGithub(demoResult, { level: 'verbose' })).toBe(formatGithub(demoResult));
  });

  it('titles a finding with its fix class and adds Why, Fix or How, and Docs lines', () => {
    const parsed = lines(formatGithub(demoResult)).map(parseWorkflowCommand);
    expect(parsed.map((command) => command.properties['title'])).toEqual([
      'skill/description-missing (fix: review)',
      'cursor/md-file-ignored (fix: review)',
      'mcp/url-without-type (fix: review)',
      'instr/agents-md-ignored-by-claude (fix: safe)',
      'instr/import-unresolved',
    ]);
    expect(parsed[3]!.data).toBe(
      'Claude Code reads "CLAUDE.md" in this directory and skips this AGENTS.md.\n' +
        'Why: Claude Code never loads these ≈197 tokens; Codex and Cursor do.\n' +
        'Fix (safe): add "@AGENTS.md" as line 1 of CLAUDE.md\n' +
        'Docs: https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/instr/agents-md-ignored-by-claude.md',
    );
    expect(parsed[4]!.data.split('\n').slice(1)).toEqual([
      'How: create docs/setup.md or correct the path; no file named setup.md exists',
      'Docs: https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/instr/import-unresolved.md',
    ]);
    const compact = lines(formatGithub(demoResult, { level: 'compact' })).map(parseWorkflowCommand);
    expect(compact[3]!.data).toBe(DEMO_FINDINGS[3]!.message);
    expect(compact[3]!.properties['title']).toBe('instr/agents-md-ignored-by-claude (fix: safe)');
  });

  it('cuts long fix titles and guidance', () => {
    const long = finding(DEMO_RULES.unresolved, 'CLAUDE.md', 'x', { guidance: 'g'.repeat(900) });
    const data = parseWorkflowCommand(
      lines(formatGithub(makeResult({ findings: [long] })))[0]!,
    ).data;
    expect(data).toContain(`How: ${'g'.repeat(500)}…`);
    expect(data).not.toContain('g'.repeat(501));
  });
});

describe('SARIF fixes', () => {
  const demoSarif = toSarif(demoResult);
  const results = demoSarif.runs[0].results;

  it('validate against the SARIF 2.1.0 schema', () => {
    for (const result of [demoResult, hostileDemoResult, richResult, hostileResult]) {
      const log = JSON.parse(formatSarif(result)) as object;
      expect(validateSarif(log), JSON.stringify(validateSarif.errors)).toBe(true);
    }
  });

  it('map single-file edits to artifact changes, and nothing else', () => {
    expect(results.map((result) => result.fixes?.length ?? 0)).toEqual([1, 0, 1, 1, 0]);
    expect(results[3]!.fixes).toEqual([
      {
        description: { text: 'add "@AGENTS.md" as line 1 of CLAUDE.md' },
        artifactChanges: [
          {
            artifactLocation: { uri: 'CLAUDE.md', uriBaseId: '%SRCROOT%' },
            replacements: [
              {
                deletedRegion: { charOffset: 0, charLength: 0 },
                insertedContent: { text: '@AGENTS.md\n\n' },
              },
            ],
          },
        ],
        properties: { class: 'safe' },
      },
    ]);
  });

  it('list replacements by offset, deletions without inserted content', () => {
    const fix: Fix = {
      id: 'x/y#z',
      class: 'review',
      title: 'Edit [twice](javascript:x)',
      changes: [
        {
          kind: 'edit',
          path: 'a b/c#.md',
          edits: [
            { offset: 10, length: 3, text: '' },
            { offset: 2, length: 0, text: 'new' },
          ],
        },
      ],
    };
    expect(toSarifFix(fix)).toEqual({
      description: { text: 'Edit \\[twice\\](javascript:x)' },
      artifactChanges: [
        {
          artifactLocation: { uri: 'a%20b/c%23.md', uriBaseId: '%SRCROOT%' },
          replacements: [
            { deletedRegion: { charOffset: 2, charLength: 0 }, insertedContent: { text: 'new' } },
            { deletedRegion: { charOffset: 10, charLength: 3 } },
          ],
        },
      ],
      properties: { class: 'review' },
    });
    const edit = fix.changes[0]!;
    expect(toSarifFix({ ...fix, changes: [edit, edit] })).toBeUndefined();
    expect(
      toSarifFix({ ...fix, changes: [{ kind: 'create', path: 'a', text: 'b' }] }),
    ).toBeUndefined();
    expect(
      toSarifFix({ ...fix, changes: [{ kind: 'edit', path: 'a', edits: [] }] }),
    ).toBeUndefined();
    expect(toSarifFix({ ...fix, changes: [] })).toBeUndefined();
  });

  it('keep inserted text exact but never raw in the output', () => {
    const output = formatSarif(hostileDemoResult);
    expect(hasEscOrBel(output)).toBe(false);
    expect(unsafeCodePoints(output, { newline: true })).toEqual([]);
    const log = JSON.parse(output) as ReturnType<typeof toSarif>;
    const replacements = log.runs[0].results[0]!.fixes![0]!.artifactChanges[0].replacements;
    expect(replacements.map((item) => item.insertedContent?.text)).toEqual([
      '\u001b]8;;https://evil.example\u001b\\x',
      HOSTILE_ALL,
    ]);
    // A suppressed finding's fix is never offered.
    const suppressed = toSarif({
      ...demoResult,
      findings: demoResult.findings.map((item) => ({
        ...item,
        suppressed: { kind: 'config' as const, reason: 'r' },
      })),
    });
    expect(suppressed.runs[0].results.some((result) => result.fixes !== undefined)).toBe(false);
  });
});

describe('context output: fixable skips', () => {
  it('text: each fixable skip ends with its fix class, and a footer counts them', async () => {
    const output = formatContextText(demoResult);
    await expect(output).toMatchFileSnapshot('__snapshots__/context-text.demo.txt');
    expect(output).toMatch(
      /^ {2}AGENTS\.md +a CLAUDE\.md on the path is read instead +instr\/agents-md-ignored-by-claude {2}fix: safe$/m,
    );
    expect(output).toMatch(
      /^ {2}CLAUDE\.md › docs\/setup\.md +the import does not resolve +instr\/import-unresolved$/m,
    );
    expect(output).toContain('\n4 of 5 skips can be fixed: agentcheckup fix\n');
    expect(formatContextText(demoResult, { style: tagStyle })).toContain(
      '<gray>instr/agents-md-ignored-by-claude</gray>  <green>fix: safe</green>',
    );
  });

  it('markdown: a Fix column where a plan has fixable skips, and the same footer', async () => {
    const output = formatContextMarkdown(demoResult);
    await expect(output).toMatchFileSnapshot('__snapshots__/context-markdown.demo.txt');
    expect(output).toContain('| File | Reason | Rule | Fix |');
    expect(output).toContain(
      '| AGENTS\\.md | a CLAUDE\\.md on the path is read instead | [`instr/agents-md-ignored-by-claude`](https://github.com/mustafakbaser/agentcheckup/blob/main/docs/rules/instr/agents-md-ignored-by-claude.md) | safe |',
    );
    expect(output).toContain('\n4 of 5 skips can be fixed: `agentcheckup fix`\n');
  });

  it('adds nothing when no skip can be fixed', () => {
    const unfixable: ScanResult = {
      ...demoResult,
      context: contextReport(
        demoResult.context!.plans.map((item) => ({
          ...item,
          skipped: item.skipped.map(({ fix: _fix, ...rest }) => rest),
        })),
      ),
    };
    expect(formatContextText(unfixable)).not.toContain('fix');
    expect(formatContextMarkdown(unfixable)).not.toContain('| Fix |');
    expect(formatContextMarkdown(unfixable)).not.toContain('can be fixed');
    const one: ScanResult = {
      ...demoResult,
      context: contextReport([
        plan('cursor', { skipped: [skip('rule', 'a.md', 'not-mdc', { fix: 'review' })] }),
      ]),
    };
    expect(formatContextText(one)).toContain('\n1 of 1 skip can be fixed: agentcheckup fix\n');
  });

  it('stays safe with hostile text', () => {
    const text = formatContextText(hostileDemoResult);
    expect(hasEscOrBel(text)).toBe(false);
    expect(unsafeCodePoints(text, { newline: true })).toEqual([]);
    expect(text.split('\n').filter((line) => line.trimStart().startsWith('::'))).toEqual([]);
    const markdown = formatContextMarkdown(hostileDemoResult);
    expect(markdown).not.toContain('<');
    expect(markdown).not.toMatch(/@[\p{L}\p{N}]/u);
    expect(unsafeCodePoints(markdown, { newline: true })).toEqual([]);
  });
});
