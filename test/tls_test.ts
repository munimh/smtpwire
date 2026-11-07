// Real TLS handshakes against the fake server. Needs a throwaway certificate for
// "localhost", passed in by path (see .github/workflows/ci.yml):
//   SMTPWIRE_TEST_CA=ca.pem SMTPWIRE_TEST_CERT=cert.pem SMTPWIRE_TEST_KEY=key.pem
// Create them with test/gen_test_cert.sh. The tests are skipped when they are not set.
// Never commit the generated files.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createServer, type Socket } from "node:net";
import { createSecureContext, TLSSocket } from "node:tls";
import { type Connection, denoConnector, send, SmtpError } from "../mod.ts";
import { nodeConnector } from "../node.ts";
import { FakeServer, settled } from "./fake_server.ts";

const certPath = Deno.env.get("SMTPWIRE_TEST_CERT");
const keyPath = Deno.env.get("SMTPWIRE_TEST_KEY");
const caPath = Deno.env.get("SMTPWIRE_TEST_CA");
const ignore = !certPath || !keyPath || !caPath;
const cert = ignore ? "" : Deno.readTextFileSync(certPath);
const key = ignore ? "" : Deno.readTextFileSync(keyPath);
const ca = ignore ? "" : Deno.readTextFileSync(caPath);

const message = { from: "app@example.com", to: "jane@example.com", subject: "TLS", text: "hi" };

/** Server-side adapter from a Node socket to a Connection (test only). */
function wrap(socket: Socket): Connection & { socket: Socket } {
  const chunks: Uint8Array[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  const onData = (c: Uint8Array) => (chunks.push(c), notify());
  const onEnd = () => ((ended = true), notify());
  socket.on("data", onData).on("end", onEnd).on("close", onEnd).on("error", onEnd);
  return {
    socket,
    async read(buf) {
      while (!chunks.length) {
        if (ended) return null;
        await new Promise<void>((r) => (wake = r));
      }
      const c = chunks[0]!;
      const n = Math.min(c.length, buf.length);
      buf.set(c.subarray(0, n));
      if (n === c.length) chunks.shift();
      else chunks[0] = c.subarray(n);
      return n;
    },
    write: (d) => new Promise((res, rej) => socket.write(d, (e) => (e ? rej(e) : res(d.length)))),
    close() {
      socket.off("data", onData);
      socket.destroy();
    },
  };
}

Deno.test({
  name: "implicit TLS (465 style) against Deno.listenTls",
  ignore,
  async fn() {
    const server = new FakeServer({ users: { u: "p" } });
    const listener = Deno.listenTls({ hostname: "127.0.0.1", port: 0, cert, key });
    const loop = (async () => {
      for await (const conn of listener) server.serve(conn, { secure: true });
    })();
    try {
      const options = {
        host: "localhost",
        port: listener.addr.port,
        security: "tls" as const,
        auth: { user: "u", pass: "p" },
      };
      await send({ ...options, connector: denoConnector({ caCerts: [ca] }) }, message);
      await send({ ...options, connector: nodeConnector({ tls: { ca } }) }, message);
      assertEquals(server.messages.length, 2);

      // Without trusting the test CA the handshake must fail at the TLS stage.
      const err = await assertRejects(() => send(options, message), SmtpError);
      assertEquals(err.stage, "tls");
    } finally {
      listener.close();
      await loop.catch(() => {});
      await settled(server);
    }
  },
});

Deno.test({
  name: "STARTTLS (587 style) with a real TLS upgrade",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = new FakeServer({ starttls: true, authNeedsTls: true, users: { u: "p" } });
    const context = createSecureContext({ cert, key });
    const tcp = createServer((socket) => {
      const conn = wrap(socket);
      server.serve(conn, {
        upgrade: (plain) => {
          const raw = (plain as typeof conn).socket;
          raw.removeAllListeners("data");
          const secure = new TLSSocket(raw, { isServer: true, secureContext: context });
          return Promise.resolve(wrap(secure as unknown as Socket));
        },
      });
    });
    await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
    const port = (tcp.address() as { port: number }).port;
    try {
      const options = {
        host: "localhost",
        port,
        security: "starttls" as const,
        auth: { user: "u", pass: "p" },
      };
      await send({ ...options, connector: denoConnector({ caCerts: [ca] }) }, message);
      await send({ ...options, connector: nodeConnector({ tls: { ca } }) }, message);
      assertEquals(server.messages.length, 2);
      assert(server.sessions.every((s) => s.secure && s.authUser === "u"));
    } finally {
      await new Promise((r) => tcp.close(r));
      await settled(server);
    }
  },
});
