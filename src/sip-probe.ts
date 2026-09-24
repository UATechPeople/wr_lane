import { createHash, randomBytes } from "crypto";
import { lookup } from "dns/promises";

export type ProbeTarget = { host: string; port: number; user?: string; pass?: string; fromHost: string };

export type ProbeResult =
  | { ok: true; status: number; reason: string; ms: number; authenticated: boolean; address: string }
  | { ok: false; stage: "dns" | "timeout" | "rejected"; status?: number; reason: string; address?: string };

const md5 = (value: string) => createHash("md5").update(value).digest("hex");
const token = (bytes = 8) => randomBytes(bytes).toString("hex");

export function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = header.replace(/^\s*Digest\s+/i, "");
  for (const match of body.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)) {
    out[match[1].toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return out;
}

export function digestAuthorization(input: {
  challenge: Record<string, string>;
  user: string;
  pass: string;
  method: string;
  uri: string;
  cnonce?: string;
}): string {
  const { challenge, user, pass, method, uri } = input;
  const realm = challenge.realm ?? "";
  const nonce = challenge.nonce ?? "";
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = (challenge.qop ?? "").split(",").map((q) => q.trim()).includes("auth") ? "auth" : null;
  const parts = [`username="${user}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`, `algorithm=MD5`];
  if (qop) {
    const cnonce = input.cnonce ?? token();
    const nc = "00000001";
    parts.push(`response="${md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)}"`, `qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  } else {
    parts.push(`response="${md5(`${ha1}:${nonce}:${ha2}`)}"`);
  }
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

type Reply = { status: number; reason: string; headers: Map<string, string> };

export function parseReply(text: string): Reply | null {
  const [head] = text.split("\r\n\r\n");
  const lines = head.split("\r\n");
  const m = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/.exec(lines[0] ?? "");
  if (!m) return null;
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  return { status: Number(m[1]), reason: m[2], headers };
}

function optionsRequest(input: { target: string; address: string; port: number; localPort: number; fromHost: string; callId: string; tag: string; cseq: number; auth?: { header: string; value: string } }): string {
  const uri = `sip:${input.target}:${input.port}`;
  const lines = [
    `OPTIONS ${uri} SIP/2.0`,
    `Via: SIP/2.0/UDP ${input.fromHost}:${input.localPort};branch=z9hG4bK${token()};rport`,
    "Max-Forwards: 70",
    `From: <sip:probe@${input.fromHost}>;tag=${input.tag}`,
    `To: <${uri}>`,
    `Call-ID: ${input.callId}@${input.fromHost}`,
    `CSeq: ${input.cseq} OPTIONS`,
    `Contact: <sip:probe@${input.fromHost}:${input.localPort}>`,
    "Accept: application/sdp",
    "User-Agent: hn-cabinet-probe",
  ];
  if (input.auth) lines.push(`${input.auth.header}: ${input.auth.value}`);
  lines.push("Content-Length: 0", "", "");
  return lines.join("\r\n");
}

export async function probeOptions(target: ProbeTarget, timeoutMs = 3000): Promise<ProbeResult> {
  let address: string;
  try {
    address = (await lookup(target.host, { family: 4 })).address;
  } catch (e) {
    return { ok: false, stage: "dns", reason: `cannot resolve ${target.host}: ${(e as Error).message}` };
  }

  const replies: Reply[] = [];
  let wake: (() => void) | null = null;
  let expectedCseq = 1;
  const socket = await Bun.udpSocket({
    socket: {
      data(_s, buf) {
        const reply = parseReply(Buffer.from(buf).toString("utf8"));
        const cseq = Number.parseInt(reply?.headers.get("cseq") ?? "", 10);
        if (reply && reply.status >= 200 && cseq === expectedCseq) {
          replies.push(reply);
          wake?.();
        }
      },
    },
  });

  const next = async (): Promise<Reply | null> => {
    if (replies.length > 0) return replies.shift()!;
    const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const arrival = new Promise<Reply>((resolve) => {
      wake = () => resolve(replies.shift()!);
    });
    const result = await Promise.race([arrival, timer]);
    wake = null;
    return result;
  };

  const callId = token(12);
  const tag = token();
  const base = { target: target.host, address, port: target.port, localPort: socket.port, fromHost: target.fromHost, callId, tag };
  const started = Date.now();
  try {
    socket.send(optionsRequest({ ...base, cseq: 1 }), target.port, address);
    let reply = await next();
    if (!reply) return { ok: false, stage: "timeout", reason: `no answer from ${address}:${target.port} in ${timeoutMs} ms`, address };
    let authenticated = false;
    if ((reply.status === 401 || reply.status === 407) && target.user && target.pass) {
      const challengeHeader = reply.status === 401 ? "www-authenticate" : "proxy-authenticate";
      const challenge = parseChallenge(reply.headers.get(challengeHeader) ?? "");
      const value = digestAuthorization({ challenge, user: target.user, pass: target.pass, method: "OPTIONS", uri: `sip:${target.host}:${target.port}` });
      expectedCseq = 2;
      replies.length = 0;
      socket.send(optionsRequest({ ...base, cseq: 2, auth: { header: reply.status === 401 ? "Authorization" : "Proxy-Authorization", value } }), target.port, address);
      reply = await next();
      if (!reply) return { ok: false, stage: "timeout", reason: `no answer to the authenticated OPTIONS from ${address}:${target.port}`, address };
      authenticated = true;
    }
    if (reply.status >= 200 && reply.status < 300) {
      return { ok: true, status: reply.status, reason: reply.reason, ms: Date.now() - started, authenticated, address };
    }
    return { ok: false, stage: "rejected", status: reply.status, reason: `${reply.status} ${reply.reason}`, address };
  } finally {
    socket.close();
  }
}
