import { describe, expect, test } from "bun:test";
import { encryptPhone } from "./fpe";
import { internalFetch } from "./internal";
import { keys, setClientPrefix } from "./keys";
import { changeTrunkKey, saveManagedTelephony, setCarrier } from "./telephony";

const call = (path: string, key: string | null = keys.decryptKey()) =>
  internalFetch(new Request(`http://cabinet:3501${path}`, { headers: key === null ? {} : { "x-decrypt-key": key } }));

describe("internal listener", () => {
  test("both routes refuse a missing or wrong key", async () => {
    expect(call("/config/kamailio", null).status).toBe(401);
    expect(call("/config/kamailio", "wrong").status).toBe(401);
    expect(call(`/detokenize?t=1`, "wrong").status).toBe(401);
    expect(call("/anything").status).toBe(404);
  });

  test("detokenize strips the client prefix and returns the real number", async () => {
    setClientPrefix("123000");
    const token = encryptPhone("+491512345678");
    const res = call(`/detokenize?t=${encodeURIComponent("+123000" + token.slice(1))}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ phone: "+491512345678" });
    expect((await call(`/detokenize?t=${token.slice(1)}`).json()) as unknown).toEqual({ phone: "+491512345678" });
  });

  test("the SIP config carries the enabled modes with their keys", async () => {
    const mode = setCarrier("direct", { host: "10.9.9.9" });
    const body = (await call("/config/kamailio").json()) as { modes: Record<string, { key: string; host: string }> };
    expect(body.modes.direct).toMatchObject({ key: mode.routes[0].key, host: "10.9.9.9", routes: ["default"] });
  });

  test("trunk-key names the mode of a current or previous key and refuses everything else", async () => {
    const lookup = (trunkKey: string | null, decrypt: string | null = keys.decryptKey()) =>
      internalFetch(
        new Request("http://cabinet:3501/trunk-key", {
          headers: { ...(decrypt === null ? {} : { "x-decrypt-key": decrypt }), ...(trunkKey === null ? {} : { "x-trunk-key": trunkKey }) },
        }),
      );
    setCarrier("ipauth", { host: "198.51.100.77" }, "wr_0000test0000key0000test0000key");
    expect(await (await lookup("wr_0000test0000key0000test0000key")).json()).toEqual({ mode: "ipauth", route: "default", prefix: "" });
    changeTrunkKey("ipauth", "the_next_trunk_key_0123456789");
    expect((await lookup("the_next_trunk_key_0123456789")).status).toBe(200);
    expect((await lookup("wr_0000test0000key0000test0000key")).status).toBe(200);
    expect((await lookup("guess_guess_guess_guess")).status).toBe(404);
    expect((await lookup(null)).status).toBe(404);
    expect((await lookup("the_next_trunk_key_0123456789", "wrong")).status).toBe(401);
  });

  test("trunk-key refuses a source outside the allow list set in Platform, even with a valid key", async () => {
    setCarrier("ipauth", { host: "198.51.100.77" }, "wr_0000test0000key0000test0000key");
    const ask = (ip: string) =>
      internalFetch(
        new Request("http://cabinet:3501/trunk-key", {
          headers: { "x-decrypt-key": keys.decryptKey(), "x-trunk-key": "wr_0000test0000key0000test0000key", "x-source-ip": ip },
        }),
      ).status;
    saveManagedTelephony({});
    expect(ask("203.0.113.9")).toBe(200);
    saveManagedTelephony({ allowedSources: ["192.0.2.0/24"] });
    expect(ask("192.0.2.17")).toBe(200);
    expect(ask("203.0.113.9")).toBe(403);
    saveManagedTelephony({});
  });
});
