// A deliberately independent, minimal MIME reader used only to check the builder's output.

export interface ParsedPart {
  headers: Map<string, string>; // lower-case name -> unfolded value (first occurrence)
  rawHeaders: string[]; // folded header blocks as sent
  body: string;
  parts: ParsedPart[];
}

const decoder = new TextDecoder();

function bytesFromBinary(binary: string): Uint8Array {
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function decodeQp(text: string): string {
  const binary = text
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // Non-escaped characters are ASCII, so binary -> bytes is safe.
  return decoder.decode(bytesFromBinary(binary));
}

export function decodeB64(text: string): Uint8Array {
  return bytesFromBinary(atob(text.replace(/\s+/g, "")));
}

/** Decodes RFC 2047 encoded-words in an unfolded header value. */
export function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi, (_, enc: string, data: string) => {
      if (enc.toUpperCase() === "B") return decoder.decode(decodeB64(data));
      return decodeQp(data.replace(/_/g, " "));
    });
}

/** Decodes an RFC 2231 parameter (single or continued). */
export function param(header: string, name: string): string | undefined {
  const plain = new RegExp(`;\\s*${name}=("((?:[^"\\\\]|\\\\.)*)"|[^;\\s]+)`, "i").exec(header);
  if (plain) return plain[2] !== undefined ? plain[2].replace(/\\(.)/g, "$1") : plain[1];
  const pieces: string[] = [];
  const single = new RegExp(`;\\s*${name}\\*=([^;\\s]+)`, "i").exec(header);
  if (single) pieces.push(single[1]!);
  else {
    for (let i = 0;; i++) {
      const m = new RegExp(`;\\s*${name}\\*${i}\\*=([^;\\s]+)`, "i").exec(header);
      if (!m) break;
      pieces.push(m[1]!);
    }
  }
  if (!pieces.length) return undefined;
  const joined = pieces.join("").replace(/^UTF-8''/i, "");
  return decoder.decode(
    bytesFromBinary(
      joined.replace(/%([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))),
    ),
  );
}

export function parse(raw: string): ParsedPart {
  const split = raw.indexOf("\r\n\r\n");
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? "" : raw.slice(split + 4);
  const rawHeaders: string[] = [];
  for (const line of head.split("\r\n")) {
    if (/^[ \t]/.test(line) && rawHeaders.length) {
      rawHeaders[rawHeaders.length - 1] += "\r\n" + line;
    } else rawHeaders.push(line);
  }
  const headers = new Map<string, string>();
  for (const h of rawHeaders) {
    const colon = h.indexOf(":");
    const name = h.slice(0, colon).toLowerCase();
    if (!headers.has(name)) headers.set(name, h.slice(colon + 1).replace(/\r\n/g, "").trim());
  }
  const type = headers.get("content-type") ?? "text/plain";
  const parts: ParsedPart[] = [];
  if (/^multipart\//i.test(type)) {
    const boundary = param(type, "boundary")!;
    const sections = body.split(`--${boundary}`);
    for (const section of sections.slice(1)) {
      if (section.startsWith("--")) break;
      parts.push(parse(section.replace(/^\r\n/, "").replace(/\r\n$/, "")));
    }
  }
  return { headers, rawHeaders, body, parts };
}

/** The decoded text of a leaf part. */
export function text(part: ParsedPart): string {
  const cte = (part.headers.get("content-transfer-encoding") ?? "7bit").toLowerCase();
  if (cte === "base64") return decoder.decode(decodeB64(part.body));
  if (cte === "quoted-printable") return decodeQp(part.body);
  return part.body;
}
