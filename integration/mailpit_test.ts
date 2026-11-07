// Sends real messages to Mailpit (https://mailpit.axllent.org) and checks what its
// parser makes of them. Expects Mailpit with SMTP on MAILPIT_SMTP_PORT (default 1025)
// and its API on MAILPIT_API (default http://127.0.0.1:8025), started with
// MP_SMTP_AUTH_ACCEPT_ANY=1 and MP_SMTP_AUTH_ALLOW_INSECURE=1.

import { assert, assertEquals } from "@std/assert";
import { send, SmtpClient, type TransportOptions } from "../mod.ts";
import { nodeConnector } from "../node.ts";

const api = Deno.env.get("MAILPIT_API") ?? "http://127.0.0.1:8025";
const transport: TransportOptions = {
  host: "127.0.0.1",
  port: Number(Deno.env.get("MAILPIT_SMTP_PORT") ?? 1025),
  security: "none",
  auth: { user: "tester", pass: "not-a-real-password" },
  allowInsecureAuth: true,
};

interface Summary {
  ID: string;
  MessageID: string;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(api + path, init);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return await res.json() as T;
}

async function fetchMessage(messageId: string) {
  const bare = messageId.replace(/^<|>$/g, "");
  for (let i = 0; i < 50; i++) {
    const list = await json<{ messages: Summary[] }>("/api/v1/messages?limit=100");
    const hit = list.messages.find((m) => m.MessageID === bare);
    if (hit) return await json<Record<string, unknown>>(`/api/v1/message/${hit.ID}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`message ${messageId} did not arrive`);
}

type Addr = { Name: string; Address: string };

Deno.test("Mailpit: a full multipart message parses as sent", async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const pdf = new TextEncoder().encode("%PDF-1.4 fake test file\n");
  const subject = "Grüße — integration test 🎉 " + "with a long subject line ".repeat(4).trim();
  const text = "Hello Zoë,\n.a line starting with a dot\n" + "long ".repeat(60) + "\nBye";
  const html = '<p>Hello <b>Zoë</b></p><img src="cid:logo@example.com">';
  const result = await send(transport, {
    from: { name: "Ålesund Test Sender", address: "sender@example.com" },
    to: [{ name: "Zoë Example", address: "zoe@example.com" }, "plain@example.com"],
    cc: '"Roe, Sam" <sam@example.com>',
    bcc: "hidden@example.com",
    replyTo: "replies@example.com",
    subject,
    text,
    html,
    headers: { "X-Test-Run": "integration" },
    attachments: [
      { filename: "logo.png", content: png, contentId: "logo@example.com" },
      { filename: "Bericht für Q3.pdf", content: pdf },
    ],
  });
  assertEquals(result.code, 250);

  const m = await fetchMessage(result.messageId);
  assertEquals(m.Subject, subject);
  assertEquals(m.From, { Name: "Ålesund Test Sender", Address: "sender@example.com" });
  assertEquals((m.To as Addr[]).map((a) => [a.Name, a.Address]), [
    ["Zoë Example", "zoe@example.com"],
    ["", "plain@example.com"],
  ]);
  assertEquals((m.Cc as Addr[]).map((a) => [a.Name, a.Address]), [["Roe, Sam", "sam@example.com"]]);
  assertEquals((m.ReplyTo as Addr[]).map((a) => a.Address), ["replies@example.com"]);
  assertEquals((m.Bcc as Addr[]).map((a) => a.Address), ["hidden@example.com"]);
  assertEquals((m.Text as string).replace(/\r\n/g, "\n").trimEnd(), text);
  assertEquals((m.HTML as string).trim(), html);

  const attachments = m.Attachments as Array<
    { FileName: string; ContentType: string; Size: number }
  >;
  assertEquals(attachments.map((a) => [a.FileName, a.ContentType, a.Size]), [
    ["Bericht für Q3.pdf", "application/pdf", pdf.length],
  ]);
  const inline = m.Inline as Array<{ FileName: string; ContentID: string; Size: number }>;
  assertEquals(inline.map((a) => [a.FileName, a.ContentID, a.Size]), [
    ["logo.png", "logo@example.com", png.length],
  ]);

  const headers = await json<Record<string, string[]>>(`/api/v1/message/${m.ID}/headers`);
  assertEquals(headers["X-Test-Run"], ["integration"]);
  // Mailpit records envelope-only recipients by prepending its own Bcc line on receipt,
  // above its trace headers. What we sent starts at From: and must not contain one.
  const raw = await (await fetch(`${api}/api/v1/message/${m.ID}/raw`)).text();
  const ours = raw.slice(raw.search(/^From:/m));
  assert(!/^Bcc:/im.test(ours), "the sent message has no Bcc header");
  assert(!ours.includes("hidden@example.com"));
});

Deno.test("Mailpit: several messages over one connection, with the Node connector", async () => {
  await using client = await SmtpClient.connect({ ...transport, connector: nodeConnector() });
  const ids: string[] = [];
  for (const n of [1, 2, 3]) {
    const r = await client.send({
      from: "batch@example.com",
      to: `user${n}@example.com`,
      subject: `Batch ${n}`,
      text: `Message ${n}`,
    });
    ids.push(r.messageId);
  }
  for (const [i, id] of ids.entries()) {
    const m = await fetchMessage(id);
    assertEquals(m.Subject, `Batch ${i + 1}`);
    assertEquals((m.Text as string).trim(), `Message ${i + 1}`);
  }
});
