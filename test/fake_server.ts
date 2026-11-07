// An in-process, scriptable SMTP server for tests. It runs over any Connection: an
// in-memory pipe (see memoryConnector) or a real socket.

import type { Connection, Connector } from "../mod.ts";

/** Commands whose reply can be overridden or suppressed. */
export type Step =
  | "GREETING"
  | "EHLO"
  | "HELO"
  | "STARTTLS"
  | "AUTH"
  | "MAIL"
  | "RCPT"
  | "DATA"
  | "END"
  | "RSET"
  | "NOOP";

export interface FakeServerOptions {
  /** EHLO keywords after the first line. */
  extensions?: string[];
  /** Advertise STARTTLS while the session is not yet secure. */
  starttls?: boolean;
  /** Advertise AUTH only once the session is secure. */
  authNeedsTls?: boolean;
  /** Accepted user/password pairs. */
  users?: Record<string, string>;
  /** Accepted user/token pairs for XOAUTH2. */
  tokens?: Record<string, string>;
  /** Replace the server's reply to a step. May contain several CRLF-separated lines. */
  replies?: Partial<Record<Step, string>>;
  /** Per-recipient RCPT replies. */
  recipients?: Record<string, string>;
  /** Never reply to this step (to provoke timeouts). */
  silentOn?: Step;
  /** Bytes sent straight after the STARTTLS 220 reply, to simulate injection. */
  afterStartTls?: string;
  /** Send every reply one byte at a time. */
  byteByByte?: boolean;
}

export interface ReceivedMessage {
  from: string;
  to: string[];
  data: string;
}

export interface Session {
  commands: string[];
  secure: boolean;
  authUser?: string;
  authMethod?: string;
  ended: boolean;
  quit: boolean;
  lines: string[];
}

const encoder = new TextEncoder();

export function decodeBase64(b64: string): string {
  const binary = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function encodeBase64(text: string): string {
  return btoa(String.fromCharCode(...encoder.encode(text)));
}

export class FakeServer {
  readonly options: FakeServerOptions;
  readonly messages: ReceivedMessage[] = [];
  readonly sessions: Session[] = [];
  upgrades = 0;

  constructor(options: FakeServerOptions = {}) {
    this.options = options;
  }

  /** A connector that connects to this server through an in-memory pipe. */
  connector(): Connector {
    return {
      connect: () => {
        const [client, server] = pipe();
        this.serve(server).catch(() => {});
        return Promise.resolve(client);
      },
      startTls: (conn) => {
        this.upgrades++;
        return Promise.resolve(conn);
      },
    };
  }

  /** Serves one session. `upgrade` performs the server side of STARTTLS. */
  async serve(
    conn: Connection,
    init: { secure?: boolean; upgrade?: (conn: Connection) => Promise<Connection> } = {},
  ): Promise<void> {
    const o = this.options;
    const session: Session = {
      commands: [],
      secure: init.secure ?? false,
      ended: false,
      quit: false,
      lines: [],
    };
    this.sessions.push(session);
    let reader = new LineReader(conn);
    const reply = async (step: Step, fallback: string) => {
      if (o.silentOn === step) return;
      const text = (o.replies?.[step] ?? fallback) + "\r\n";
      const bytes = encoder.encode(text);
      if (o.byteByByte) { for (const b of bytes) await conn.write(Uint8Array.of(b)); }
      else await conn.write(bytes);
    };

    let from = "";
    let to: string[] = [];
    try {
      await reply("GREETING", "220 fake.example.com ESMTP ready");
      for (;;) {
        const line = await reader.line();
        if (line === null) break;
        session.lines.push(line);
        const verb = line.split(" ")[0]!.toUpperCase();
        session.commands.push(verb);
        if (verb === "EHLO") {
          const ext = [...(o.extensions ?? ["8BITMIME", "ENHANCEDSTATUSCODES"])];
          if (o.starttls && !session.secure) ext.push("STARTTLS");
          if (!o.authNeedsTls || session.secure) ext.push("AUTH PLAIN LOGIN XOAUTH2");
          const all = ["fake.example.com greets you", ...ext];
          await reply(
            "EHLO",
            all.map((l, i) => `250${i === all.length - 1 ? " " : "-"}${l}`).join("\r\n"),
          );
        } else if (verb === "HELO") {
          await reply("HELO", "250 fake.example.com");
        } else if (verb === "STARTTLS") {
          // Injected bytes travel in the same packet as the 220, as in a real attack.
          await reply(
            "STARTTLS",
            "220 2.0.0 Ready to start TLS" +
              (o.afterStartTls ? "\r\n" + o.afterStartTls.replace(/\r\n$/, "") : ""),
          );
          if (o.replies?.STARTTLS && !o.replies.STARTTLS.startsWith("220")) continue;
          if (init.upgrade) {
            conn = await init.upgrade(conn);
            reader = new LineReader(conn);
          }
          session.secure = true;
        } else if (verb === "AUTH") {
          await this.#auth(line, reader, reply, session);
        } else if (verb === "MAIL") {
          from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          to = [];
          await reply("MAIL", "250 2.1.0 Sender OK");
        } else if (verb === "RCPT") {
          const rcpt = /<([^>]*)>/.exec(line)?.[1] ?? "";
          const custom = o.recipients?.[rcpt];
          if (custom) {
            if (o.silentOn !== "RCPT") await conn.write(encoder.encode(custom + "\r\n"));
          } else {
            to.push(rcpt);
            await reply("RCPT", "250 2.1.5 Recipient OK");
          }
        } else if (verb === "DATA") {
          await reply("DATA", "354 End data with <CR><LF>.<CR><LF>");
          if (o.replies?.DATA && !o.replies.DATA.startsWith("354")) continue;
          const body: string[] = [];
          for (;;) {
            const l = await reader.line();
            if (l === null) throw new Error("connection ended during DATA");
            if (l === ".") break;
            body.push(l.startsWith(".") ? l.slice(1) : l);
          }
          this.messages.push({ from, to, data: body.join("\r\n") + "\r\n" });
          await reply("END", "250 2.0.0 Ok: queued as FAKE123");
        } else if (verb === "RSET") {
          from = "";
          to = [];
          await reply("RSET", "250 2.0.0 Ok");
        } else if (verb === "NOOP") {
          await reply("NOOP", "250 2.0.0 Ok");
        } else if (verb === "QUIT") {
          session.quit = true;
          await conn.write(encoder.encode("221 2.0.0 Bye\r\n"));
          break;
        } else {
          await conn.write(encoder.encode("502 5.5.2 Command not recognised\r\n"));
        }
      }
    } catch {
      // the client went away
    } finally {
      session.ended = true;
      try {
        conn.close();
      } catch {
        // closed already
      }
    }
  }

  async #auth(
    line: string,
    reader: LineReader,
    reply: (step: Step, fallback: string) => Promise<void>,
    session: Session,
  ): Promise<void> {
    const o = this.options;
    const [, mech = "", initial] = line.split(" ");
    const method = mech.toUpperCase();
    session.authMethod = method;
    const fail = "535 5.7.8 Authentication credentials invalid";
    if (o.replies?.AUTH) {
      await reply("AUTH", o.replies.AUTH);
      return;
    }
    if (method === "PLAIN") {
      let data = initial;
      if (!data) {
        await reply("AUTH", "334 ");
        data = (await reader.line()) ?? "";
      }
      const [, user = "", pass = ""] = decodeBase64(data).split("\0");
      if (o.users?.[user] === pass) {
        session.authUser = user;
        await reply("AUTH", "235 2.7.0 Authentication successful");
      } else await reply("AUTH", fail);
    } else if (method === "LOGIN") {
      await reply("AUTH", "334 VXNlcm5hbWU6");
      const user = decodeBase64((await reader.line()) ?? "");
      await reply("AUTH", "334 UGFzc3dvcmQ6");
      const pass = decodeBase64((await reader.line()) ?? "");
      if (o.users?.[user] === pass) {
        session.authUser = user;
        await reply("AUTH", "235 2.7.0 Authentication successful");
      } else await reply("AUTH", fail);
    } else if (method === "XOAUTH2") {
      const decoded = decodeBase64(initial ?? "");
      // deno-lint-ignore no-control-regex
      const match = /^user=([^\x01]*)\x01auth=Bearer ([^\x01]*)\x01\x01$/.exec(decoded);
      if (match && o.tokens?.[match[1]!] === match[2]) {
        session.authUser = match[1];
        await reply("AUTH", "235 2.7.0 Accepted");
      } else {
        await reply(
          "AUTH",
          "334 " + encodeBase64('{"status":"401","schemes":"bearer","scope":"mail"}'),
        );
        session.lines.push((await reader.line()) ?? "<eof>");
        await reply("AUTH", fail);
      }
    } else {
      await reply("AUTH", "504 5.5.4 Unrecognised authentication type");
    }
  }
}

