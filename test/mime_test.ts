import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { composeMessage, type Message, MessageError } from "../mod.ts";
import { decodeB64, decodeWords, param, parse, text } from "./mime_parse.ts";

const base: Message = {
  from: "app@example.com",
  to: "jane@example.com",
  subject: "Hello",
  date: new Date(Date.UTC(2030, 0, 2, 3, 4, 5)),
};

function lines(raw: string): string[] {
  return raw.slice(0, raw.indexOf("\r\n\r\n")).split("\r\n");
}

Deno.test("text-only message: headers, Date, Message-ID and 7bit body", () => {
  const { raw, messageId, envelope } = composeMessage({ ...base, text: "Hi Jane\nBye" });
  const msg = parse(raw);
  assertEquals(msg.headers.get("from"), "app@example.com");
  assertEquals(msg.headers.get("to"), "jane@example.com");
  assertEquals(msg.headers.get("date"), "Wed, 02 Jan 2030 03:04:05 +0000");
  assertEquals(msg.headers.get("message-id"), messageId);
  assertMatch(messageId, /^<[0-9a-f]{32}@example\.com>$/);
  assertEquals(msg.headers.get("mime-version"), "1.0");
  assertEquals(msg.headers.get("content-type"), "text/plain; charset=UTF-8");
  assertEquals(msg.headers.get("content-transfer-encoding"), "7bit");
  assertEquals(msg.body, "Hi Jane\r\nBye\r\n");
  assertEquals(envelope, { from: "app@example.com", to: ["jane@example.com"] });
  assert(!/[^\r]\n/.test(raw), "every line break is CRLF");
  assert(![...raw].some((c) => c.charCodeAt(0) > 127), "output is 7-bit");
});

Deno.test("html-only message", () => {
  const msg = parse(composeMessage({ ...base, html: "<p>Hi</p>" }).raw);
  assertEquals(msg.headers.get("content-type"), "text/html; charset=UTF-8");
  assertEquals(text(msg), "<p>Hi</p>\r\n");
});

Deno.test("text and html become multipart/alternative, text first", () => {
  const msg = parse(composeMessage({ ...base, text: "Hi", html: "<b>Hi</b>" }).raw);
  assertMatch(msg.headers.get("content-type")!, /^multipart\/alternative; boundary="=_sw_/);
  assertEquals(msg.parts.length, 2);
  assertEquals(msg.parts[0]!.headers.get("content-type"), "text/plain; charset=UTF-8");
  assertEquals(msg.parts[1]!.headers.get("content-type"), "text/html; charset=UTF-8");
  assertEquals(text(msg.parts[1]!), "<b>Hi</b>");
});

Deno.test("attachments use multipart/mixed and base64", () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
  const msg = parse(
    composeMessage({
      ...base,
      text: "See attached",
      html: "<p>See attached</p>",
      attachments: [
        { filename: "data.bin", content: bytes },
        { filename: "notes.txt", content: "plain notes" },
        { filename: "report.pdf", content: bytes, contentType: "application/pdf" },
      ],
    }).raw,
  );
  assertMatch(msg.headers.get("content-type")!, /^multipart\/mixed;/);
  assertEquals(msg.parts.length, 4);
  assertMatch(msg.parts[0]!.headers.get("content-type")!, /^multipart\/alternative/);
  const [bin, txt, pdf] = msg.parts.slice(1);
  assertEquals(bin!.headers.get("content-type"), "application/octet-stream; name=data.bin");
  assertEquals(bin!.headers.get("content-disposition"), "attachment; filename=data.bin");
  assertEquals(decodeB64(bin!.body), bytes);
  assert(bin!.body.split("\r\n").every((l) => l.length <= 76));
  assertEquals(txt!.headers.get("content-type"), "text/plain; charset=UTF-8; name=notes.txt");
  assertEquals(new TextDecoder().decode(decodeB64(txt!.body)), "plain notes");
  assertEquals(pdf!.headers.get("content-type"), "application/pdf; name=report.pdf");
});

Deno.test("inline images by Content-ID use multipart/related inside alternative", () => {
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
  const msg = parse(
    composeMessage({
      ...base,
      text: "Logo",
      html: '<img src="cid:logo@example.com">',
      attachments: [
        { filename: "logo.png", content: png, contentId: "logo@example.com" },
        { filename: "terms.pdf", content: png },
      ],
    }).raw,
  );
  assertMatch(msg.headers.get("content-type")!, /^multipart\/mixed/);
  const alt = msg.parts[0]!;
  assertMatch(alt.headers.get("content-type")!, /^multipart\/alternative/);
  const related = alt.parts[1]!;
  assertMatch(related.headers.get("content-type")!, /^multipart\/related; type="text\/html"/);
  const image = related.parts[1]!;
  assertEquals(image.headers.get("content-id"), "<logo@example.com>");
  assertEquals(image.headers.get("content-disposition"), "inline; filename=logo.png");
  assertEquals(msg.parts[1]!.headers.get("content-disposition"), "attachment; filename=terms.pdf");
});

