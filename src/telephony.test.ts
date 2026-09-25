import { beforeEach, describe, expect, test } from "bun:test";
import { deleteSetting } from "./db";
import {
  addRoute,
  changeTrunkKey,
  disableMode,
  getDomain,
  enabledModes,
  finishRotation,
  getTelephony,
  importLegacyTelephony,
  kamailioConfig,
  rotateKey,
  saveBundleConfig,
  setCarrier,
  setDomain,
  setPublicIp,
  removeRoute,
  setRoutePrefix,
  trunkKeyLookup,
  trunkKeyMode,
  trunkKeysForCore,
} from "./telephony";

beforeEach(() => {
  for (const key of ["telephony", "public_ip", "bundle_config", "cabinet_domain"]) deleteSetting(key);
});

const SERVER_ENV = {
  MY_PUBLIC_IP: "203.0.113.233",
  TRUNK_IPAUTH_API_KEY: "TESTKEY0123456789ab",
  TRUNK_IPAUTH_HOST: "198.51.100.77",
  TRUNK_IPAUTH_PORT: "5060",
  TRUNK_IPAUTH_PREFIX: "555#",
  TRUNK_DIGEST_API_KEY: "placeholder",
  TRUNK_DIGEST_HOST: "",
  TRUNK_DIRECT_API_KEY: "placeholder",
  TRUNK_DIRECT_HOST: "127.0.0.1",
};

