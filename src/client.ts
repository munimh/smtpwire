// The SMTP client (RFC 5321) with STARTTLS (RFC 3207), AUTH (RFC 4954) and
// enhanced status codes (RFC 3463).

import { SmtpError, type SmtpStage } from "./errors.ts";
import { base64Text, isSevenBit, toCrlf, utf8 } from "./encoding.ts";
import { type ComposedMessage, composeMessage, type Message } from "./message.ts";
import { type Connection, type Connector, denoConnector } from "./net.ts";
import { parseAddress } from "./headers.ts";

/** How the connection is secured. */
export type Security =
  /** TLS from the first byte (usually port 465). */
  | "tls"
  /** Plain connection upgraded with STARTTLS before anything else is sent (usually 587). */
  | "starttls"
  /** No encryption. Only for local test servers. */
  | "none";

/** Username and password, sent with AUTH PLAIN or AUTH LOGIN. */
export interface PasswordAuth {
  /** The username. */
  user: string;
  /** The password. It is never logged. */
  pass: string;
  /** Forces a mechanism. By default PLAIN is used if offered, otherwise LOGIN. */
  method?: "plain" | "login";
}

/** An OAuth 2.0 access token, sent with AUTH XOAUTH2. Obtaining the token is up to you. */
export interface TokenAuth {
  /** The account the token belongs to, usually an email address. */
  user: string;
  /** A current access token. It is never logged. */
  accessToken: string;
  /** Always XOAUTH2. */
  method?: "xoauth2";
}

/** Settings for connecting to an SMTP server. */
export interface TransportOptions {
  /** The server host name, for example `smtp.example.com`. */
  host: string;
  /**
   * The port. Defaults to 465 for `security: "tls"`, 587 for `"starttls"` and 25 for
   * `"none"`.
   */
  port?: number;
  /**
   * How the connection is secured. Defaults to `"tls"` when `port` is 465 or unset,
   * otherwise `"starttls"`. STARTTLS is required, never optional: if the server does not
   * offer it the connection fails rather than continuing unencrypted.
   */
  security?: Security;
  /** Credentials. Omit for servers that accept mail without authentication. */
  auth?: PasswordAuth | TokenAuth;
  /**
   * Allows credentials over an unencrypted connection. Only for local test servers.
   * Defaults to `false`.
   */
  allowInsecureAuth?: boolean;
  /** The name sent with EHLO. Defaults to `localhost`. */
  clientName?: string;
  /** Time limit in milliseconds for the TCP connection and TLS handshake. Default 15000. */
  connectTimeout?: number;
  /** Time limit in milliseconds for each command's reply. Default 30000. */
  commandTimeout?: number;
  /**
   * Time limit in milliseconds for the server's reply after the message body has been
   * sent, when servers often run content checks. Default 120000.
   */
  dataTimeout?: number;
  /** The network layer. Defaults to {@linkcode denoConnector}. */
  connector?: Connector;
  /**
   * Logs the SMTP conversation. Pass `true` for `console.debug`, or a function. Passwords,
   * tokens and AUTH exchanges are always replaced with `<redacted>`, and message bodies
   * are not logged.
   */
  debug?: boolean | ((line: string) => void);
}

/** The outcome of a successful send. */
export interface SendReport {
  /** The `Message-ID` header of the message, with angle brackets. Empty for raw messages without one. */
  messageId: string;
  /** The envelope recipients the server accepted. */
  accepted: string[];
  /** The server's final reply code, normally 250. */
  code: number;
  /** The server's final reply text, which often contains a queue ID. */
  response: string;
}

/** An already-built message with its envelope, for example from {@linkcode composeMessage}. */
export interface RawMessage {
  /**
   * The complete message. Line breaks are converted to CRLF before sending. Non-ASCII
   * text is sent as UTF-8: in the body it requires the server to offer 8BITMIME, and in
   * the headers SMTPUTF8 as well; otherwise sending fails before `MAIL FROM`.
   */
  raw: string;
  /** The envelope. */
  envelope: { from: string; to: string[] };
  /** The Message-ID to report back in {@linkcode SendReport}. */
  messageId?: string;
}

/** A parsed SMTP reply. */
interface Reply {
  code: number;
  enhanced: string | undefined;
  lines: string[];
  text: string;
}

