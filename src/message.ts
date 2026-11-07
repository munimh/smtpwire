// Builds an RFC 5322 / MIME message. The output is always 7-bit ASCII with CRLF line
// breaks, so it can be sent through any SMTP server without 8BITMIME or SMTPUTF8.

import { MessageError } from "./errors.ts";
import {
  base64Body,
  chooseTextEncoding,
  quotedPrintable,
  randomHex,
  toCrlf,
  utf8,
} from "./encoding.ts";
import {
  type Address,
  addressHeader,
  assertSingleLine,
  FIELD_NAME,
  formatDate,
  headerWithParameters,
  type Mailbox,
  parseAddress,
  unstructured,
} from "./headers.ts";

/** A file attached to a message, or an inline image referenced from the HTML body. */
export interface Attachment {
  /** The file name shown to the recipient. May contain any Unicode text. */
  filename: string;
  /** The file content. Strings are encoded as UTF-8. */
  content: Uint8Array | string;
  /**
   * The MIME type, for example `application/pdf`. When omitted it is guessed from the
   * file extension, falling back to `application/octet-stream`.
   */
  contentType?: string;
  /**
   * Makes this an inline part that the HTML body can reference as `cid:<contentId>`,
   * for example `<img src="cid:logo@example.com">`. Ignored when there is no HTML body.
   */
  contentId?: string;
}

/** The message to send. */
export interface Message {
  /** The author. Also used as the envelope sender unless `envelope.from` is set. */
  from: Address;
  /** Primary recipients. */
  to?: Address | Address[];
  /** Carbon-copy recipients. */
  cc?: Address | Address[];
  /** Blind-copy recipients. They are added to the envelope only, never to a header. */
  bcc?: Address | Address[];
  /** Where replies should go. */
  replyTo?: Address | Address[];
  /** The subject line. May contain any Unicode text. */
  subject?: string;
  /** The plain-text body. */
  text?: string;
  /** The HTML body. With `text` as well, both are sent as `multipart/alternative`. */
  html?: string;
  /** Files to attach, and inline images when they have a `contentId`. */
  attachments?: Attachment[];
  /**
   * Extra headers such as `In-Reply-To` or `List-Unsubscribe`. Names and values are
   * checked: line breaks are rejected, and headers this library writes itself (such as
   * `From` or `Content-Type`) cannot be set here.
   */
  headers?: Record<string, string> | ReadonlyArray<readonly [string, string]>;
  /** The `Date` header. Defaults to now. */
  date?: Date;
  /**
   * The `Message-ID`, with or without angle brackets. Defaults to a random ID at the
   * sender's domain.
   */
  messageId?: string;
  /** Overrides the SMTP envelope, which otherwise comes from `from`, `to`, `cc` and `bcc`. */
  envelope?: {
    /**
     * The envelope sender (`MAIL FROM`), for example a bounce address. Use `""` for the
     * null sender (`MAIL FROM:<>`) when sending bounces or other automatic replies.
     */
    from?: string;
    /** The envelope recipients (`RCPT TO`). */
    to?: string[];
  };
}

/** The result of {@linkcode composeMessage}. */
export interface ComposedMessage {
  /** The complete message with CRLF line breaks, ready for SMTP `DATA`. */
  raw: string;
  /** The `Message-ID`, including angle brackets. */
  messageId: string;
  /** The SMTP envelope. `to` includes Bcc recipients. */
  envelope: { from: string; to: string[] };
}

const RESERVED = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
  "content-id",
]);

const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

const TYPES: Record<string, string> = {
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  ics: "text/calendar",
  json: "application/json",
  xml: "application/xml",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

function guessType(filename: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase();
  return (ext && TYPES[ext]) || "application/octet-stream";
}

function list(value: Address | Address[] | undefined, what: string): Mailbox[] {
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item, i) => parseAddress(item, items.length > 1 ? `${what}[${i}]` : what));
}

interface Part {
  headers: string[];
  body: string;
}

function textPart(subtype: "plain" | "html", content: string): Part {
  const text = toCrlf(content);
  const encoding = chooseTextEncoding(text);
  const body = encoding === "7bit"
    ? text
    : encoding === "quoted-printable"
    ? quotedPrintable(text)
    : base64Body(utf8(text));
  return {
    headers: [
      headerWithParameters("Content-Type", `text/${subtype}`, [["charset", "UTF-8"]]),
      `Content-Transfer-Encoding: ${encoding}`,
    ],
    body,
  };
}

function attachmentPart(attachment: Attachment, inline: boolean, index: number): Part {
  const what = `attachments[${index}]`;
  if (typeof attachment?.filename !== "string" || attachment.filename === "") {
    throw new MessageError(`${what}.filename is required`);
  }
  const type = attachment.contentType ?? guessType(attachment.filename);
  assertSingleLine(type, `${what}.contentType`);
  if (!MIME_TYPE.test(type)) throw new MessageError(`${what}.contentType is not a MIME type`);
  const bytes = typeof attachment.content === "string"
    ? utf8(attachment.content)
    : attachment.content;
  if (!(bytes instanceof Uint8Array)) {
    throw new MessageError(`${what}.content must be a Uint8Array or a string`);
  }
  const typeParams: Array<[string, string]> = [];
  if (typeof attachment.content === "string" && type.startsWith("text/")) {
    typeParams.push(["charset", "UTF-8"]);
  }
  typeParams.push(["name", attachment.filename]);
  const headers = [
    headerWithParameters("Content-Type", type, typeParams),
    "Content-Transfer-Encoding: base64",
    headerWithParameters("Content-Disposition", inline ? "inline" : "attachment", [[
      "filename",
      attachment.filename,
    ]]),
  ];
  if (inline) headers.push(`Content-ID: <${contentId(attachment.contentId!, what)}>`);
  return { headers, body: base64Body(bytes) };
}

