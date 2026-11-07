import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type Connector,
  dotStuff,
  type Message,
  send,
  SmtpClient,
  SmtpError,
  type SmtpErrorKind,
  type SmtpStage,
  type TransportOptions,
} from "../mod.ts";
import { FakeServer, type FakeServerOptions, settled, type Step } from "./fake_server.ts";
import { parse, text } from "./mime_parse.ts";

const message: Message = {
  from: "app@example.com",
  to: "jane@example.com",
  subject: "Hello",
  text: "Hi Jane",
};

function setup(serverOptions: FakeServerOptions = {}, transport: Partial<TransportOptions> = {}) {
  const server = new FakeServer(serverOptions);
  const options: TransportOptions = {
    host: "mail.example.com",
    port: 2525,
    security: "none",
    connector: server.connector(),
    commandTimeout: 1000,
    ...transport,
  };
  return { server, options };
}

async function expectSmtpError(
  work: Promise<unknown>,
  expected: { stage: SmtpStage; kind: SmtpErrorKind; code?: number; enhancedCode?: string },
): Promise<SmtpError> {
  const err = await assertRejects(() => work, SmtpError);
  assertEquals(err.stage, expected.stage, err.message);
  assertEquals(err.kind, expected.kind, err.message);
  if (expected.code !== undefined) assertEquals(err.code, expected.code);
  if (expected.enhancedCode !== undefined) assertEquals(err.enhancedCode, expected.enhancedCode);
  assertEquals(err.permanent, expected.kind === "permanent");
  assertEquals(err.temporary, expected.kind === "temporary");
  return err;
}

Deno.test("send(): delivers the message, includes cc and bcc on the envelope, and QUITs", async () => {
  const { server, options } = setup();
  const result = await send(options, {
    ...message,
    cc: "cc@example.com",
    bcc: ["hidden@example.com", "JANE@example.com"],
  });
  assertEquals(result.code, 250);
  assertEquals(result.response, "2.0.0 Ok: queued as FAKE123");
  assertEquals(result.accepted, ["jane@example.com", "cc@example.com", "hidden@example.com"]);
  assert(result.messageId.endsWith("@example.com>"));
  const [received] = server.messages;
  assertEquals(received!.from, "app@example.com");
  assertEquals(received!.to, ["jane@example.com", "cc@example.com", "hidden@example.com"]);
  const parsed = parse(received!.data);
  assertEquals(parsed.headers.get("cc"), "cc@example.com");
  assert(!received!.data.includes("hidden@example.com"));
  assertEquals(text(parsed), "Hi Jane\r\n");
  await settled(server);
  assertEquals(server.sessions[0]!.commands, [
    "EHLO",
    "MAIL",
    "RCPT",
    "RCPT",
    "RCPT",
    "DATA",
    "QUIT",
  ]);
  assert(server.sessions[0]!.ended);
});

Deno.test("multi-line replies are read correctly, even one byte at a time", async () => {
  const { options } = setup({
    byteByByte: true,
    extensions: ["SIZE 1000000", "PIPELINING", "8BITMIME", "ENHANCEDSTATUSCODES"],
    replies: { RCPT: "250-2.1.5 First line\r\n250-Second line\r\n250 2.1.5 Last line" },
  });
  await using client = await SmtpClient.connect(options);
  assertEquals(client.capabilities.get("SIZE"), "1000000");
  assert(client.capabilities.has("PIPELINING"));
  assertEquals(client.capabilities.get("AUTH"), "PLAIN LOGIN XOAUTH2");
  const result = await client.send(message);
  assertEquals(result.code, 250);
});

Deno.test("a multi-line refusal is reported in full with its enhanced code", async () => {
  const { options } = setup({
    replies: { RCPT: "550-5.1.1 The address does not exist.\r\n550 5.1.1 See the docs." },
  });
  const err = await expectSmtpError(send(options, message), {
    stage: "recipient",
    kind: "permanent",
    code: 550,
    enhancedCode: "5.1.1",
  });
  assertEquals(err.response, "5.1.1 The address does not exist.\n5.1.1 See the docs.");
  assertEquals(err.recipient, "jane@example.com");
});

