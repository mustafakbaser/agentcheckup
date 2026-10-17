# toml-test subset

Test cases from [toml-test](https://github.com/toml-lang/toml-test) (MIT, see `LICENSE`), copied
byte for byte from commit `ff49d109861c1ad25af53f687f2aef19ab650600` (2026-09-15).
`test/parse/toml.test.ts` runs them against `src/parse/toml.ts`.

## How the subset was chosen

The cases listed in upstream `tests/files-toml-1.0.0`, with these changes:

- **Left out: 8 byte-level UTF-8 cases** (`invalid/encoding/bad-codepoint.toml`,
  `bad-utf8-at-end.toml`, `bad-utf8-in-array.toml`, `bad-utf8-in-comment.toml`,
  `bad-utf8-in-multiline.toml`, `bad-utf8-in-multiline-literal.toml`, `bad-utf8-in-string.toml`,
  `bad-utf8-in-string-literal.toml`). The parser receives text that `src/core/text.ts` already
  decoded; invalid UTF-8 is visible there as `hadDecodeErrors`, not in the text.
- **Moved to `toml-1.1/`: 15 cases that are valid TOML 1.1.** agentcheckup reports TOML 1.1
  syntax as `unsupported`, so these must give an `unsupported` issue, neither a value nor a
  syntax error:
  - invalid in 1.0, valid in 1.1: `invalid/datetime/no-secs.toml`,
    `invalid/inline-table/linebreak-01.toml` to `linebreak-04.toml`,
    `invalid/inline-table/trailing-comma.toml`, `invalid/local-datetime/no-secs.toml`,
    `invalid/local-time/no-secs.toml`, `invalid/string/basic-byte-escapes.toml`;
  - valid in 1.1 only (listed in `files-toml-1.1.0`, not in `files-toml-1.0.0`):
    `valid/datetime/no-seconds`, `valid/inline-table/newline`,
    `valid/inline-table/newline-comment`, `valid/key/empty-05`, `valid/string/escape-esc`,
    `valid/string/hex-escape` (`.toml` and `.json`).
- **Kept, with a different expectation: 3 encoding cases.** `invalid/encoding/utf16-bom.toml`
  gives `utf-16`, and `bom-not-at-start-02.toml` and `bom-not-at-start-03.toml` (two byte order
  marks) give `bom`: agentcheckup does not parse text with a byte order mark or in UTF-16.

Every other case is here: 208 valid cases with their tagged JSON in `valid/`, and 481 invalid
cases in `invalid/`, which must each give a syntax error.

## Updating

Clone toml-test outside this repository, check out the new commit, copy the cases the same way,
update the commit above, and run `pnpm vitest run test/parse/toml.test.ts`. Files under
`test/fixtures/` are byte-exact inputs: do not reformat them.