function contentId(id: string, what: string): string {
  assertSingleLine(id, `${what}.contentId`);
  const bare = id.replace(/^<(.*)>$/, "$1");
  if (!/^[\x21-\x7e]+$/.test(bare) || /[<>]/.test(bare)) {
    throw new MessageError(`${what}.contentId must be printable ASCII without spaces or <>`);
  }
  return bare;
}

function multipart(subtype: string, parts: Part[], extra: Array<[string, string]> = []): Part {
  const rendered = parts.map(render);
  let boundary: string;
  do boundary = `=_sw_${randomHex(12)}`; while (rendered.some((r) => r.includes(boundary)));
  const body = rendered.map((r) => `--${boundary}\r\n${r}\r\n`).join("") + `--${boundary}--`;
  return {
    headers: [
      headerWithParameters("Content-Type", `multipart/${subtype}`, [
        ...extra,
        ["boundary", boundary],
      ]),
    ],
    body,
  };
}

function render(part: Part): string {
  return part.headers.join("\r\n") + "\r\n\r\n" + part.body;
}

function normaliseMessageId(id: string | undefined, domain: string): string {
  if (id === undefined) return `<${randomHex(16)}@${domain}>`;
  assertSingleLine(id, "messageId");
  const bare = id.replace(/^<(.*)>$/, "$1");
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(bare) || !/^[\x21-\x7e]+$/.test(bare)) {
    throw new MessageError("messageId must look like local@domain");
  }
  return `<${bare}>`;
}

function customHeaders(headers: Message["headers"]): string[] {
  if (headers === undefined) return [];
  const entries = Array.isArray(headers)
    ? headers as ReadonlyArray<readonly [string, string]>
    : Object.entries(headers);
  return entries.map(([name, value]) => {
    if (typeof name !== "string" || !FIELD_NAME.test(name)) {
      throw new MessageError(`Invalid header name: ${JSON.stringify(name)}`);
    }
    if (RESERVED.has(name.toLowerCase())) {
      throw new MessageError(`The ${name} header is set by the library; use the message fields`);
    }
    if (typeof value !== "string") throw new MessageError(`The ${name} header must be a string`);
    return unstructured(name, value);
  });
}

/**
 * Builds the raw message and the SMTP envelope without sending anything.
 *
 * Use this to inspect or store a message, or to send it with
 * {@linkcode SmtpClient.send} later.
 *
 * @example
 * ```ts
 * import { composeMessage } from "@munimh/smtpwire";
 *
 * const { raw, envelope } = composeMessage({
 *   from: { name: "Example App", address: "app@example.com" },
 *   to: "Jane Doe <jane@example.com>",
 *   subject: "Your receipt",
 *   text: "Thanks for your order.",
 * });
 * ```
 *
 * @param message The message to build.
 * @returns The raw message text, its Message-ID and the envelope.
 * @throws {MessageError} When a field is invalid, including any header value containing
 * a line break.
 */
export function composeMessage(message: Message): ComposedMessage {
  if (message === null || typeof message !== "object") {
    throw new MessageError("The message must be an object");
  }
  const from = parseAddress(message.from, "from");
  const to = list(message.to, "to");
  const cc = list(message.cc, "cc");
  const bcc = list(message.bcc, "bcc");
  const replyTo = list(message.replyTo, "replyTo");
  const domain = from.address.slice(from.address.lastIndexOf("@") + 1);
  const messageId = normaliseMessageId(message.messageId, domain);

  const headers = [
    addressHeader("From", [from]),
    ...(to.length ? [addressHeader("To", to)] : []),
    ...(cc.length ? [addressHeader("Cc", cc)] : []),
    ...(replyTo.length ? [addressHeader("Reply-To", replyTo)] : []),
    unstructured("Subject", message.subject ?? ""),
    `Date: ${formatDate(message.date ?? new Date())}`,
    `Message-ID: ${messageId}`,
    ...customHeaders(message.headers),
    "MIME-Version: 1.0",
  ];

  for (const field of ["text", "html"] as const) {
    if (message[field] !== undefined && typeof message[field] !== "string") {
      throw new MessageError(`${field} must be a string`);
    }
  }
  const attachments = message.attachments ?? [];
  const hasHtml = message.html !== undefined;
  const inline: Part[] = [];
  const regular: Part[] = [];
  attachments.forEach((attachment, i) => {
    const isInline = hasHtml && attachment?.contentId !== undefined;
    (isInline ? inline : regular).push(attachmentPart(attachment, isInline, i));
  });

  let html = hasHtml ? textPart("html", message.html!) : undefined;
  if (html && inline.length) {
    html = multipart("related", [html, ...inline], [["type", "text/html"]]);
  }
  const text = message.text !== undefined ? textPart("plain", message.text) : undefined;
  let body = text && html ? multipart("alternative", [text, html]) : html ?? text ??
    textPart("plain", "");
  if (regular.length) body = multipart("mixed", [body, ...regular]);

  const envelopeTo = message.envelope?.to ??
    [...to, ...cc, ...bcc].map((m) => m.address);
  const envelopeFrom = message.envelope?.from ?? from.address;
  // An empty envelope sender is the null reverse-path (MAIL FROM:<>) used for bounces.
  if (envelopeFrom !== "") parseAddress(envelopeFrom, "The envelope sender");
  for (const address of envelopeTo) parseAddress(address, "The envelope");

  return {
    raw: headers.join("\r\n") + "\r\n" + render(body) + "\r\n",
    messageId,
    envelope: { from: envelopeFrom, to: envelopeTo },
  };
}
