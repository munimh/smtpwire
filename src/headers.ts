// Header formatting: RFC 2047 encoded-words, RFC 5322 folding, addresses and
// RFC 2231 parameters. Every function rejects CR, LF and NUL in its input.

import { MessageError } from "./errors.ts";
import { base64, hexEscape, isSevenBit, utf8 } from "./encoding.ts";

/** Preferred maximum line length for headers (RFC 5322 section 2.1.1). */
const LINE = 78;
/** Maximum length of one encoded-word (RFC 2047 section 2). */
const WORD = 75;
/** Plain words longer than this are encoded so lines never approach the 998 limit. */
const MAX_PLAIN_WORD = 900;

/** Throws a {@linkcode MessageError} when `value` contains CR, LF or NUL. */
export function assertSingleLine(value: string, what: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new MessageError(`${what} must not contain line breaks or NUL characters`);
  }
}

/**
 * Joins `parts` after `Name:` with single spaces, folding at those spaces so that
 * lines stay within 78 characters where possible. Returns the header without a final CRLF.
 */
export function fold(name: string, parts: readonly string[]): string {
  const lines: string[] = [];
  let line = name + ":";
  let hasContent = false;
  for (const part of parts) {
    if (hasContent && part !== "" && line.length + 1 + part.length > LINE) {
      lines.push(line);
      line = " " + part;
    } else {
      line += " " + part;
    }
    hasContent = true;
  }
  lines.push(line);
  return lines.join("\r\n");
}

// Characters that may stay literal inside a Q-encoded word in any header position
// (RFC 2047 section 5, rule 3: the most restrictive set).
const Q_SAFE = /^[A-Za-z0-9!*+\-/]$/;

function qToken(char: string): string {
  if (char === " ") return "_";
  if (Q_SAFE.test(char)) return char;
  let out = "";
  for (const b of utf8(char)) out += hexEscape(b);
  return out;
}

/**
 * Encodes `text` as a sequence of RFC 2047 encoded-words, never splitting a
 * character. The first word is limited to `firstMax` characters so it fits after the
 * header name. Q or B encoding is chosen per value, whichever is shorter.
 */
export function encodeWords(text: string, firstMax: number = WORD): string[] {
  const chars = Array.from(text);
  const qLength = chars.reduce((n, c) => n + qToken(c).length, 0);
  const bLength = Math.ceil(utf8(text).length / 3) * 4;
  const useQ = qLength <= bLength;
  const prefix = useQ ? "=?UTF-8?Q?" : "=?UTF-8?B?";
  const overhead = prefix.length + 2;

  const words: string[] = [];
  let max = Math.max(firstMax, overhead + 12);
  let q = "";
  let bytes: number[] = [];
  const flush = () => {
    const payload = useQ ? q : base64(Uint8Array.from(bytes));
    if (payload) words.push(prefix + payload + "?=");
    q = "";
    bytes = [];
    max = WORD;
  };
  for (const char of chars) {
    if (useQ) {
      const token = qToken(char);
      if (q && overhead + q.length + token.length > max) flush();
      q += token;
    } else {
      const charBytes = utf8(char);
      const nextLength = Math.ceil((bytes.length + charBytes.length) / 3) * 4;
      if (bytes.length && overhead + nextLength > max) flush();
      bytes.push(...charBytes);
    }
  }
  flush();
  return words;
}

/**
 * Formats an unstructured header such as `Subject`. ASCII text is folded at spaces;
 * anything else becomes encoded-words.
 */
export function unstructured(name: string, value: string): string {
  assertSingleLine(value, `The ${name} header`);
  const parts = value.split(" ");
  // Plain text that looks like an encoded-word would be decoded by mail clients, so it is
  // encoded too (RFC 2047 section 5 forbids leaving such text as-is).
  if (
    /^[\x20-\x7e\t]*$/.test(value) && !value.includes("=?") &&
    parts.every((p) => p.length <= MAX_PLAIN_WORD)
  ) {
    return fold(name, parts);
  }
  return fold(name, encodeWords(value, LINE - name.length - 2));
}

/** A mailbox: an email address with an optional display name. */
export interface Mailbox {
  /** Display name, for example `Jane Doe`. May contain any Unicode text. */
  name?: string;
  /** The email address, for example `jane@example.com`. */
  address: string;
}

/** An address given as `"jane@example.com"`, `"Jane Doe <jane@example.com>"` or a {@linkcode Mailbox}. */
export type Address = string | Mailbox;

