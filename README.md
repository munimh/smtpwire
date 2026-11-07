# smtpwire

A small SMTP client and MIME message builder for Deno, Supabase Edge Functions and other runtimes
where Node mail libraries don't work well. It has no runtime dependencies.

- Implicit TLS (port 465), STARTTLS (port 587), and plain connections for local testing
- AUTH PLAIN, AUTH LOGIN and XOAUTH2 (you supply the access token)
- Text, HTML, `multipart/alternative`, attachments, and inline images by Content-ID
- RFC 2047 encoding and correct folding for non-ASCII subjects and display names
- Header injection protection: CR and LF are rejected in every header input
- A typed `SmtpError` that names the step that failed and says whether to retry
- Connect and per-command timeouts. `send()` always closes the connection.
- A swappable network layer, with connectors for Deno (the default) and for Node.js and Bun
- Debug logging is opt-in, and passwords and tokens are always masked

## Install

```sh
deno add jsr:@munimh/smtpwire
# Node.js / Bun
npx jsr add @munimh/smtpwire
bunx jsr add @munimh/smtpwire
```

## Quick start (Deno)

```ts
import { send } from "@munimh/smtpwire";

const result = await send(
  {
    host: "smtp.example.com",
    port: 465, // implicit TLS. Use 587 for STARTTLS.
    auth: { user: "app@example.com", pass: Deno.env.get("SMTP_PASS")! },
  },
  {
    from: { name: "Example App", address: "app@example.com" },
    to: "Jane Doe <jane@example.com>",
    subject: "Welcome aboard",
    text: "Thanks for signing up.",
    html: "<p>Thanks for signing up.</p>",
  },
);
console.log(result.messageId, result.response);
```

Run it with `deno run --allow-net --allow-env send.ts`.

## Quick start (Supabase Edge Functions)