describe("telephony", () => {
  test("a 0.3.1 env brings over the live mode with its key so the existing trunk keeps working", () => {
    expect(importLegacyTelephony(SERVER_ENV)).toEqual(["ipauth"]);
    const state = getTelephony();
    expect(state.modes.ipauth).toEqual({ host: "198.51.100.77", port: 5060, routes: [{ id: "default", prefix: "555#", key: "TESTKEY0123456789ab" }] });
    expect(state.modes.digest).toBeUndefined();
    expect(state.modes.direct).toBeUndefined();
    expect(kamailioConfig().publicIp).toBe("203.0.113.233");
  });

  test("the import runs once; later env edits do not overwrite what the cabinet holds", () => {
    importLegacyTelephony(SERVER_ENV);
    setCarrier("ipauth", { host: "10.0.0.9", port: 5070, prefix: "" });
    expect(importLegacyTelephony(SERVER_ENV)).toEqual([]);
    expect(getTelephony().modes.ipauth?.host).toBe("10.0.0.9");
    expect(getTelephony().modes.ipauth?.routes[0].key).toBe("TESTKEY0123456789ab");
  });

  test("placeholder keys and placeholder hosts are never imported as live modes", () => {
    expect(importLegacyTelephony({ TRUNK_IPAUTH_API_KEY: "placeholder", TRUNK_IPAUTH_HOST: "1.2.3.4", TRUNK_DIRECT_API_KEY: "a-real-key-1234567890", TRUNK_DIRECT_HOST: "127.0.0.1" })).toEqual([]);
    expect(enabledModes()).toEqual([]);
  });

  test("a new mode gets its own generated key and editing it keeps the key", () => {
    const first = setCarrier("digest", { host: "sip.carrier.example", user: "acme", pass: "s3cret!" });
    expect(first.routes[0].key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(first.port).toBe(5060);
    const again = setCarrier("digest", { host: "sip2.carrier.example", port: 5080, user: "acme", pass: "s3cret!" });
    expect(again.routes[0].key).toBe(first.routes[0].key);
    const other = setCarrier("direct", { host: "10.1.1.1" });
    expect(other.routes[0].key).not.toBe(first.routes[0].key);
    expect(Object.keys(trunkKeysForCore()).sort()).toEqual(["digest", "direct"]);
  });

  test("unsafe carrier values are refused before they can reach the SIP config", () => {
    expect(() => setCarrier("digest", { host: "sip.example", user: "a b", pass: "x" })).toThrow();
    expect(() => setCarrier("digest", { host: "sip.example", user: "ab", pass: "has space" })).toThrow();
    expect(() => setCarrier("ipauth", { host: "sip.example;evil", prefix: "" })).toThrow();
    expect(() => setCarrier("ipauth", { host: "sip.example", prefix: "12a" })).toThrow();
    expect(() => setCarrier("direct", { host: "sip.example", extra: 1 })).toThrow();
    expect(enabledModes()).toEqual([]);
  });

  test("rotation keeps the old key accepted until it is finished", () => {
    const original = setCarrier("direct", { host: "10.1.1.1" }).routes[0].key;
    const rotated = rotateKey("direct");
    expect(rotated.prevKey).toBe(original);
    expect(rotated.key).not.toBe(original);
    expect(() => rotateKey("direct")).toThrow(/already rotating/);
    expect(trunkKeyMode(original)).toBe("direct");
    expect(trunkKeysForCore().direct).toBe(rotated.key);
    expect(finishRotation("direct")).toBe(true);
    expect(trunkKeyMode(original)).toBeNull();
    expect(trunkKeyMode(rotated.key)).toBe("direct");
    expect(finishRotation("direct")).toBe(false);
  });

  test("a disabled mode disappears from the SIP config and from what Platform gets", () => {
    setCarrier("direct", { host: "10.1.1.1" });
    expect(disableMode("direct")).toBe(true);
    expect(kamailioConfig().modes).toEqual({});
    expect(trunkKeysForCore()).toEqual({});
  });

  test("the registry token is never stored with the bundle config", () => {
    const kept = saveBundleConfig({ bundle: { version: "0.4.0" }, registry: { host: "ghcr.io", user: "u", token: "t" } });
    expect(kept).not.toHaveProperty("registry");
    expect(kamailioConfig()).not.toHaveProperty("trustedSubnets");
  });

  test("the public ip must be an IPv4 address", () => {
    expect(() => setPublicIp("example.com")).toThrow();
    expect(() => setPublicIp("300.1.1.1")).toThrow();
    setPublicIp("203.0.113.9");
    expect(kamailioConfig().publicIp).toBe("203.0.113.9");
  });

  test("the cabinet domain is a lowercase hostname and can be cleared", () => {
    expect(getDomain()).toBeNull();
    expect(() => setDomain("203.0.113.9")).toThrow();
    expect(() => setDomain("localhost")).toThrow();
    expect(() => setDomain("https://cabinet.example.com")).toThrow();
    expect(() => setDomain("bad_host.example.com")).toThrow();
    setDomain(" Cabinet.Example.COM ");
    expect(getDomain()).toBe("cabinet.example.com");
    setDomain(null);
    expect(getDomain()).toBeNull();
  });

  test("a trunk key is changed to a given or generated one, and both keys are accepted until the change finishes", () => {
    setCarrier("ipauth", { host: "198.51.100.77" }, "wr_0000test0000key0000test0000key");
    setCarrier("direct", { host: "sbc.example" });
    expect(trunkKeyMode("wr_0000test0000key0000test0000key")).toBe("ipauth");
    expect(trunkKeyMode(getTelephony().modes.direct!.routes[0].key)).toBe("direct");
    expect(trunkKeyMode("nope")).toBeNull();
    expect(trunkKeyMode("")).toBeNull();

    const own = changeTrunkKey("ipauth", "my_own_trunk_key_0123456789");
    expect(own).toEqual({ key: "my_own_trunk_key_0123456789", prevKey: "wr_0000test0000key0000test0000key" });
    expect(trunkKeyMode("my_own_trunk_key_0123456789")).toBe("ipauth");
    expect(trunkKeyMode("wr_0000test0000key0000test0000key")).toBe("ipauth");

    const again = changeTrunkKey("ipauth");
    expect(again.prevKey).toBe("wr_0000test0000key0000test0000key");
    expect(again.key).not.toBe("my_own_trunk_key_0123456789");
    expect(trunkKeyMode("my_own_trunk_key_0123456789")).toBeNull();

    expect(finishRotation("ipauth")).toBe(true);
    expect(trunkKeyMode("wr_0000test0000key0000test0000key")).toBeNull();
    expect(trunkKeyMode(again.key)).toBe("ipauth");

    expect(() => changeTrunkKey("ipauth", "short")).toThrow();
    expect(() => changeTrunkKey("digest")).toThrow(/not enabled/);
    expect(changeTrunkKey("ipauth", again.key)).toEqual({ key: again.key, prevKey: null });
  });

  test("a mode can hold several routes to the same carrier, each with its own prefix and key", () => {
    setCarrier("ipauth", { host: "198.51.100.77", prefix: "" }, "wr_0000test0000key0000test0000key");
    const tdm = addRoute("ipauth", "TDM", "04242");
    expect(tdm).toMatchObject({ id: "tdm", prefix: "04242" });
    expect(trunkKeysForCore()).toEqual({ ipauth: "wr_0000test0000key0000test0000key", "ipauth.tdm": tdm.key });
    expect(trunkKeyLookup(tdm.key)).toEqual({ mode: "ipauth", route: "tdm", prefix: "04242" });
    expect(trunkKeyLookup("wr_0000test0000key0000test0000key")).toEqual({ mode: "ipauth", route: "default", prefix: "" });

    expect(() => addRoute("ipauth", "tdm")).toThrow(/already/);
    expect(() => addRoute("ipauth", "bad route")).toThrow();
    expect(() => addRoute("ipauth", "x", "02a")).toThrow();
    expect(() => addRoute("digest", "x")).toThrow(/not enabled/);

    setRoutePrefix("ipauth", "tdm", "02184");
    expect(trunkKeyLookup(tdm.key)?.prefix).toBe("02184");
    setCarrier("ipauth", { host: "198.51.100.78" });
    expect(trunkKeyLookup(tdm.key)?.prefix).toBe("02184");

    const other = changeTrunkKey("ipauth", "a_route_key_for_tdm_0123", "tdm");
    expect(other.prevKey).toBe(tdm.key);
    expect(() => changeTrunkKey("ipauth", "wr_0000test0000key0000test0000key", "tdm")).toThrow(/already belongs to ipauth/);
    expect(() => changeTrunkKey("ipauth", "a_route_key_for_tdm_0123")).toThrow(/already belongs to ipauth.tdm/);

    expect(() => removeRoute("ipauth", "default")).toThrow(/default route/);
    expect(removeRoute("ipauth", "tdm")).toBe(true);
    expect(trunkKeyLookup("a_route_key_for_tdm_0123")).toBeNull();
    expect(Object.keys(trunkKeysForCore())).toEqual(["ipauth"]);
    expect(kamailioConfig().modes.ipauth).toMatchObject({ host: "198.51.100.78", key: "wr_0000test0000key0000test0000key", prefix: "", routes: ["default"] });
  });

  test("routes come back from an exported env", () => {
    importLegacyTelephony({
      TRUNK_IPAUTH_API_KEY: "wr_0000test0000key0000test0000key",
      TRUNK_IPAUTH_HOST: "198.51.100.77",
      TRUNK_IPAUTH_ROUTE_TDM_FR_KEY: "a_route_key_for_tdm_0123",
      TRUNK_IPAUTH_ROUTE_TDM_FR_PREFIX: "04242",
    });
    expect(trunkKeyLookup("a_route_key_for_tdm_0123")).toEqual({ mode: "ipauth", route: "tdm-fr", prefix: "04242" });
    expect(getTelephony().modes.ipauth?.routes.every((r) => !r.prevKey)).toBe(true);
  });
});
