# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository ("Security" tab, then "Report a vulnerability"). Do not open a public issue. You
should get a reply within a week.

## Supported versions

Only the latest released version receives security fixes.

## What this library does to protect you

- Credentials and access tokens are never logged. Debug output masks every AUTH line, and a client
  forgets credentials once it has authenticated.
- TLS certificates are verified. STARTTLS is never optional: if the server doesn't offer it the
  connection fails. Credentials aren't sent over a plain connection unless `allowInsecureAuth` is
  set.
- Data received between the STARTTLS reply and the TLS handshake is rejected.
- Header values, names, addresses, file names and Content-IDs containing CR, LF or NUL are rejected,
  as are SMTP commands containing line breaks.

## Out of scope

The library doesn't sign messages (DKIM), doesn't obtain OAuth tokens, and can't stop a server
you've configured from reading your mail.
