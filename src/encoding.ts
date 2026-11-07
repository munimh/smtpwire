// Byte-level encoders: UTF-8, base64, quoted-printable (RFC 2045) and helpers.

const utf8Encoder = new TextEncoder();

/** Encodes a string as UTF-8 bytes. */
export function utf8(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding, without line breaks. Works on any runtime. */
export function base64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + "=";
  }
  return out;
}

/** Base64 of a UTF-8 string. */
export function base64Text(text: string): string {
  return base64(utf8(text));
}

/** Base64 split into CRLF-separated lines of at most 76 characters (no trailing CRLF). */
export function base64Body(bytes: Uint8Array): string {
  const flat = base64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < flat.length; i += 76) lines.push(flat.slice(i, i + 76));
  return lines.join("\r\n");
}

/** Converts every line break (CRLF, bare LF, bare CR) to CRLF. */
export function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\r\n");
}

/** `true` when every character is 7-bit ASCII. */
export function isSevenBit(text: string): boolean {
  // deno-lint-ignore no-control-regex
  return /^[\x00-\x7f]*$/.test(text);
}

const HEX = "0123456789ABCDEF";

/** `=XX` for one byte. */
export function hexEscape(byte: number): string {
  return "=" + HEX[byte >> 4]! + HEX[byte & 15]!;
}

/**
 * Quoted-printable encoding of text whose line breaks are CRLF. Hard line breaks are
 * kept, encoded lines are at most 76 characters, and trailing whitespace is escaped.
 * Lines starting with `.` or `From ` are escaped so naive relays cannot mangle them.
 */
export function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\r\n")) {
    const bytes = utf8(line);
    let current = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const last = i === bytes.length - 1;
      let token: string;
      if (i === 0 && (b === 0x2e || (b === 0x46 && line.startsWith("From ")))) {
        token = hexEscape(b);
      } else if ((b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last)) {
        token = String.fromCharCode(b);
      } else {
        token = hexEscape(b);
      }
      if (current.length + token.length > 75) {
        out.push(current + "=");
        current = "";
      }
      current += token;
    }
    out.push(current);
  }
  return out.join("\r\n");
}

/** The body encoding chosen for a text part. */
export type TextEncoding = "7bit" | "quoted-printable" | "base64";

/**
 * Picks the encoding for a text body (already CRLF). Plain ASCII with short enough
 * lines goes as 7bit; mostly-ASCII text as quoted-printable; anything else as base64.
 */
export function chooseTextEncoding(text: string): TextEncoding {
  const bytes = utf8(text);
  let escaped = 0;
  let lineLength = 0;
  let longest = 0;
  let eightBit = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 13 && bytes[i + 1] === 10) {
      longest = Math.max(longest, lineLength);
      lineLength = 0;
      i++;
      continue;
    }
    lineLength++;
    if (b > 126 || b === 0) eightBit = true;
    if (b > 126 || (b < 32 && b !== 9) || b === 61) escaped++;
  }
  longest = Math.max(longest, lineLength);
  if (!eightBit && longest <= 998) return "7bit";
  // Quoted-printable keeps mostly-Latin text readable in raw form; once a third of the
  // bytes need escaping (Cyrillic, CJK, emoji-heavy text) base64 is clearly smaller.
  return escaped * 3 <= bytes.length ? "quoted-printable" : "base64";
}

/** Random lowercase hex string of `byteCount` bytes. */
export function randomHex(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  let out = "";
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out.toLowerCase();
}