const MAX_LINE = 64 * 1024;
const ENHANCED = /^([245]\.\d{1,3}\.\d{1,3})(?:\s|$)/;

/** Thrown internally on timeouts and stream failures, then converted to SmtpError. */
class WireFailure extends Error {
  constructor(message: string, readonly timeout: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

async function raceDeadline<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => void,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new WireFailure(`${label} timed out after ${ms} ms`, true));
    }, ms);
  });
  work.catch(() => {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A connection to an SMTP server that can send several messages.
 *
 * Open one with {@linkcode SmtpClient.connect}, call {@linkcode SmtpClient.send} as
 * many times as needed, then {@linkcode SmtpClient.close}. Supports `await using`.
 *
 * When the server refuses a message (a 4xx or 5xx reply to `MAIL FROM`, `RCPT TO` or
 * `DATA`) the transaction is reset and the connection stays usable. Calls made at the
 * same time are queued and run one after another. Any other error,
 * such as a timeout, closes the connection.
 *
 * @example Sending a batch over one connection
 * ```ts
 * import { SmtpClient } from "@munimh/smtpwire";
 *
 * await using client = await SmtpClient.connect({
 *   host: "smtp.example.com",
 *   auth: { user: "app@example.com", pass: Deno.env.get("SMTP_PASS")! },
 * });
 * for (const to of ["ann@example.com", "bob@example.com"]) {
 *   await client.send({ from: "app@example.com", to, subject: "Hi", text: "Hello" });
 * }
 * ```
 */
export class SmtpClient {
  #conn: Connection;
  #options: TransportOptions;
  #log: ((line: string) => void) | undefined;
  #buffer = "";
  #decoder = new TextDecoder();
  #closed = false;
  #secure: boolean;
  #capabilities = new Map<string, string>();
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(conn: Connection, options: TransportOptions, secure: boolean) {
    this.#conn = conn;
    this.#options = options;
    this.#secure = secure;
    const debug = options.debug;
    this.#log = debug === true ? (line) => console.debug(line) : debug || undefined;
  }

  /**
   * Connects, secures the connection, says EHLO and authenticates.
   *
   * @param options Server and credential settings.
   * @returns A ready client.
   * @throws {SmtpError} At the `connect`, `tls` or `auth` stage. The connection is
   * closed before the error is thrown.
   */
  static async connect(options: TransportOptions): Promise<SmtpClient> {
    if (!options || typeof options.host !== "string" || !options.host) {
      throw new SmtpError("options.host is required", { stage: "connect", kind: "permanent" });
    }
    const security: Security = options.security ??
      (options.port === undefined || options.port === 465 ? "tls" : "starttls");
    const port = options.port ?? (security === "tls" ? 465 : security === "starttls" ? 587 : 25);
    const connector = options.connector ?? denoConnector();
    const connectTimeout = options.connectTimeout ?? 15_000;

    let conn: Connection;
    try {
      conn = await openLate(connector.connect(options.host, port), connectTimeout, "Connecting");
    } catch (cause) {
      throw networkError("connect", `Could not connect to ${options.host}:${port}`, cause);
    }

    if (security === "tls") {
      try {
        conn = await openLate(
          connector.startTls(conn, options.host),
          connectTimeout,
          "The TLS handshake",
          () => safeClose(conn),
        );
      } catch (cause) {
        safeClose(conn);
        throw networkError("tls", `TLS handshake with ${options.host} failed`, cause);
      }
    }

    const client = new SmtpClient(conn, options, security === "tls");
    try {
      await client.#open(security, connector);
    } catch (err) {
      client.#destroy();
      throw err;
    }
    return client;
  }

  /** `true` while the connection is encrypted. */
  get secure(): boolean {
    return this.#secure;
  }

  /** `true` once the connection has been closed, by {@linkcode close} or by an error. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * The extensions the server announced in its EHLO reply, keyed by upper-case keyword
   * (for example `SIZE` or `AUTH`), with the rest of the line as the value.
   */
  get capabilities(): ReadonlyMap<string, string> {
    return this.#capabilities;
  }

  async #open(security: Security, connector: Connector): Promise<void> {
    const greeting = await this.#read("connect");
    if (greeting.code !== 220) {
      throw replyError("connect", "The server refused the connection", greeting);
    }
    await this.#hello();

    if (security === "starttls") {
      if (!this.#capabilities.has("STARTTLS")) {
        throw new SmtpError("The server does not offer STARTTLS", {
          stage: "tls",
          kind: "permanent",
        });
      }
      await this.#command("STARTTLS", "tls", [220]);
      if (this.#buffer.length) {
        // Anything the server sent after its 220 arrived unencrypted and could have been
        // injected; it must not be treated as a reply on the secure channel.
        throw new SmtpError("The server sent unexpected data after STARTTLS", {
          stage: "tls",
          kind: "permanent",
        });
      }
      try {
        this.#conn = await openLate(
          connector.startTls(this.#conn, this.#options.host),
          this.#options.connectTimeout ?? 15_000,
          "The TLS handshake",
          () => this.#destroy(),
        );
      } catch (cause) {
        throw networkError("tls", `STARTTLS with ${this.#options.host} failed`, cause);
      }
      this.#secure = true;
      await this.#hello();
    }

    const auth = this.#options.auth;
    if (auth) {
      // Keep no reference to the credentials for the rest of the connection's life.
      const { auth: _dropped, ...rest } = this.#options;
      this.#options = rest;
      await this.#authenticate(auth);
    }
  }

  async #hello(): Promise<void> {
    const name = this.#options.clientName ?? "localhost";
    if (!/^[\x21-\x7e]+$/.test(name)) {
      throw new SmtpError("clientName must be printable ASCII without spaces", {
        stage: "connect",
        kind: "permanent",
      });
    }
    this.#capabilities = new Map();
    await this.#write(`EHLO ${name}`, "connect");
    const reply = await this.#read("connect");
    if (reply.code === 250) {
      for (const line of reply.lines.slice(1)) {
        const [keyword = "", ...rest] = line.trim().split(/\s+/);
        if (keyword) this.#capabilities.set(keyword.toUpperCase(), rest.join(" "));
      }
      // Some old servers announce AUTH as "AUTH=LOGIN PLAIN".
      for (const [key, value] of this.#capabilities) {
        if (key.startsWith("AUTH=") && !this.#capabilities.has("AUTH")) {
          this.#capabilities.set("AUTH", [key.slice(5), value].join(" ").trim());
        }
      }
      return;
    }
    if (reply.code >= 500 && reply.code <= 504) {
      await this.#command(`HELO ${name}`, "connect", [250]);
      return;
    }
    throw replyError("connect", "The server refused EHLO", reply);
  }

  async #authenticate(auth: PasswordAuth | TokenAuth): Promise<void> {
    if (!this.#secure && !this.#options.allowInsecureAuth) {
      throw new SmtpError(
        "Refusing to send credentials over an unencrypted connection " +
          "(set allowInsecureAuth only for local test servers)",
        { stage: "auth", kind: "permanent" },
      );
    }
    const offered = new Set(
      (this.#capabilities.get("AUTH") ?? "").toUpperCase().split(/\s+/).filter(Boolean),
    );
    if (!offered.size) {
      // Includes servers that only answered HELO. Sending credentials to a server that
      // never asked for them gains nothing and exposes them needlessly.
      throw new SmtpError("The server does not offer authentication", {
        stage: "auth",
        kind: "permanent",
      });
    }
    let method: "plain" | "login" | "xoauth2";
    if ("accessToken" in auth) method = "xoauth2";
    else if (auth.method) method = auth.method;
    else if (offered.has("PLAIN")) method = "plain";
    else if (offered.has("LOGIN")) method = "login";
    else {
      throw new SmtpError(
        `The server offers no supported AUTH mechanism (it offers ${[...offered].join(", ")})`,
        { stage: "auth", kind: "permanent" },
      );
    }
    if (!offered.has(method.toUpperCase())) {
      throw new SmtpError(`The server does not offer AUTH ${method.toUpperCase()}`, {
        stage: "auth",
        kind: "permanent",
      });
    }

    if (method === "plain") {
      const pass = (auth as PasswordAuth).pass;
      const token = base64Text(`\0${auth.user}\0${pass}`);
      await this.#write(`AUTH PLAIN ${token}`, "auth", "AUTH PLAIN <redacted>");
      let reply = await this.#read("auth");
      if (reply.code === 334) {
        await this.#write(token, "auth", "<redacted>");
        reply = await this.#read("auth");
      }
      if (reply.code !== 235) throw replyError("auth", "Authentication failed", reply);
    } else if (method === "login") {
      const pass = (auth as PasswordAuth).pass;
      await this.#write("AUTH LOGIN", "auth");
      let reply = await this.#read("auth");
      if (reply.code !== 334) throw replyError("auth", "Authentication failed", reply);
      await this.#write(base64Text(auth.user), "auth", "<redacted>");
      reply = await this.#read("auth");
      if (reply.code !== 334) throw replyError("auth", "Authentication failed", reply);
      await this.#write(base64Text(pass), "auth", "<redacted>");
      reply = await this.#read("auth");
      if (reply.code !== 235) throw replyError("auth", "Authentication failed", reply);
    } else {
      const token = (auth as TokenAuth).accessToken;
      const payload = base64Text(`user=${auth.user}\x01auth=Bearer ${token}\x01\x01`);
      await this.#write(`AUTH XOAUTH2 ${payload}`, "auth", "AUTH XOAUTH2 <redacted>");
      let reply = await this.#read("auth");
      if (reply.code === 334) {
        // The server sent a JSON error challenge; an empty line asks for the final reply.
        await this.#write("", "auth");
        reply = await this.#read("auth");
      }
      if (reply.code !== 235) throw replyError("auth", "Authentication failed", reply);
    }
  }

  /**
   * Sends one message.
   *
   * @param message A {@linkcode Message} to build and send, or a {@linkcode RawMessage}.
   * @returns The server's verdict and the accepted recipients.
   * @throws {SmtpError} At the `sender`, `recipient` or `data` stage.
   * @throws {MessageError} When the message is invalid. Nothing is sent in that case.
   */
  send(message: Message | RawMessage): Promise<SendReport> {
    return this.#exclusive(() => this.#send(message));
  }

  /**
   * Runs one operation at a time. SMTP is strictly request/response, so calls made
   * concurrently (for example with Promise.all) must not interleave on the wire.
   */
  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #send(message: Message | RawMessage): Promise<SendReport> {
    if (this.#closed) {
      throw new SmtpError("The connection is closed", { stage: "sender", kind: "permanent" });
    }
    const composed: ComposedMessage | RawMessage = "raw" in message
      ? message
      : composeMessage(message);
    const from = composed.envelope.from;
    const recipients = dedupe(composed.envelope.to);
    // An empty sender is the null reverse-path (MAIL FROM:<>) used for bounces.
    if (from !== "") parseAddress(from, "The envelope sender");
    for (const address of recipients) parseAddress(address, "The envelope");
    if (!recipients.length) {
      throw new SmtpError("The message has no recipients", {
        stage: "recipient",
        kind: "permanent",
      });
    }
    const crlf = toCrlf(composed.raw);
    const body = dotStuff(crlf);
    const size = utf8(body).length;
    const headerEnd = crlf.indexOf("\r\n\r\n");
    const eightBitHeaders = !isSevenBit(headerEnd === -1 ? crlf : crlf.slice(0, headerEnd));
    const eightBitBody = headerEnd !== -1 && !isSevenBit(crlf.slice(headerEnd));

    try {
      // Messages from composeMessage are always 7-bit. Raw messages with UTF-8 need the
      // server's consent: 8BITMIME for the body (RFC 6152), SMTPUTF8 for headers (RFC 6531).
      let params = "";
      if (eightBitHeaders || eightBitBody) {
        if (!this.#capabilities.has("8BITMIME")) {
          throw new SmtpError(
            "The message contains non-ASCII bytes but the server does not offer 8BITMIME",
            { stage: "sender", kind: "permanent" },
          );
        }
        params += " BODY=8BITMIME";
      }
      if (eightBitHeaders) {
        if (!this.#capabilities.has("SMTPUTF8")) {
          throw new SmtpError(
            "The message has non-ASCII headers but the server does not offer SMTPUTF8",
            { stage: "sender", kind: "permanent" },
          );
        }
        params += " SMTPUTF8";
      }
      const limit = Number(this.#capabilities.get("SIZE") ?? 0);
      if (limit > 0 && size > limit) {
        throw new SmtpError(`The message is ${size} bytes; the server accepts at most ${limit}`, {
          stage: "sender",
          kind: "permanent",
        });
      }
      const sizeParam = this.#capabilities.has("SIZE") ? ` SIZE=${size}` : "";
      await this.#command(`MAIL FROM:<${from}>${sizeParam}${params}`, "sender", [250]);
      for (const recipient of recipients) {
        await this.#write(`RCPT TO:<${recipient}>`, "recipient");
        const reply = await this.#read("recipient");
        if (reply.code !== 250 && reply.code !== 251) {
          throw replyError("recipient", `The server refused the recipient ${recipient}`, reply, {
            recipient,
          });
        }
      }
      await this.#command("DATA", "data", [354]);
      await this.#writeBody(body + ".\r\n");
      let reply: Reply;
      try {
        reply = await this.#read("data", this.#options.dataTimeout ?? 120_000);
      } catch (err) {
        if (err instanceof SmtpError && err.code === undefined) {
          throw new SmtpError(
            `${err.message}; the message was sent in full, so it may have been accepted`,
            { stage: "data", kind: "unknown", timeout: err.timeout, cause: err.cause },
          );
        }
        throw err;
      }
      if (reply.code !== 250) throw replyError("data", "The server refused the message", reply);
      return {
        messageId: composed.messageId ?? "",
        accepted: recipients,
        code: reply.code,
        response: reply.text,
      };
    } catch (err) {
      await this.#recover(err);
      throw err;
    }
  }

  /** After a refused transaction, resets so the connection can be reused; otherwise closes. */
  async #recover(err: unknown): Promise<void> {
    if (this.#closed || !(err instanceof SmtpError)) {
      this.#destroy();
      return;
    }
    // A local check failed before any command was sent: nothing to reset.
    if (err.code === undefined && err.kind === "permanent" && err.stage === "sender") return;
    if (err.code === undefined || err.code < 400) {
      this.#destroy();
      return;
    }
    try {
      await this.#command("RSET", err.stage, [250]);
    } catch {
      this.#destroy();
    }
  }

  /**
   * Sends `NOOP`, for example to check that an idle connection is still alive.
   *
   * @throws {SmtpError} If the server does not answer with 250. The connection is closed.
   */
  noop(): Promise<void> {
    return this.#exclusive(async () => {
      try {
        await this.#command("NOOP", "connect", [250]);
      } catch (err) {
        this.#destroy();
        throw err;
      }
    });
  }

  /**
   * Sends `QUIT` and closes the connection. Never throws, and does nothing if the
   * connection is already closed.
   */
  close(): Promise<void> {
    return this.#exclusive(async () => {
      if (this.#closed) return;
      try {
        await this.#write("QUIT", "connect", undefined, 5_000);
        await this.#read("connect", Math.min(this.#options.commandTimeout ?? 30_000, 5_000));
      } catch {
        // The server may drop the connection right after QUIT; that is fine.
      } finally {
        this.#destroy();
      }
    });
  }

  /** Closes the connection, for `await using`. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  #destroy(): void {
    if (this.#closed) return;
    this.#closed = true;
    safeClose(this.#conn);
  }

  async #command(line: string, stage: SmtpStage, ok: number[], logAs?: string): Promise<Reply> {
    await this.#write(line, stage, logAs);
    const reply = await this.#read(stage);
    if (!ok.includes(reply.code)) {
      throw replyError(stage, `The server refused ${line.split(" ")[0]}`, reply);
    }
    return reply;
  }

  async #write(line: string, stage: SmtpStage, logAs?: string, timeout?: number): Promise<void> {
    if (/[\r\n]/.test(line)) {
      throw new SmtpError("Commands must not contain line breaks", { stage, kind: "permanent" });
    }
    this.#log?.(`C: ${logAs ?? line}`);
    await this.#writeBytes(utf8(line + "\r\n"), stage, timeout);
  }

  async #writeBody(body: string): Promise<void> {
    const bytes = utf8(body);
    this.#log?.(`C: <message, ${bytes.length} bytes>`);
    const chunk = 64 * 1024;
    for (let i = 0; i < bytes.length; i += chunk) {
      await this.#writeBytes(bytes.subarray(i, i + chunk), "data");
    }
  }

  async #writeBytes(bytes: Uint8Array, stage: SmtpStage, timeout?: number): Promise<void> {
    const ms = timeout ?? this.#options.commandTimeout ?? 30_000;
    try {
      let offset = 0;
      while (offset < bytes.length) {
        offset += await raceDeadline(
          this.#conn.write(bytes.subarray(offset)),
          ms,
          () => this.#destroy(),
          "Writing to the server",
        );
      }
    } catch (cause) {
      this.#destroy();
      throw networkError(stage, "Writing to the server failed", cause);
    }
  }

  async #readLine(stage: SmtpStage, ms: number): Promise<string> {
    const chunk = new Uint8Array(16 * 1024);
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      if (end !== -1) {
        const line = this.#buffer.slice(0, end).replace(/\r$/, "");
        this.#buffer = this.#buffer.slice(end + 1);
        return line;
      }
      if (this.#buffer.length > MAX_LINE) {
        this.#destroy();
        throw new SmtpError("The server sent an over-long line", { stage, kind: "permanent" });
      }
      let n: number | null;
      try {
        n = await raceDeadline(
          this.#conn.read(chunk),
          ms,
          () => this.#destroy(),
          "Waiting for the server",
        );
      } catch (cause) {
        this.#destroy();
        throw networkError(stage, "Reading from the server failed", cause);
      }
      if (n === null) {
        this.#destroy();
        throw new SmtpError("The server closed the connection", { stage });
      }
      this.#buffer += this.#decoder.decode(chunk.subarray(0, n), { stream: true });
    }
  }

  async #read(stage: SmtpStage, timeout?: number): Promise<Reply> {
    const ms = timeout ?? this.#options.commandTimeout ?? 30_000;
    const lines: string[] = [];
    let code: number | undefined;
    for (;;) {
      const line = await this.#readLine(stage, ms);
      this.#log?.(`S: ${line}`);
      const match = /^(\d{3})([ -]|$)(.*)$/.exec(line);
      if (!match || (code !== undefined && Number(match[1]) !== code)) {
        this.#destroy();
        throw new SmtpError(`The server sent a malformed reply: ${line.slice(0, 200)}`, {
          stage,
          kind: "permanent",
        });
      }
      code = Number(match[1]);
      lines.push(match[3]!);
      if (match[2] !== "-") break;
    }
    const enhanced = ENHANCED.exec(lines[0]!)?.[1] ?? ENHANCED.exec(lines[lines.length - 1]!)?.[1];
    return { code, enhanced, lines, text: lines.join("\n") };
  }
}

/**
 * Drops repeated recipients. Domains are case-insensitive, but the local part (before
 * the @) may be case-sensitive (RFC 5321 section 2.4), so its case is kept.
 */