Deno.test("malformed replies are rejected", async () => {
  const { options } = setup({ replies: { EHLO: "250-ok\r\n251 mixed codes" } });
  await expectSmtpError(SmtpClient.connect(options), { stage: "connect", kind: "permanent" });
  const second = setup({ replies: { GREETING: "hello there" } });
  await expectSmtpError(SmtpClient.connect(second.options), {
    stage: "connect",
    kind: "permanent",
  });
});

Deno.test("STARTTLS: upgrades, says EHLO again and only then authenticates", async () => {
  const { server, options } = setup(
    { starttls: true, authNeedsTls: true, users: { app: "pw" } },
    { security: "starttls", auth: { user: "app", pass: "pw" } },
  );
  await using client = await SmtpClient.connect(options);
  assert(client.secure);
  assertEquals(server.upgrades, 1);
  assertEquals(server.sessions[0]!.commands, ["EHLO", "STARTTLS", "EHLO", "AUTH"]);
  assert(!client.capabilities.has("STARTTLS"), "capabilities are refreshed after TLS");
  assertEquals(server.sessions[0]!.authUser, "app");
});

Deno.test("STARTTLS: missing support fails instead of continuing unencrypted", async () => {
  const { server, options } = setup({}, { security: "starttls", auth: { user: "a", pass: "b" } });
  await expectSmtpError(SmtpClient.connect(options), { stage: "tls", kind: "permanent" });
  await settled(server);
  assert(!server.sessions[0]!.commands.includes("AUTH"));
  assert(server.sessions[0]!.ended, "connection closed");
});

Deno.test("STARTTLS: data injected before the handshake is refused", async () => {
  const { server, options } = setup(
    { starttls: true, afterStartTls: "250 injected\r\n" },
    { security: "starttls" },
  );
  const err = await expectSmtpError(SmtpClient.connect(options), {
    stage: "tls",
    kind: "permanent",
  });
  assertStringIncludes(err.message, "unexpected data");
  assertEquals(server.upgrades, 0);
});

Deno.test("port defaults: 465 means implicit TLS, other ports STARTTLS", async () => {
  const seen: Array<[string, number]> = [];
  const server = new FakeServer({ starttls: true });
  const inner = server.connector();
  const connector: Connector = {
    connect: (host, port) => {
      seen.push([host, port]);
      return inner.connect(host, port);
    },
    startTls: inner.startTls,
  };
  await (await SmtpClient.connect({ host: "h.example.com", connector })).close();
  assertEquals(seen.pop(), ["h.example.com", 465]);
  assertEquals(server.sessions[0]!.commands[0], "EHLO", "no STARTTLS on implicit TLS");
  await (await SmtpClient.connect({ host: "h.example.com", port: 587, connector })).close();
  assertEquals(server.sessions[1]!.commands.slice(0, 2), ["EHLO", "STARTTLS"]);
  assertEquals(server.upgrades, 2);
});

for (const method of ["plain", "login"] as const) {
  Deno.test(`AUTH ${method.toUpperCase()}: success and failure`, async () => {
    const { server, options } = setup(
      { users: { "user@example.com": "pässwörd" } },
      { auth: { user: "user@example.com", pass: "pässwörd", method }, allowInsecureAuth: true },
    );
    await (await SmtpClient.connect(options)).close();
    assertEquals(server.sessions[0]!.authMethod, method.toUpperCase());
    assertEquals(server.sessions[0]!.authUser, "user@example.com");

    const bad = setup(
      { users: { "user@example.com": "right" } },
      { auth: { user: "user@example.com", pass: "wrong", method }, allowInsecureAuth: true },
    );
    await expectSmtpError(SmtpClient.connect(bad.options), {
      stage: "auth",
      kind: "permanent",
      code: 535,
      enhancedCode: "5.7.8",
    });
    await settled(bad.server);
    assert(bad.server.sessions[0]!.ended);
  });
}

