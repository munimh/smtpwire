/**
 * The step of an SMTP session at which a failure happened.
 *
 * - `connect`: opening the TCP connection, the server greeting, or EHLO/HELO.
 * - `tls`: implicit TLS handshake, or the STARTTLS command and upgrade.
 * - `auth`: authentication.
 * - `sender`: the `MAIL FROM` command, including size checks.
 * - `recipient`: a `RCPT TO` command.
 * - `data`: the `DATA` command, sending the message, or the server's final reply to it.
 */
export type SmtpStage = "connect" | "tls" | "auth" | "sender" | "recipient" | "data";

/**
 * How a failure should be treated by a caller deciding whether to retry.
 *
 * - `permanent`: the server answered with a 5xx code, or the failure comes from
 *   configuration (for example no STARTTLS offered). Retrying the same thing will fail again.
 * - `temporary`: the server answered with a 4xx code, or the network failed or timed out
 *   before the message was handed over. Retrying later is reasonable.
 * - `unknown`: the whole message was sent but no final reply arrived. The server may
 *   have accepted it, so a retry could deliver it twice.
 */
export type SmtpErrorKind = "permanent" | "temporary" | "unknown";

/** Fields used to construct an {@linkcode SmtpError}. */
export interface SmtpErrorInit {
  /** The step that failed. */
  stage: SmtpStage;
  /** The three-digit SMTP reply code, when the server replied. */
  code?: number;
  /** The enhanced status code (RFC 3463), such as `5.1.1`, when the server sent one. */
  enhancedCode?: string;
  /** The text of the server reply, when there was one. */
  response?: string;
  /** The recipient that was refused, for the `recipient` stage. */
  recipient?: string;
  /** Set when the failure was a timeout. */
  timeout?: boolean;
  /** Overrides the kind derived from the reply code. */
  kind?: SmtpErrorKind;
  /** The underlying error, if any. */
  cause?: unknown;
}

/**
 * The error thrown for every SMTP failure.
 *
 * Use {@linkcode SmtpError.kind} (or {@linkcode SmtpError.permanent} and
 * {@linkcode SmtpError.temporary}) to decide whether to retry.
 *
 * @example Deciding whether to retry
 * ```ts
 * import { send, SmtpError } from "@munimh/smtpwire";
 *
 * try {
 *   await send({ host: "smtp.example.com", auth: { user: "app", pass: "secret" } }, {
 *     from: "app@example.com",
 *     to: "someone@example.com",
 *     subject: "Hello",
 *     text: "Hi there",
 *   });
 * } catch (err) {
 *   if (err instanceof SmtpError && err.temporary) {
 *     // queue for a later attempt
 *   }
 * }
 * ```
 */
export class SmtpError extends Error {
  /** The step that failed. */
  readonly stage: SmtpStage;
  /** The three-digit SMTP reply code, or `undefined` when the server did not reply. */
  readonly code: number | undefined;
  /** The enhanced status code such as `5.7.8`, when the server sent one. */
  readonly enhancedCode: string | undefined;
  /** The text of the server reply, when there was one. */
  readonly response: string | undefined;
  /** The refused recipient, for failures at the `recipient` stage. */
  readonly recipient: string | undefined;
  /** `true` when the failure was a connect or command timeout. */
  readonly timeout: boolean;
  /** Whether a retry is reasonable. See {@linkcode SmtpErrorKind}. */
  readonly kind: SmtpErrorKind;

  /**
   * Creates an error. Library users normally only catch these.
   *
   * @param message A human-readable description.
   * @param init Structured details.
   */
  constructor(message: string, init: SmtpErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "SmtpError";
    this.stage = init.stage;
    this.code = init.code;
    this.enhancedCode = init.enhancedCode;
    this.response = init.response;
    this.recipient = init.recipient;
    this.timeout = init.timeout ?? false;
    this.kind = init.kind ?? kindFromCode(init.code);
  }

  /** `true` when retrying the same request will not help (5xx or a configuration problem). */
  get permanent(): boolean {
    return this.kind === "permanent";
  }

  /** `true` when a later retry may succeed (4xx, or a network failure before hand-over). */
  get temporary(): boolean {
    return this.kind === "temporary";
  }

  /**
   * `true` when the message was fully sent but the server's verdict never arrived,
   * so it may or may not have been accepted.
   */
  get deliveryUnknown(): boolean {
    return this.kind === "unknown";
  }
}

function kindFromCode(code: number | undefined): SmtpErrorKind {
  if (code === undefined) return "temporary";
  if (code >= 500) return "permanent";
  if (code >= 400) return "temporary";
  // A positive reply where another was expected is a protocol mismatch.
  return "permanent";
}

/**
 * Thrown when a message cannot be built, for example because a header value contains
 * a line break or an address is malformed. Nothing has been sent when this is thrown.
 */
export class MessageError extends Error {
  /**
   * Creates an error.
   *
   * @param message A human-readable description.
   */
  constructor(message: string) {
    super(message);
    this.name = "MessageError";
  }
}