Deno.test("non-ASCII subject is encoded and decodes back", () => {
  for (const subject of ["Grüße aus Köln", "日本語の件名です", "Emoji 🎉 time", "Ünïcödé"]) {
    const msg = parse(composeMessage({ ...base, subject, text: "x" }).raw);
    const value = msg.headers.get("subject")!;
    assertMatch(value, /^=\?UTF-8\?[QB]\?/);
    assertEquals(decodeWords(value), subject);
  }
});

Deno.test("long non-ASCII subject folds at 78 characters without splitting characters", () => {
  const subject = "Résumé für die Überprüfung — ".repeat(8) + "🎉漢字";
  const { raw } = composeMessage({ ...base, subject, text: "x" });
  const header = parse(raw).rawHeaders.find((h) => h.startsWith("Subject:"))!;
  const folded = header.split("\r\n");
  assert(folded.length > 3, "the subject is folded");
  for (const line of folded) assert(line.length <= 78, `line too long: ${line.length}`);
  for (const word of header.match(/=\?[^?]+\?[QB]\?[^?]*\?=/g)!) assert(word.length <= 75);
  assertEquals(decodeWords(header.replace(/\r\n/g, "").slice("Subject: ".length)), subject);
});

Deno.test("long ASCII subject folds at spaces and unfolds to the original", () => {
  const subject = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const header = lines(composeMessage({ ...base, subject, text: "x" }).raw)
    .join("\n")
    .match(/Subject:.*(\n[ \t].*)*/)![0];
  for (const line of header.split("\n")) assert(line.length <= 78);
  assertEquals(header.replace(/\n/g, "").slice("Subject: ".length), subject);
});

Deno.test("display names: quoting, escaping and encoding", () => {
  const msg = parse(
    composeMessage({
      ...base,
      from: { name: "Doe, Jane", address: "jane@example.com" },
      to: [
        'Sam "the Tester" Roe <sam@example.com>',
        { name: "Zoë Ångström", address: "zoe@example.com" },
        "plain@example.com",
      ],
      replyTo: { name: "Support Team", address: "help@example.com" },
      text: "x",
    }).raw,
  );
  assertEquals(msg.headers.get("from"), '"Doe, Jane" <jane@example.com>');
  const to = msg.headers.get("to")!;
  assert(to.startsWith('"Sam \\"the Tester\\" Roe" <sam@example.com>, '));
  assertEquals(decodeWords(to).split(", ")[1], "Zoë Ångström <zoe@example.com>");
  assert(to.endsWith(", plain@example.com"));
  assertEquals(msg.headers.get("reply-to"), "Support Team <help@example.com>");
});

Deno.test("Bcc goes to the envelope only, and recipients are listed", () => {
  const { raw, envelope } = composeMessage({
    ...base,
    cc: "cc@example.com",
    bcc: ["hidden@example.com"],
    text: "x",
  });
  assert(!/^bcc:/im.test(raw));
  assert(!raw.includes("hidden@example.com"));
  assertEquals(envelope.to, ["jane@example.com", "cc@example.com", "hidden@example.com"]);
});

Deno.test("envelope override", () => {
  const { envelope } = composeMessage({
    ...base,
    text: "x",
    envelope: { from: "bounces@example.com", to: ["other@example.com"] },
  });
  assertEquals(envelope, { from: "bounces@example.com", to: ["other@example.com"] });
});

Deno.test("body encoding: quoted-printable for mostly ASCII, base64 for mostly non-ASCII", () => {
  const latin = parse(composeMessage({ ...base, text: "Café crème, s'il vous plaît." }).raw);
  assertEquals(latin.headers.get("content-transfer-encoding"), "quoted-printable");
  assertEquals(text(latin), "Café crème, s'il vous plaît.\r\n");

  const cjk = parse(
    composeMessage({ ...base, text: "これは日本語のテキストです。".repeat(10) }).raw,
  );
  assertEquals(cjk.headers.get("content-transfer-encoding"), "base64");
  assertEquals(text(cjk), "これは日本語のテキストです。".repeat(10));
});

