import { describe, expect, it } from 'vitest';
import { encodingRule } from '../../../src/rules/instructions/encoding.js';
import { findings, lint } from '../../helpers/lint.js';
import { fixFiles, repairs, selectRule } from './fix-helpers.js';

const RULE = 'instr/encoding';
const rules = [encodingRule];

function utf16le(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[3 + i * 2] = code >> 8;
  }
  return bytes;
}

function utf16be(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xfe;
  bytes[1] = 0xff;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2] = code >> 8;
    bytes[3 + i * 2] = code & 0xff;
  }
  return bytes;
}

/** "Değişiklik" encoded as Windows-1254 (Turkish): not valid UTF-8. */
const WINDOWS_1254 = new Uint8Array([
  0x23, 0x20, 0x54, 0x69, 0x74, 0x6c, 0x65, 0x0a, 0x44, 0x65, 0xf0, 0x69, 0xfe, 0x69, 0x6b, 0x6c,
  0x69, 0x6b, 0x0a,
]);

describe('instr/encoding', () => {
  it('reports a UTF-16 AGENTS.md as an error for Codex', () => {
    const result = lint({ 'AGENTS.md': utf16le('# Rules\nUse pnpm.\n') }, { rules });
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'error',
        path: 'AGENTS.md',
        message:
          'This file is encoded as UTF-16 (little-endian). Codex reads it as UTF-8, so the text arrives garbled, with NUL characters between the letters.',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      },
    ]);
    expect(result.findings[0]?.platforms).toEqual(['codex']);
  });

  it('reports a big-endian UTF-16 GEMINI.md as an error for Gemini CLI', () => {
    const result = lint({ 'GEMINI.md': utf16be('Use pnpm.') }, { rules });
    expect(findings(result, RULE).map((finding) => [finding.severity, finding.message])).toEqual([
      [
        'error',
        'This file is encoded as UTF-16 (big-endian). Gemini CLI reads it as UTF-8, so the text arrives garbled, with NUL characters between the letters.',
      ],
    ]);
  });

  it('reports a UTF-16 CLAUDE.md as info, because Claude Code does not document its decoding', () => {
    const result = lint({ 'CLAUDE.md': utf16le('Use pnpm.') }, { rules });
    expect(findings(result, RULE).map((finding) => [finding.severity, finding.message])).toEqual([
      [
        'info',
        'This file is encoded as UTF-16 (little-endian). Claude Code, GitHub Copilot, Cursor and Devin Local do not document UTF-16 support; save it as UTF-8.',
      ],
    ]);
  });

  it('reports invalid UTF-8 in AGENTS.md as a warning at the first invalid byte', () => {
    const result = lint({ 'AGENTS.md': WINDOWS_1254 }, { rules });
    expect(findings(result, RULE)).toEqual([
      {
        ruleId: RULE,
        severity: 'warn',
        path: 'AGENTS.md',
        message:
          'This file is not valid UTF-8 (first invalid byte on line 2). Codex replaces the invalid bytes with U+FFFD replacement characters, so the original characters are lost.',
        range: { start: { line: 2, column: 3 }, end: { line: 2, column: 4 } },
      },
    ]);
  });

  it('reports invalid UTF-8 in a Cursor rule as info', () => {
    const result = lint({ '.cursor/rules/style.mdc': WINDOWS_1254 }, { rules });
    expect(findings(result, RULE).map((finding) => [finding.severity, finding.message])).toEqual([
      [
        'info',
        'This file is not valid UTF-8 (first invalid byte on line 2). Save it as UTF-8 so agents read every character as written.',
      ],
    ]);
  });

  it('uses the verified reader only when it is targeted', () => {
    const result = lint({ 'AGENTS.md': utf16le('x') }, { rules, targets: ['cursor'] });
    expect(findings(result, RULE).map((finding) => finding.severity)).toEqual(['info']);
    expect(result.findings[0]?.platforms).toEqual(['cursor']);
  });

  it('reports a file that is UTF-16 and also malformed once', () => {
    const odd = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42]);
    const result = lint({ 'AGENTS.md': odd }, { rules });
    expect(findings(result, RULE).map((finding) => finding.severity)).toEqual(['error']);
  });

  describe('does not report', () => {
    it.each([
      ['UTF-8 Turkish and emoji', 'Değişiklikleri test et. 🚀 İstanbul ıüğşçö\n'],
      ['UTF-8 with a byte order mark', '\uFEFF# Rules\n'],
      ['an empty file', ''],
      ['a literal replacement character', 'The \uFFFD character marks bad bytes.\n'],
    ])('%s', (_label, text) => {
      const result = lint({ 'AGENTS.md': text, 'CLAUDE.md': text }, { rules });
      expect(findings(result, RULE)).toEqual([]);
    });

    it('files no targeted platform reads', () => {
      const result = lint({ 'CLAUDE.md': utf16le('x') }, { rules, targets: ['codex'] });
      expect(findings(result, RULE)).toEqual([]);
    });
  });
});

describe('instr/encoding fix', () => {
  it('converts UTF-16 to UTF-8 without a byte order mark, as a safe fix', () => {
    const result = lint({ 'AGENTS.md': utf16le('# Rules\r\nUse pnpm.\r\n') }, { rules });
    expect(repairs(result, RULE)).toEqual([
      {
        path: 'AGENTS.md',
        fix: {
          id: `${RULE}#utf-8`,
          class: 'safe',
          title: 'Convert AGENTS.md from UTF-16 (little-endian) to UTF-8',
          changes: [{ kind: 'encoding', path: 'AGENTS.md', to: 'utf-8', bom: false }],
        },
      },
    ]);
    const run = fixFiles(
      { 'AGENTS.md': utf16le('# Rules\r\nUse pnpm.\r\n') },
      { rules },
      selectRule(RULE, ['safe']),
    );
    expect(new TextDecoder().decode(run.snapshot.files[0]?.bytes)).toBe('# Rules\r\nUse pnpm.\r\n');
    expect(run.verification).toMatchObject({ resolved: 1, introduced: [] });
  });

  it('also converts a UTF-16 file whose readers do not document UTF-16 (an info finding)', () => {
    const result = lint({ 'CLAUDE.md': utf16le('Use pnpm.') }, { rules });
    expect(repairs(result, RULE)[0]?.fix?.class).toBe('safe');
  });

  describe('leaves to the user', () => {
    it('UTF-16 with bytes that do not decode', () => {
      const odd = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42]);
      expect(repairs(lint({ 'AGENTS.md': odd }, { rules }), RULE)).toEqual([
        {
          path: 'AGENTS.md',
          guidance:
            'save the file as UTF-8 in an editor that shows it correctly; some of its bytes are not valid UTF-16 (little-endian), so agentcheckup does not convert it',
        },
      ]);
    });

    it('invalid UTF-8, whose original encoding only the author knows', () => {
      expect(repairs(lint({ 'AGENTS.md': WINDOWS_1254 }, { rules }), RULE)).toEqual([
        {
          path: 'AGENTS.md',
          guidance:
            'open the file in the encoding it was written in, such as Windows-1252, and save it as UTF-8',
        },
      ]);
    });

    it('a file reached through a symbolic link', () => {
      const result = lint(
        { 'AGENTS.md': utf16le('Use pnpm.') },
        { rules, symlinks: { 'AGENTS.md': 'shared/rules.md' } },
      );
      expect(repairs(result, RULE)).toEqual([
        {
          path: 'AGENTS.md',
          guidance:
            'save the file as UTF-8 by hand: "AGENTS.md" is a symbolic link to "shared/rules.md"',
        },
      ]);
    });
  });
});
