// The swappable network layer and its default Deno implementation.

import { SmtpError } from "./errors.ts";

/**
 * A byte stream to the server. Deno's `Deno.Conn` already has this shape.
 */
export interface Connection {
  /** Reads into `buffer`; resolves to the number of bytes read, or `null` at end of stream. */
  read(buffer: Uint8Array): Promise<number | null>;
  /** Writes some or all of `data`; resolves to the number of bytes written. */
  write(data: Uint8Array): Promise<number>;
  /** Closes the stream. Must not throw if it is already closed. */
  close(): void;
}

/**
 * How the client opens connections. Implement this to run on a runtime without
 * `Deno.connect`, or to tunnel through a proxy.
 *
 * Implicit TLS (port 465) is done by calling {@linkcode Connector.connect} and then
 * {@linkcode Connector.startTls} straight away, so only these two operations are needed.
 */
export interface Connector {
  /** Opens a plain TCP connection. */
  connect(hostname: string, port: number): Promise<Connection>;
  /**
   * Starts TLS on an open connection and returns the encrypted connection. The
   * certificate must be verified against `hostname`. The handshake should be complete
   * when the promise resolves.
   */
  startTls(connection: Connection, hostname: string): Promise<Connection>;
}

/** Options for {@linkcode denoConnector}. */
export interface DenoConnectorOptions {
  /** Extra PEM-encoded CA certificates to trust, for example a private test CA. */
  caCerts?: string[];
}

/**
 * The default connector, using `Deno.connect` and `Deno.startTls`. Works on Deno and
 * Supabase Edge Functions.
 *
 * @param options TLS options.
 * @returns A connector.
 */
export function denoConnector(options: DenoConnectorOptions = {}): Connector {
  const deno = (globalThis as { Deno?: typeof Deno }).Deno;
  return {
    connect(hostname, port) {
      if (!deno?.connect) throw noDefault();
      return deno.connect({ hostname, port, transport: "tcp" });
    },
    async startTls(connection, hostname) {
      if (!deno?.startTls) throw noDefault();
      const tls = await deno.startTls(
        connection as Deno.TcpConn,
        options.caCerts ? { hostname, caCerts: options.caCerts } : { hostname },
      );
      await tls.handshake();
      return tls;
    },
  };
}

function noDefault(): Error {
  return new SmtpError(
    "This runtime has no Deno.connect. Pass `connector: nodeConnector()` from " +
      '"@munimh/smtpwire/node", or your own Connector.',
    { stage: "connect", kind: "permanent" },
  );
}
