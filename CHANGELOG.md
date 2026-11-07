# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

### Added

- `send()` for one message, and `SmtpClient` for several messages over one connection.
- Implicit TLS, STARTTLS (required, never optional) and plain connections.
- AUTH PLAIN, AUTH LOGIN and XOAUTH2.
- `SmtpError` with stage, reply code, enhanced status code and a permanent / temporary /
  unknown classification. Connect, command and data timeouts.
- `composeMessage()`: text, HTML, `multipart/alternative`, attachments, inline images,
  RFC 2047 headers with folding, RFC 2231 file names, Reply-To, custom headers, and
  header-injection checks.
- `denoConnector()` (default) and `nodeConnector()` for Node.js and Bun.
- Concurrent calls on one `SmtpClient` are queued so commands never interleave.
- `send()` accepts raw messages. UTF-8 in raw messages is sent with `BODY=8BITMIME` and,
  for headers, `SMTPUTF8`, and is refused locally when the server doesn't offer them.
- The null envelope sender (`envelope: { from: "" }`, sent as `MAIL FROM:<>`) for bounces.
- Text that only looks like an RFC 2047 encoded-word is encoded rather than passed through.
- Credentials are never sent to a server that doesn't advertise AUTH.
