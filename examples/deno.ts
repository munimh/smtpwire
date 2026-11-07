// Run with: deno run --allow-net --allow-env examples/deno.ts
// Needs SMTP_HOST, SMTP_USER and SMTP_PASS in the environment.
import { send, SmtpError } from "../mod.ts";

try {
  const result = await send(
    {
      host: Deno.env.get("SMTP_HOST") ?? "smtp.example.com",
      port: 465,
      auth: { user: Deno.env.get("SMTP_USER") ?? "", pass: Deno.env.get("SMTP_PASS") ?? "" },
    },
    {
      from: { name: "Example App", address: "app@example.com" },
      to: "Jane Doe <jane@example.com>",
      subject: "Hello from smtpwire",
      text: "This is the plain-text version.",
      html: "<p>This is the <b>HTML</b> version.</p>",
      attachments: [{ filename: "hello.txt", content: "Hello!" }],
    },
  );
  console.log("Sent", result.messageId, result.response);
} catch (err) {
  if (err instanceof SmtpError) {
    console.error(`Failed at ${err.stage} (${err.kind}):`, err.message);
    Deno.exit(err.temporary ? 75 : 1);
  }
  throw err;
}