/** Reads CRLF-terminated lines. A bare LF is kept inside the line so tests can detect it. */
class LineReader {
  #conn: Connection;
  #buffer = "";
  #decoder = new TextDecoder();
  constructor(conn: Connection) {
    this.#conn = conn;
  }
  async line(): Promise<string | null> {
    const chunk = new Uint8Array(4096);
    for (;;) {
      const end = this.#buffer.indexOf("\r\n");
      if (end !== -1) {
        const line = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 2);
        return line;
      }
      const n = await this.#conn.read(chunk);
      if (n === null) return null;
      this.#buffer += this.#decoder.decode(chunk.subarray(0, n), { stream: true });
    }
  }
}

class PipeEnd implements Connection {
  peer!: PipeEnd;
  #queue: Uint8Array[] = [];
  #closed = false;
  #peerClosed = false;
  #wake: (() => void) | undefined;

  #notify() {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
  push(data: Uint8Array) {
    this.#queue.push(data);
    this.#notify();
  }
  peerEnded() {
    this.#peerClosed = true;
    this.#notify();
  }
  async read(buffer: Uint8Array): Promise<number | null> {
    for (;;) {
      if (this.#closed) throw new Error("read on a closed connection");
      const chunk = this.#queue[0];
      if (chunk) {
        const n = Math.min(buffer.length, chunk.length);
        buffer.set(chunk.subarray(0, n));
        if (n === chunk.length) this.#queue.shift();
        else this.#queue[0] = chunk.subarray(n);
        return n;
      }
      if (this.#peerClosed) return null;
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
  }
  write(data: Uint8Array): Promise<number> {
    if (this.#closed || this.#peerClosed) return Promise.reject(new Error("broken pipe"));
    this.peer.push(data.slice());
    return Promise.resolve(data.length);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#notify();
    this.peer.peerEnded();
  }
}

/** Two connected in-memory connection ends. */
export function pipe(): [Connection, Connection] {
  const a = new PipeEnd();
  const b = new PipeEnd();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** Waits until every session on the server has ended. */
export async function settled(server: FakeServer): Promise<void> {
  for (let i = 0; i < 200 && server.sessions.some((s) => !s.ended); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}