function dedupe(addresses: string[]): string[] {
  const seen = new Set<string>();
  return addresses.filter((a) => {
    const at = a.lastIndexOf("@");
    const key = a.slice(0, at) + a.slice(at).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Applies SMTP transparency (RFC 5321 section 4.5.2): every line starting with `.` gets
 * another `.`. The input must use CRLF; the result always ends with CRLF.
 */
export function dotStuff(crlfText: string): string {
  let out = crlfText.replace(/(^|\r\n)\./g, "$1..");
  if (!out.endsWith("\r\n")) out += "\r\n";
  return out;
}

/** Awaits `work` with a time limit; if it finishes after the limit, the result is closed. */
async function openLate(
  work: Promise<Connection>,
  ms: number,
  label: string,
  onTimeout: () => void = () => {},
): Promise<Connection> {
  let timedOut = false;
  try {
    return await raceDeadline(work, ms, () => {
      timedOut = true;
      onTimeout();
    }, label);
  } finally {
    if (timedOut) work.then(safeClose, () => {});
  }
}

function safeClose(conn: Connection): void {
  try {
    conn.close();
  } catch {
    // already closed
  }
}

function networkError(stage: SmtpStage, message: string, cause: unknown): SmtpError {
  if (cause instanceof SmtpError) return cause;
  const timeout = cause instanceof WireFailure && cause.timeout;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new SmtpError(`${message}: ${detail}`, { stage, timeout, cause });
}

function replyError(
  stage: SmtpStage,
  message: string,
  reply: Reply,
  extra: { recipient?: string } = {},
): SmtpError {
  const text = reply.text.length > 500 ? reply.text.slice(0, 500) + "..." : reply.text;
  return new SmtpError(`${message}: ${reply.code} ${text}`, {
    stage,
    code: reply.code,
    response: reply.text,
    ...(reply.enhanced ? { enhancedCode: reply.enhanced } : {}),
    ...extra,
  });
}
