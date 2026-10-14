/**
 * How Codex reads AGENTS.md bytes, mirrored from codex-rs/core/src/agents_md.rs:
 * `String::from_utf8_lossy(&data)`, skipped when `text.trim().is_empty()`.
 */
import type { Artifact } from '../../core/types.js';

/**
 * Rust's `char::is_whitespace` (the Unicode White_Space property), which `str::trim` uses.
 * JavaScript's `trim()` differs: it also strips U+FEFF and keeps U+0085.
 */
export function isRustWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** True when `text` is empty or only Rust whitespace. */
export function isBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (!isRustWhitespace(text.charCodeAt(i))) return false;
  }
  return true;
}

const lossyUtf8 = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/**
 * Whether Codex skips these bytes as an empty document. Invalid sequences decode to U+FFFD in
 * both `from_utf8_lossy` and TextDecoder, and U+FFFD is not whitespace, so the answers agree.
 * A UTF-8 byte order mark stays in the text as U+FEFF, which Rust does not trim.
 */
export function codexSeesBlank(bytes: Uint8Array): boolean {
  return isBlank(lossyUtf8.decode(bytes));
}

/**
 * Offset in the artifact's decoded text (UTF-16 code units, BOM removed) of the first character
 * that is not completely inside the first `byteOffset` bytes of the file. A streaming decode
 * holds back an incomplete trailing sequence, so a cut through a multibyte character points at
 * that character.
 */
export function textOffsetAtByte(artifact: Artifact, byteOffset: number): number {
  const { encoding, hasBom } = artifact.decoded;
  const bomLength = hasBom ? (encoding === 'utf-8' ? 3 : 2) : 0;
  if (byteOffset <= bomLength) return 0;
  const decoder = new TextDecoder(encoding, { fatal: false, ignoreBOM: true });
  const prefix = decoder.decode(artifact.file.bytes.subarray(bomLength, byteOffset), {
    stream: true,
  });
  return Math.min(prefix.length, artifact.decoded.text.length);
}
