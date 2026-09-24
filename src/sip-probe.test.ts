import { createHash } from "crypto";
import { describe, expect, test } from "bun:test";
import { digestAuthorization, parseChallenge, parseReply, probeOptions } from "./sip-probe";

const md5 = (v: string) => createHash("md5").update(v).digest("hex");

function reply(request: string, status: string, extra: string[] = []): string {
  const headers = request.split("\r\n").filter((l) => /^(Via|From|To|Call-ID|CSeq):/i.test(l));
  return [`SIP/2.0 ${status}`, ...headers, ...extra, "Content-Length: 0", "", ""].join("\r\n");
}

async function fakeCarrier(handler: (request: string) => string | null) {
  return Bun.udpSocket({
    socket: {
      data(socket, buf, port, address) {
        const answer = handler(Buffer.from(buf).toString());
        if (answer) socket.send(answer, port, address);
      },
    },
  });
}

describe("sip probe", () => {
  test("a carrier answering 200 is reachable", async () => {
    const carrier = await fakeCarrier((req) => reply(req, "200 OK"));
    const result = await probeOptions({ host: "127.0.0.1", port: carrier.port, fromHost: "203.0.113.233" });
    expect(result).toMatchObject({ ok: true, status: 200, authenticated: false, address: "127.0.0.1" });
    carrier.close();
  });

  test("digest credentials are answered correctly and wrong ones are reported", async () => {
    const nonce = "abc123";
    const carrier = await fakeCarrier((req) => {
      const auth = /Authorization: (Digest .*)/i.exec(req)?.[1];
      if (!auth) return reply(req, "401 Unauthorized", [`WWW-Authenticate: Digest realm="carrier", nonce="${nonce}", qop="auth"`]);
      const c = parseChallenge(auth);
      const expected = md5(`${md5(`acme:carrier:right-pass`)}:${nonce}:${c.nc}:${c.cnonce}:auth:${md5(`OPTIONS:${c.uri}`)}`);
      return c.response === expected ? reply(req, "200 OK") : reply(req, "403 Forbidden");
    });
    const good = await probeOptions({ host: "127.0.0.1", port: carrier.port, user: "acme", pass: "right-pass", fromHost: "1.2.3.4" });
    expect(good).toMatchObject({ ok: true, authenticated: true });
    const bad = await probeOptions({ host: "127.0.0.1", port: carrier.port, user: "acme", pass: "wrong", fromHost: "1.2.3.4" });
    expect(bad).toMatchObject({ ok: false, stage: "rejected", status: 403 });
    carrier.close();
  });

  test("silence is a timeout and an unknown host is a dns failure", async () => {
    const carrier = await fakeCarrier(() => null);
    expect(await probeOptions({ host: "127.0.0.1", port: carrier.port, fromHost: "1.2.3.4" }, 200)).toMatchObject({ ok: false, stage: "timeout" });
    carrier.close();
    expect(await probeOptions({ host: "no-such-host.invalid", port: 5060, fromHost: "1.2.3.4" }, 200)).toMatchObject({ ok: false, stage: "dns" });
  });

  test("the digest without qop follows RFC 2069", () => {
    const value = digestAuthorization({ challenge: { realm: "r", nonce: "n" }, user: "u", pass: "p", method: "OPTIONS", uri: "sip:h:5060" });
    expect(value).toContain(`response="${md5(`${md5("u:r:p")}:n:${md5("OPTIONS:sip:h:5060")}`)}"`);
    expect(parseReply("SIP/2.0 407 Proxy Auth\r\nProxy-Authenticate: Digest x=1\r\n\r\n")?.status).toBe(407);
    expect(parseReply("garbage")).toBeNull();
  });
});

describe("sip probe retransmissions", () => {
  test("a late retransmission of the 401 is not taken for the answer to the authenticated request", async () => {
    const carrier = await fakeCarrier((req) => {
      const cseq = /CSeq: (\d+)/.exec(req)?.[1];
      const challenge = reply(req.replace(/CSeq: \d+/, "CSeq: 1"), "401 Unauthorized", ['WWW-Authenticate: Digest realm="r", nonce="n"']);
      return cseq === "1" || cseq === "2" ? challenge : null;
    });
    const result = await probeOptions({ host: "127.0.0.1", port: carrier.port, user: "u", pass: "p", fromHost: "1.2.3.4" }, 300);
    expect(result).toMatchObject({ ok: false, stage: "timeout" });
    carrier.close();
  });
});
