/**
 * A {@linkcode Connector} for Node.js and Bun, built on `node:net` and `node:tls`.
 *
 * @example
 * ```ts
 * import { send } from "@munimh/smtpwire";
 * import { nodeConnector } from "@munimh/smtpwire/node";
 *
 * await send(
 *   { host: "smtp.example.com", connector: nodeConnector(), auth: { user: "app", pass: "secret" } },
 *   { from: "app@example.com", to: "jane@example.com", subject: "Hi", text: "Hello" },
 * );
 * ```
 *
 * @module
 */

import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import type { Connection, Connector } from "./src/net.ts";

/** Options for {@linkcode nodeConnector}. */
export interface NodeConnectorOptions {
  /**
   * Extra `tls.connect` options, for example `ca` for a private CA. `socket` and
   * `servername` are always set by the connector.
   */
  tls?: Omit<ConnectionOptions, "socket" | "host" | "port">;
}

/** Adapts a push-based Node socket to the pull-based {@linkcode Connection}. */
class SocketConnection implements Connection {
  #socket: Socket;
  #chunks: Uint8Array[] = [];
  #ended = false;
  #error: Error | undefined;
  #wake: (() => void) | undefined;
  #onData = (chunk: Uint8Array) => {
    this.#chunks.push(chunk);
    this.#notify();
  };
  #onEnd = () => {
    this.#ended = true;
    this.#notify();
  };
  #onError = (err: Error) => {
    this.#error = err;
    this.#notify();
  };

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", this.#onData);
    socket.on("end", this.#onEnd);
    socket.on("close", this.#onEnd);
    socket.on("error", this.#onError);
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async read(buffer: Uint8Array): Promise<number | null> {
    while (!this.#chunks.length) {
      if (this.#error) throw this.#error;
      if (this.#ended) return null;
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
    const chunk = this.#chunks[0]!;
    const n = Math.min(buffer.length, chunk.length);
    buffer.set(chunk.subarray(0, n));
    if (n === chunk.length) this.#chunks.shift();
    else this.#chunks[0] = chunk.subarray(n);
    return n;
  }

  write(data: Uint8Array): Promise<number> {
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => {
      this.#socket.write(data, (err) => (err ? reject(err) : resolve(data.length)));
    });
  }

  close(): void {
    this.#ended = true;
    this.#socket.destroy();
    this.#notify();
  }

  /** Stops reading so the raw socket can be handed to TLS. */
  detach(): Socket {
    if (this.#chunks.length) throw new Error("Unread data before TLS upgrade");
    this.#socket.off("data", this.#onData);
    this.#socket.off("end", this.#onEnd);
    this.#socket.off("close", this.#onEnd);
    this.#socket.off("error", this.#onError);
    return this.#socket;
  }
}

/**
 * Creates a connector for Node.js and Bun.
 *
 * @param options TLS options.
 * @returns A connector to pass as `connector` in the transport options.
 */
export function nodeConnector(options: NodeConnectorOptions = {}): Connector {
  return {
    connect(hostname, port) {
      return new Promise((resolve, reject) => {
        const socket = netConnect({ host: hostname, port });
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.off("error", reject);
          resolve(new SocketConnection(socket));
        });
      });
    },
    startTls(connection, hostname) {
      if (!(connection instanceof SocketConnection)) {
        return Promise.reject(new Error("nodeConnector can only upgrade its own connections"));
      }
      const socket = connection.detach();
      return new Promise((resolve, reject) => {
        const secure = tlsConnect({
          ...options.tls,
          socket,
          host: hostname,
          ...(isIP(hostname) ? {} : { servername: hostname }),
        });
        secure.once("error", reject);
        secure.once("secureConnect", () => {
          secure.off("error", reject);
          resolve(new SocketConnection(secure));
        });
      });
    },
  };
}

export type { Connection, Connector } from "./src/net.ts";