Deno.test("AUTH PLAIN is preferred, LOGIN used when PLAIN is not offered", async () => {
  const { server, options } = setup(
    { users: { u: "p" } },
    { auth: { user: "u", pass: "p" }, allowInsecureAuth: true },
  );
  await (await SmtpClient.connect(options)).close();
  assertEquals(server.sessions[0]!.authMethod, "PLAIN");

  const loginOnly = setup(
    { users: { u: "p" }, replies: { EHLO: "250-fake\r\n250 AUTH LOGIN" } },
    { auth: { user: "u", pass: "p" }, allowInsecureAuth: true },
  );
  await (await SmtpClient.connect(loginOnly.options)).close();
  assertEquals(loginOnly.server.sessions[0]!.authMethod, "LOGIN");
});

Deno.test("AUTH XOAUTH2: success, and failure after the JSON challenge", async () => {
  const { server, options } = setup(
    { tokens: { "user@example.com": "ya29.token" } },
    { auth: { user: "user@example.com", accessToken: "ya29.token" }, allowInsecureAuth: true },
  );
  await (await SmtpClient.connect(options)).close();
  assertEquals(server.sessions[0]!.authMethod, "XOAUTH2");
  assertEquals(server.sessions[0]!.authUser, "user@example.com");

  const bad = setup(
    { tokens: { "user@example.com": "ya29.token" } },
    { auth: { user: "user@example.com", accessToken: "expired" }, allowInsecureAuth: true },
  );
  await expectSmtpError(SmtpClient.connect(bad.options), {
    stage: "auth",
    kind: "permanent",
    code: 535,
  });
  // The client answered the 334 challenge with an empty line.
  assertEquals(bad.server.sessions[0]!.lines[2], "");
});

Deno.test("AUTH: no supported mechanism, or one the server does not offer", async () => {
  const none = setup(
    { replies: { EHLO: "250-fake\r\n250 AUTH CRAM-MD5" } },
    { auth: { user: "u", pass: "p" }, allowInsecureAuth: true },
  );
  await expectSmtpError(SmtpClient.connect(none.options), { stage: "auth", kind: "permanent" });
  const forced = setup(
    { replies: { EHLO: "250-fake\r\n250 AUTH PLAIN" } },
    { auth: { user: "u", pass: "p", method: "login" }, allowInsecureAuth: true },
  );
  await expectSmtpError(SmtpClient.connect(forced.options), { stage: "auth", kind: "permanent" });
});

Deno.test("credentials are never sent over an unencrypted connection by default", async () => {
  const { server, options } = setup({ users: { u: "p" } }, { auth: { user: "u", pass: "p" } });
  const err = await expectSmtpError(SmtpClient.connect(options), {
    stage: "auth",
    kind: "permanent",
  });
  assertStringIncludes(err.message, "unencrypted");
  assert(!server.sessions[0]!.commands.includes("AUTH"));
});

Deno.test("debug output masks passwords, tokens and their base64 forms", async () => {
  const secrets = ["s3cret-Pa55", "tok-abc-123"];
  const log: string[] = [];
  for (
    const auth of [
      { user: "u", pass: secrets[0]!, method: "plain" as const },
      { user: "u", pass: secrets[0]!, method: "login" as const },
      { user: "u", accessToken: secrets[1]! },
    ]
  ) {
    const { options } = setup(
      { users: { u: secrets[0]! }, tokens: { u: "other" } },
      { auth, allowInsecureAuth: true, debug: (line) => log.push(line) },
    );
    await SmtpClient.connect(options).then((c) => c.close(), () => {});
  }
  const all = log.join("\n");
  assertStringIncludes(all, "AUTH PLAIN <redacted>");
  assertStringIncludes(all, "AUTH XOAUTH2 <redacted>");
  for (const secret of secrets) {
    assert(!all.includes(secret));
    for (const shift of ["", "\0u\0", "user=u\x01auth=Bearer "]) {
      assert(!all.includes(btoa(shift + secret).slice(0, 8)), "no base64 of the secret");
    }
  }
  assert(!all.includes(btoa("u")), "LOGIN username line is masked too");
  assert(!log.some((l) => l.includes("Hi Jane")));
});

