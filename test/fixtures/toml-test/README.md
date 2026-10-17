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
  decoded; invalid UTF-8 is visible there as `hadDecodeErrors`, not in the text, and
  `parseToml` reports it as `invalid-utf8` when the caller passes the decoding.
- **Moved to `toml-1.1/`: 15 cases that are valid TOML 1.1.** Codex reads its configuration
  with toml 0.9.11+spec-1.1.0 and toml_parser 1.1.3+spec-1.1.0 (`codex-rs/Cargo.lock` at
  openai/codex ce0323f), which read TOML 1.1, and so does agentcheckup. These cases must parse
  to the values that crate builds:
  - invalid in 1.0, valid in 1.1, in `toml-1.1/invalid/`: `datetime/no-secs.toml`,
    `inline-table/linebreak-01.toml` to `linebreak-04.toml`, `inline-table/trailing-comma.toml`,
    `local-datetime/no-secs.toml`, `local-time/no-secs.toml`, `string/basic-byte-escapes.toml`.
    They have no tagged JSON; the expected values are in `test/parse/toml.test.ts`
    (`TOML_11_VALUES`);
  - valid in 1.1 only (listed in `files-toml-1.1.0`, not in `files-toml-1.0.0`), in
    `toml-1.1/valid/` with their tagged JSON: `datetime/no-seconds`, `inline-table/newline`,
    `inline-table/newline-comment`, `key/empty-05`, `string/escape-esc`, `string/hex-escape`.
- **Kept, with a different expectation: 1 encoding case.** `invalid/encoding/utf16-bom.toml`
  gives `utf-16`: agentcheckup does not parse UTF-16 text. `bom-not-at-start-02.toml` and
  `bom-not-at-start-03.toml` (two byte order marks) are syntax errors, as for the crate, which
  skips only the first mark.

Every other case is here: 208 valid cases with their tagged JSON in `valid/`, and 484 invalid
cases in `invalid/`, which must each give a syntax error, except `utf16-bom.toml`.

## Updating

Clone toml-test outside this repository, check out the new commit, copy the cases the same way,
update the commit above, and run `pnpm vitest run test/parse/toml.test.ts`. Files under
`test/fixtures/` are byte-exact inputs: do not reformat them.