Supabase blocks outgoing connections on ports 25 and 587, so use a provider that offers implicit TLS
on port 465 (see [Outbound SMTP ports by host](#outbound-smtp-ports-by-host)).

```ts
// supabase/functions/send-email/index.ts
import { send, SmtpError } from "jsr:@munimh/smtpwire@^0.1";

Deno.serve(async (req) => {
  const { to, subject, text } = await req.json();
  try {
    const result = await send(
      {
        host: Deno.env.get("SMTP_HOST")!,
        port: 465,
        auth: { user: Deno.env.get("SMTP_USER")!, pass: Deno.env.get("SMTP_PASS")! },
      },
      { from: "notifications@example.com", to, subject, text },
    );
    return Response.json({ messageId: result.messageId });
  } catch (err) {
    if (err instanceof SmtpError) {
      // 503 tells the caller to try again later. 502 means retrying won't help.
      const status = err.temporary ? 503 : 502;
      return Response.json({ error: err.message, stage: err.stage, kind: err.kind }, { status });
    }
    throw err;
  }
});
```

Set the secrets with `supabase secrets set SMTP_HOST=... SMTP_USER=... SMTP_PASS=...`. A complete
version is in [`examples/supabase`](examples/supabase/functions/send-email/index.ts).

## Node.js and Bun

The default connector uses `Deno.connect`. On Node.js or Bun, pass the connector from the `/node`
entry point:

```ts
import { send } from "@munimh/smtpwire";
import { nodeConnector } from "@munimh/smtpwire/node";

await send(
  { host: "smtp.example.com", connector: nodeConnector(), auth: { user: "app", pass: "secret" } },
  { from: "app@example.com", to: "jane@example.com", subject: "Hi", text: "Hello" },
);
```

## Many messages over one connection

```ts
import { SmtpClient } from "@munimh/smtpwire";

await using client = await SmtpClient.connect({
  host: "smtp.example.com",
  auth: { user: "app@example.com", pass: Deno.env.get("SMTP_PASS")! },
});
for (const to of ["ann@example.com", "bob@example.com"]) {
  await client.send({ from: "app@example.com", to, subject: "News", text: "Hello" });
}
// `await using` sends QUIT and closes the connection at the end of the block.
// You can also call `await client.close()` yourself.
```

If the server refuses one message (a 4xx or 5xx reply to `MAIL FROM`, `RCPT TO` or `DATA`), the
client sends `RSET` and the connection stays usable for the next message. Any other failure, such as
a timeout or a dropped connection, closes it. Check `client.closed` to see whether it's still open.
Calls made at the same time, for example with `Promise.all`, are queued and run one after another.

Repeated recipients are sent once. The domain is compared without regard to case, but the part
before the @ keeps its case, because some servers treat `John@` and `john@` as different mailboxes.

## Messages

```ts
import { composeMessage } from "@munimh/smtpwire";

const { raw, messageId, envelope } = composeMessage({
  from: { name: "Zoë from Example", address: "zoe@example.com" },
  to: ["ann@example.com", { name: "Bob Example", address: "bob@example.com" }],
  cc: "team@example.com",
  bcc: "archive@example.com", // envelope only, never written into a header
  replyTo: "support@example.com",
  subject: "Grüße – quarterly report",
  text: "Plain-text version",
  html: '<p>HTML version <img src="cid:logo@example.com"></p>',
  attachments: [
    { filename: "logo.png", content: pngBytes, contentId: "logo@example.com" }, // inline
    { filename: "Bericht.pdf", content: pdfBytes }, // type guessed from the extension
  ],
  headers: { "In-Reply-To": "<previous@example.com>" },
});
```

Every message gets `Date`, `Message-ID` (a random ID at the sender's domain unless you pass
`messageId`) and `MIME-Version`. The structure depends on what you provide:

| You provide                             | Structure                                |
| --------------------------------------- | ---------------------------------------- |
| `text` or `html`                        | a single part                            |
| `text` and `html`                       | `multipart/alternative`                  |
| `html` and attachments with `contentId` | `multipart/related` around the HTML      |
| attachments without `contentId`         | `multipart/mixed` around everything else |

Text bodies are sent as 7bit when they are plain ASCII with lines up to 998 characters. If fewer
than a third of the bytes need escaping they are sent as quoted-printable, which keeps mostly-Latin
text readable. Otherwise they are sent as base64. Attachments are always base64. The output is pure
7-bit ASCII with CRLF line breaks, so it works through any server.

Names and subjects can contain any Unicode text. They are encoded as RFC 2047 encoded-words (Q or B,
whichever is shorter) and folded at 78 characters without splitting a character. Non-ASCII
attachment file names use RFC 2231. Text that only looks like an encoded-word (`=?...?=`) is encoded
too, so mail clients show it as typed. Email addresses must be ASCII, because internationalised
addresses aren't supported.

To send a bounce or another automatic reply, set `envelope: { from: "" }`. This sends the null
sender, `MAIL FROM:<>`.

`send()` and `SmtpClient.send()` also accept a ready-made message as
`{ raw, envelope: { from, to } }`. A raw message may contain UTF-8. In the body this needs the
server to offer 8BITMIME, and in the headers it also needs SMTPUTF8. If the server doesn't offer
them, the send fails with a permanent `sender` error before anything is sent.

`composeMessage` throws a `MessageError` and nothing is sent if any of these are true:

- a header value, display name, address, file name or Content-ID contains CR, LF or NUL
- a header name is invalid
- a custom header tries to set something the library writes itself (`From`, `Bcc`, `Content-Type`
  and so on)

## Errors and retries

Every SMTP failure is an `SmtpError`:

| Property       | Meaning                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| `stage`        | `connect`, `tls`, `auth`, `sender`, `recipient` or `data`                          |
| `code`         | the SMTP reply code (for example `550`), or `undefined` if the server didn't reply |
| `enhancedCode` | the RFC 3463 code (for example `5.1.1`), when the server sent one                  |
| `response`     | the server's reply text                                                            |
| `recipient`    | the refused address, at the `recipient` stage                                      |
| `timeout`      | `true` if a time limit was hit                                                     |
| `kind`         | `permanent`, `temporary` or `unknown`                                              |

- **`permanent`** (`err.permanent`): a 5xx reply, or a configuration problem such as the server not
  offering STARTTLS. Retrying won't help.
- **`temporary`** (`err.temporary`): a 4xx reply, or a network failure or timeout before the message
  was handed over. Retry later.
- **`unknown`** (`err.deliveryUnknown`): the whole message was sent but the server's final reply
  never came. The server may have accepted it, so retrying could deliver it twice.

The `connect` stage covers the TCP connection, the greeting and EHLO. The `tls` stage covers the
implicit TLS handshake and STARTTLS.

Timeouts: `connectTimeout` (default 15 s) limits the TCP connection and the TLS handshake.
`commandTimeout` (default 30 s) limits each command's reply. `dataTimeout` (default 120 s) limits
the final reply after the message body, because servers often scan content at that point.

## Options

| Option                                            | Default                                                 | Notes                                                |
| ------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| `host`                                            | (required)                                              |                                                      |
| `port`                                            | 465 / 587 / 25 by `security`                            |                                                      |
| `security`                                        | `"tls"` for port 465 or no port, otherwise `"starttls"` | `"none"` is for local test servers only              |
| `auth`                                            | none                                                    | `{ user, pass, method? }` or `{ user, accessToken }` |
| `allowInsecureAuth`                               | `false`                                                 | allows credentials without TLS (local testing)       |
| `clientName`                                      | `"localhost"`                                           | the name sent with EHLO                              |
| `connectTimeout`, `commandTimeout`, `dataTimeout` | 15 s, 30 s, 120 s                                       |                                                      |
| `connector`                                       | `denoConnector()`                                       | the network layer                                    |
| `debug`                                           | off                                                     | `true` logs with `console.debug`, or pass a function |

With `security: "starttls"`, the server must offer STARTTLS. If it doesn't, the connection fails
rather than carrying on unencrypted. Credentials are never sent over an unencrypted connection
unless you set `allowInsecureAuth`. `auth.method` picks a mechanism. Otherwise PLAIN is used if the
server offers it, then LOGIN. Passing `accessToken` selects XOAUTH2. Credentials are only sent when
the server advertises AUTH and the chosen mechanism. Otherwise connecting fails with a permanent
`auth` error.

Set `clientName` to your sending host's name (a fully qualified domain name). Some servers penalise
or reject the default EHLO name, `localhost`.

## Custom network layers

The core only needs two operations:

```ts
interface Connector {
  connect(hostname: string, port: number): Promise<Connection>; // plain TCP
  startTls(connection: Connection, hostname: string): Promise<Connection>; // upgrade, verify cert
}
interface Connection {
  read(buffer: Uint8Array): Promise<number | null>;
  write(data: Uint8Array): Promise<number>;
  close(): void;
}
```

For implicit TLS, the client calls `connect` and then `startTls` straight away.
`denoConnector({ caCerts })` and `nodeConnector({ tls })` accept extra trusted CAs. This library
doesn't include a Cloudflare Workers connector, but one could be written on `connect()` from
`cloudflare:sockets` with `secureTransport: "starttls"` and `socket.startTls()`.

## Outbound SMTP ports by host

Many serverless platforms restrict outbound SMTP. This table was checked against each provider's
documentation on 6 November 2026. Platforms change these rules, so follow the links before you rely
on them.

| Host                    | 25                   | 465              | 587              |
| ----------------------- | -------------------- | ---------------- | ---------------- |
| Supabase Edge Functions | blocked              | not mentioned ¹  | blocked          |
| Deno Deploy             | not documented ²     | not documented ² | not documented ² |
| Cloudflare Workers      | blocked              | not mentioned    | not mentioned    |
| AWS Lambda              | blocked by default ³ | not mentioned    | not mentioned    |

- **Supabase Edge Functions.** The [limits page](https://supabase.com/docs/guides/functions/limits)
  says outgoing connections to ports 25 and 587 are not allowed. ¹ Port 465 isn't mentioned, and
  users report that implicit TLS on 465 works
  ([supabase/supabase#21977](https://github.com/supabase/supabase/issues/21977), not official
  documentation). Supabase's own email example uses an HTTPS API
  ([send emails](https://supabase.com/docs/guides/functions/examples/send-emails)).
- **Deno Deploy.** ² The current
  [pricing and limits page](https://docs.deno.com/deploy/pricing_and_limits/) states only one port
  rule: `Deno.connect` to port 443 isn't allowed and you must use TLS. It says nothing about SMTP
  ports, so test a deployment before relying on it.
  [Deno Deploy Classic](https://docs.deno.com/deploy/classic/) shut down on 20 July 2026.
- **Cloudflare Workers.** The
  [TCP sockets page](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) says
  Workers can't open outbound connections on port 25. It documents
  `secureTransport: "on" | "starttls"` and `startTls()`, and doesn't restrict 465 or 587. Workers
  aren't a Deno or Node runtime, so you'd need your own `Connector` (see above).
- **AWS Lambda.** ³ The
  [EC2 port 25 documentation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-resource-limits.html#port-25-throttle)
  and the [AWS knowledge-center article](https://repost.aws/knowledge-center/ec2-port-25-throttle)
  say port 25 to public addresses is blocked by default, for EC2 and for Lambda. AWS can remove the
  block on request, which for Lambda needs a VPC with a NAT gateway. Ports 465 and 587 aren't listed
  as restricted. A function attached to your own VPC also needs a
  [NAT gateway for internet access](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc-internet.html).

In short: port 465 with implicit TLS is the most portable choice, and an HTTPS email API is the
fallback where SMTP is blocked.

## Security

- Credentials are never logged. Debug output replaces AUTH lines with `<redacted>` and doesn't
  include message bodies. A client drops its copy of the credentials as soon as it has
  authenticated. Error messages contain only the server's replies.
- TLS certificates are always verified against `host`.
- Any data the server sends after its STARTTLS reply but before the handshake is rejected
  (protection against STARTTLS command injection).
- SMTP commands and envelope addresses are checked for line breaks and angle brackets.

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Development

```sh
deno task check        # fmt, lint, type-check, doc lint
deno task test         # unit tests with the in-process fake SMTP server
sh test/gen_test_cert.sh /tmp/certs   # optional: enables the real TLS tests
SMTPWIRE_TEST_CA=/tmp/certs/ca.pem SMTPWIRE_TEST_CERT=/tmp/certs/cert.pem \
  SMTPWIRE_TEST_KEY=/tmp/certs/key.pem deno task test
docker run -d -p 1025:1025 -p 8025:8025 -e MP_SMTP_AUTH_ACCEPT_ANY=1 \
  -e MP_SMTP_AUTH_ALLOW_INSECURE=1 axllent/mailpit:v1.33.0
deno task integration  # against Mailpit
```

## Licence

[MIT](LICENSE)