Deno.test("dot-stuffing and CRLF: lines starting with dots survive the round trip", async () => {
  const { server, options } = setup();
  const raw = "Subject: dots\n\n.leading dot\n..two dots\n.\nmiddle . dot\r\nbare CR\rend";
  await send(options, { ...message }); // warm-up: normal message
  await using client = await SmtpClient.connect(options);
  await client.send({ raw, envelope: { from: "a@example.com", to: ["b@example.com"] } });
  const data = server.messages[1]!.data;
  assertEquals(
    data,
    "Subject: dots\r\n\r\n.leading dot\r\n..two dots\r\n.\r\nmiddle . dot\r\nbare CR\r\nend\r\n",
  );
  assert(!/[^\r]\n|\r[^\n]/.test(data), "only CRLF line breaks on the wire");
});

Deno.test("dotStuff()", () => {
  assertEquals(dotStuff(".a\r\nb\r\n.\r\n"), "..a\r\nb\r\n..\r\n");
  assertEquals(dotStuff("no newline"), "no newline\r\n");
  assertEquals(dotStuff("a.b\r\n. c"), "a.b\r\n.. c\r\n");
});

// A 4xx and a 5xx reply at every stage.
const stageCases: Array<
  { stage: SmtpStage; step: Step; options?: Partial<TransportOptions>; server?: FakeServerOptions }
> = [
  { stage: "connect", step: "GREETING" },
  { stage: "connect", step: "EHLO" },
  { stage: "tls", step: "STARTTLS", options: { security: "starttls" }, server: { starttls: true } },
  {
    stage: "auth",
    step: "AUTH",
    options: { auth: { user: "u", pass: "p" }, allowInsecureAuth: true },
    server: { users: { u: "p" } },
  },
  { stage: "sender", step: "MAIL" },
  { stage: "recipient", step: "RCPT" },
  { stage: "data", step: "DATA" },
  { stage: "data", step: "END" },
];

for (const c of stageCases) {
  for (const [code, kind] of [[451, "temporary"], [554, "permanent"]] as const) {
    Deno.test(`${code} at ${c.step} -> stage "${c.stage}", ${kind}, connection closed`, async () => {
      const enhanced = `${String(code)[0]}.3.0`;
      // EHLO 5xx would trigger the HELO fallback, so refuse HELO too.
      const replies: FakeServerOptions["replies"] = { [c.step]: `${code} ${enhanced} No` };
      if (c.step === "EHLO") replies.HELO = `${code} ${enhanced} No`;
      const { server, options } = setup({ ...c.server, replies }, c.options);
      await expectSmtpError(send(options, message), {
        stage: c.stage,
        kind,
        code,
        enhancedCode: enhanced,
      });
      await settled(server);
      assert(server.sessions.every((s) => s.ended), "every connection is closed");
      assertEquals(server.messages.length, c.step === "END" ? 1 : 0);
    });
  }
}

Deno.test("EHLO refused with 502 falls back to HELO", async () => {
  const { server, options } = setup({ replies: { EHLO: "502 5.5.2 What?" } });
  await send(options, message);
  assertEquals(server.sessions[0]!.commands.slice(0, 2), ["EHLO", "HELO"]);
});