const ADDRESS = /^[^\s<>()[\],;:"@\\]+@[^\s<>()[\],;:"@\\]+$/;

/** Validates and normalises one address. */
export function parseAddress(input: Address, what: string): Mailbox {
  let name: string | undefined;
  let address: string;
  if (typeof input === "string") {
    assertSingleLine(input, what);
    const match = /^\s*(.*?)\s*<([^<>]*)>\s*$/.exec(input);
    if (match) {
      name = match[1]!.replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1") || undefined;
      address = match[2]!.trim();
    } else {
      address = input.trim();
    }
  } else {
    if (input === null || typeof input !== "object" || typeof input.address !== "string") {
      throw new MessageError(`${what} must be a string or an object with an address`);
    }
    name = input.name;
    address = input.address.trim();
  }
  assertSingleLine(address, what);
  if (name !== undefined) assertSingleLine(name, `The display name in ${what}`);
  if (!isSevenBit(address)) {
    throw new MessageError(
      `${what} contains non-ASCII characters; internationalised addresses are not supported`,
    );
  }
  if (!ADDRESS.test(address)) throw new MessageError(`${what} is not a valid address: ${address}`);
  return name ? { name, address } : { address };
}

const PLAIN_PHRASE = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/;

function phraseParts(name: string, firstMax: number): string[] {
  if (!isSevenBit(name) || name.length > MAX_PLAIN_WORD || name.includes("=?")) {
    return encodeWords(name, firstMax);
  }
  if (PLAIN_PHRASE.test(name) && !/^ | $| {2}/.test(name)) return name.split(" ");
  return ['"' + name.replace(/(["\\])/g, "\\$1") + '"'];
}

/** Formats an address header (`From`, `To`, `Cc`, `Reply-To`) with folding between and within names. */
export function addressHeader(name: string, mailboxes: readonly Mailbox[]): string {
  const parts: string[] = [];
  mailboxes.forEach((mailbox, index) => {
    // The first encoded-word must also fit on the line that starts with the header name.
    const firstMax = index === 0 ? LINE - name.length - 2 : WORD;
    const own = mailbox.name
      ? [...phraseParts(mailbox.name, firstMax), `<${mailbox.address}>`]
      : [mailbox.address];
    if (index < mailboxes.length - 1) own[own.length - 1] += ",";
    parts.push(...own);
  });
  return fold(name, parts);
}

const TOKEN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

/**
 * Formats one MIME parameter as one or more header parts (each ending with `;` except
 * the last one, which the caller handles). ASCII values are quoted; others use
 * RFC 2231 `name*=UTF-8''...` with continuations for long values.
 */
export function parameter(attribute: string, value: string): string[] {
  assertSingleLine(value, `The ${attribute} parameter`);
  if (isSevenBit(value) && value.length <= 60) {
    return [
      TOKEN.test(value)
        ? `${attribute}=${value}`
        : `${attribute}="${value.replace(/(["\\])/g, "\\$1")}"`,
    ];
  }
  const pieces: string[] = [];
  let current = "UTF-8''";
  for (const char of value) {
    let encoded = "";
    if (ATTR_CHAR.test(char)) encoded = char;
    else for (const b of utf8(char)) encoded += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    if (current.length + encoded.length > 60) {
      pieces.push(current);
      current = "";
    }
    current += encoded;
  }
  pieces.push(current);
  if (pieces.length === 1) return [`${attribute}*=${pieces[0]}`];
  return pieces.map((piece, i) => `${attribute}*${i}*=${piece}`);
}

/** Formats a header such as `Content-Type: text/plain; charset=UTF-8` with folding. */
export function headerWithParameters(
  name: string,
  value: string,
  params: ReadonlyArray<readonly [string, string]>,
): string {
  const parts = [value];
  for (const [attribute, paramValue] of params) {
    for (const piece of parameter(attribute, paramValue)) {
      parts[parts.length - 1] += ";";
      parts.push(piece);
    }
  }
  return fold(name, parts);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An RFC 5322 date-time in UTC, for example `Fri, 06 Nov 2026 09:05:00 +0000`. */
export function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new MessageError("The date is not a valid Date");
  const two = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[date.getUTCDay()]}, ${two(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:` +
    `${two(date.getUTCSeconds())} +0000`;
}

/** RFC 5322 field name: printable ASCII except colon. */
export const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]+$/;