Deno.test("quoted-printable: long lines, trailing spaces, '=' and leading dots", () => {
  const body = "é " + "x".repeat(200) + " = end  \n.dot line\nFrom here\n";
  const part = parse(composeMessage({ ...base, text: body }).raw);
  assertEquals(part.headers.get("content-transfer-encoding"), "quoted-printable");
  for (const line of part.body.split("\r\n")) {
    assert(line.length <= 76);
    assert(!/[ \t]$/.test(line), "no trailing whitespace");
  }
  assert(!/^\./m.test(part.body) && !/^From /m.test(part.body));
  assertEquals(text(part), body.replace(/\n/g, "\r\n") + "\r\n");
});

Deno.test("very long ASCII lines are not sent as 7bit", () => {
  const part = parse(composeMessage({ ...base, html: "<p>" + "a".repeat(2000) + "</p>" }).raw);
  assertEquals(part.headers.get("content-transfer-encoding"), "quoted-printable");
  assert(part.body.split("\r\n").every((l) => l.length <= 76));
});

Deno.test("non-ASCII and long attachment filenames use RFC 2231", () => {
  const filename = "Übersicht_Квартальный_отчёт_" + "долгое_имя_".repeat(6) + ".pdf";
  const msg = parse(
    composeMessage({ ...base, text: "x", attachments: [{ filename, content: "a" }] }).raw,
  );
  const part = msg.parts[1]!;
  assertEquals(param(part.headers.get("content-disposition")!, "filename"), filename);
  assertEquals(param(part.headers.get("content-type")!, "name"), filename);
  for (const raw of part.rawHeaders) {
    for (const line of raw.split("\r\n")) assert(line.length <= 78, line);
  }
});

Deno.test("custom headers are added and folded", () => {
  const msg = parse(
    composeMessage({
      ...base,
      text: "x",
      headers: {
        "In-Reply-To": "<abc@example.com>",
        "X-Note": "Ärger",
        "List-Unsubscribe": "<https://example.com/unsubscribe?id=12345>",
      },
    }).raw,
  );
  assertEquals(msg.headers.get("in-reply-to"), "<abc@example.com>");
  assertEquals(decodeWords(msg.headers.get("x-note")!), "Ärger");
  assertEquals(msg.headers.get("list-unsubscribe"), "<https://example.com/unsubscribe?id=12345>");
});

Deno.test("custom Message-ID is accepted with or without brackets", () => {
  assertEquals(
    composeMessage({ ...base, text: "x", messageId: "id1@example.com" }).messageId,
    "<id1@example.com>",
  );
  assertEquals(
    composeMessage({ ...base, text: "x", messageId: "<id2@example.com>" }).messageId,
    "<id2@example.com>",
  );
});

Deno.test("header injection: CR or LF in any header input is rejected", () => {
  const evil = ["x\r\nBcc: victim@example.com", "x\nBcc: v@example.com", "x\rY", "x\0y"];
  for (const bad of evil) {
    const cases: Message[] = [
      { ...base, subject: bad },
      { ...base, from: { name: bad, address: "a@example.com" } },
      { ...base, to: bad },
      { ...base, to: { address: "a@example.com" + bad } },
      { ...base, replyTo: bad },
      { ...base, headers: { "X-Test": bad } },
      { ...base, headers: [[bad, "value"]] },
      { ...base, messageId: bad },
      { ...base, attachments: [{ filename: bad, content: "a" }] },
      {
        ...base,
        attachments: [{ filename: "a.txt", content: "a", contentType: "text/plain" + bad }],
      },
      { ...base, html: "<p>", attachments: [{ filename: "a.png", content: "a", contentId: bad }] },
      { ...base, envelope: { from: "a@example.com" + bad } },
    ];
    for (const message of cases) assertThrows(() => composeMessage(message), MessageError);
  }
});

Deno.test("invalid inputs are rejected", () => {
  assertThrows(() => composeMessage({ ...base, to: "not an address" }), MessageError);
  assertThrows(() => composeMessage({ ...base, to: "a<b>@example.com" }), MessageError);
  assertThrows(
    () => composeMessage({ ...base, to: "jöhn@example.com" }),
    MessageError,
    "non-ASCII",
  );
  assertThrows(() => composeMessage({ ...base, headers: { "Bad Name": "x" } }), MessageError);
  assertThrows(() => composeMessage({ ...base, headers: { "Content-Type": "x" } }), MessageError);
  assertThrows(() => composeMessage({ ...base, headers: { bcc: "x@example.com" } }), MessageError);
  assertThrows(() => composeMessage({ ...base, date: new Date("nope") }), MessageError);
});

Deno.test("an unlikely boundary collision is avoided", () => {
  const { raw } = composeMessage({
    ...base,
    text: "--=_sw_ looks like a boundary",
    html: "<p>x</p>",
  });
  const boundary = param(parse(raw).headers.get("content-type")!, "boundary")!;
  assertEquals(raw.split(`--${boundary}`).length, 4);
});