Deno.test("timeouts: connect, greeting, a command, and after the body (delivery unknown)", async () => {
  const hanging: Connector = {
    connect: () => new Promise(() => {}),
    startTls: (c) => Promise.resolve(c),
  };
  const connectErr = await expectSmtpError(
    send(
      { host: "h.example.com", security: "none", connector: hanging, connectTimeout: 30 },
      message,
    ),
    { stage: "connect", kind: "temporary" },
  );
  assert(connectErr.timeout);

  for (
    const [step, stage, kind] of [
      ["GREETING", "connect", "temporary"],
      ["MAIL", "sender", "temporary"],
      ["RCPT", "recipient", "temporary"],
      ["DATA", "data", "temporary"],
      ["END", "data", "unknown"],
    ] as const
  ) {
    const { server, options } = setup({ silentOn: step }, { commandTimeout: 40, dataTimeout: 60 });
    const err = await expectSmtpError(send(options, message), { stage, kind });
    assert(err.timeout, `${step} timed out`);
    assertEquals(err.deliveryUnknown, kind === "unknown");
    await settled(server);
    assert(server.sessions[0]!.ended, `connection closed after ${step} timeout`);
  }
});

Deno.test("SmtpClient: several messages on one connection, recovering from a refused recipient", async () => {
  const { server, options } = setup({
    recipients: { "nobody@example.com": "550 5.1.1 No such user" },
  });
  const client = await SmtpClient.connect(options);
  await client.send({ ...message, to: "ann@example.com" });
  await expectSmtpError(client.send({ ...message, to: "nobody@example.com" }), {
    stage: "recipient",
    kind: "permanent",
    code: 550,
  });
  assert(!client.closed, "a refusal keeps the connection usable");
  await client.send({ ...message, to: "bob@example.com" });
  await client.noop();
  await client.close();
  assert(client.closed);
  assertEquals(server.sessions.length, 1);
  assertEquals(server.messages.map((m) => m.to), [["ann@example.com"], ["bob@example.com"]]);
  assertEquals(server.sessions[0]!.commands.filter((c) => c === "RSET").length, 1);
  await expectSmtpError(client.send(message), { stage: "sender", kind: "permanent" });
});

Deno.test("SIZE limit is checked before sending", async () => {
  const { server, options } = setup({ extensions: ["SIZE 100"] });
  const err = await expectSmtpError(send(options, { ...message, text: "x".repeat(500) }), {
    stage: "sender",
    kind: "permanent",
  });
  assertStringIncludes(err.message, "at most 100");
  assert(!server.sessions[0]!.commands.includes("MAIL"));
});

Deno.test("SIZE parameter is sent when advertised", async () => {
  const { server, options } = setup({ extensions: ["SIZE 100000"] });
  await send(options, message);
  assert(/^MAIL FROM:<app@example\.com> SIZE=\d+$/.test(server.sessions[0]!.lines[1]!));
});

Deno.test("envelope addresses with line breaks or brackets are rejected before sending", async () => {
  const { server, options } = setup();
  await using client = await SmtpClient.connect(options);
  for (const bad of ["a@example.com>\r\nRCPT TO:<x@example.com", "a@example.com> SIZE=1"]) {
    await assertRejects(() =>
      client.send({ raw: "Subject: x\r\n\r\nx", envelope: { from: "a@example.com", to: [bad] } })
    );
  }
  assertEquals(server.sessions[0]!.commands, ["EHLO"]);
});

Deno.test("over real TCP with the Deno and Node connectors", async () => {
  const { nodeConnector } = await import("../node.ts");
  const server = new FakeServer({ users: { u: "p" } });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const accepting = (async () => {
    for await (const conn of listener) server.serve(conn);
  })();
  const port = listener.addr.port;
  try {
    for (const connector of [undefined, nodeConnector()]) {
      await send({
        host: "127.0.0.1",
        port,
        security: "none",
        auth: { user: "u", pass: "p" },
        allowInsecureAuth: true,
        ...(connector ? { connector } : {}),
      }, message);
    }
    assertEquals(server.messages.length, 2);
  } finally {
    listener.close();
    await accepting.catch(() => {});
    await settled(server);
  }
});
