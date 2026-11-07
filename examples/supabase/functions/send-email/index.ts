// A Supabase Edge Function that sends one email.
// Supabase blocks outbound ports 25 and 587, so this uses implicit TLS on port 465.
//
//   supabase secrets set SMTP_HOST=smtp.example.com SMTP_USER=app@example.com SMTP_PASS=...
//   supabase functions deploy send-email
//
// In your own project, import from "jsr:@munimh/smtpwire@^0.1" instead.
import { send, SmtpError } from "../../../../mod.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const { to, subject, text } = await req.json();
  try {
    const result = await send(
      {
        host: Deno.env.get("SMTP_HOST")!,
        port: 465,
        auth: { user: Deno.env.get("SMTP_USER")!, pass: Deno.env.get("SMTP_PASS")! },
        commandTimeout: 15_000,
      },
      { from: { name: "Example App", address: "notifications@example.com" }, to, subject, text },
    );
    return Response.json({ messageId: result.messageId });
  } catch (err) {
    if (err instanceof SmtpError) {
      return Response.json(
        { error: err.message, stage: err.stage, kind: err.kind, code: err.code },
        { status: err.temporary ? 503 : 502 },
      );
    }
    return Response.json({ error: String(err) }, { status: 400 });
  }
});
