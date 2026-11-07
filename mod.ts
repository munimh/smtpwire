/**
 * A small, dependency-free SMTP client and MIME message builder for Deno, Supabase Edge
 * Functions and other runtimes where Node mail libraries do not work well.
 *
 * - Implicit TLS (465), STARTTLS (587) and plain connections for local testing
 * - AUTH PLAIN, AUTH LOGIN and XOAUTH2 (with an access token you supply)
 * - Text, HTML, `multipart/alternative`, attachments and inline images
 * - RFC 2047 encoding and folding for non-ASCII subjects and names
 * - Typed errors that say which step failed and whether a retry makes sense
 * - A swappable network layer; Node and Bun use `@munimh/smtpwire/node`
 *
 * @example Send one message
 * ```ts
 * import { send } from "@munimh/smtpwire";
 *
 * await send(
 *   {
 *     host: "smtp.example.com",
 *     port: 465,
 *     auth: { user: "app@example.com", pass: Deno.env.get("SMTP_PASS")! },
 *   },
 *   {
 *     from: { name: "Example App", address: "app@example.com" },
 *     to: "Jane Doe <jane@example.com>",
 *     subject: "Welcome",
 *     text: "Thanks for signing up.",
 *     html: "<p>Thanks for signing up.</p>",
 *   },
 * );
 * ```
 *
 * @module
 */

import {
  type RawMessage,
  type SendReport,
  SmtpClient,
  type TransportOptions,
} from "./src/client.ts";
import type { Message } from "./src/message.ts";

export {
  dotStuff,
  type PasswordAuth,
  type RawMessage,
  type Security,
  type SendReport,
  SmtpClient,
  type TokenAuth,
  type TransportOptions,
} from "./src/client.ts";
export {
  MessageError,
  SmtpError,
  type SmtpErrorInit,
  type SmtpErrorKind,
  type SmtpStage,
} from "./src/errors.ts";
export {
  type Attachment,
  type ComposedMessage,
  composeMessage,
  type Message,
} from "./src/message.ts";
export type { Address, Mailbox } from "./src/headers.ts";
export {
  type Connection,
  type Connector,
  denoConnector,
  type DenoConnectorOptions,
} from "./src/net.ts";

/**
 * Connects, sends one message and closes the connection, whatever happens.
 *
 * For several messages, use {@linkcode SmtpClient} to reuse one connection.
 *
 * @param options Server and credential settings.
 * @param message A {@linkcode Message} to build and send, or a {@linkcode RawMessage}.
 * @returns The server's verdict and the accepted recipients.
 * @throws {SmtpError} When any SMTP step fails; check `kind` to decide whether to retry.
 * @throws {MessageError} When the message is invalid. Nothing is sent in that case.
 */
export async function send(
  options: TransportOptions,
  message: Message | RawMessage,
): Promise<SendReport> {
  const client = await SmtpClient.connect(options);
  try {
    return await client.send(message);
  } finally {
    await client.close();
  }
}
