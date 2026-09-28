import { createHash } from "crypto";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { deleteSetting } from "./db";
import { keys } from "./keys";
import { parseEnvLines, rtpenginePing, run } from "./cli";
import { saveWrConfig, DEFAULT_WR_FIELDS } from "./webhook";
import { drainPushQueue } from "./winriders";

const received: Array<{ method: string; path: string; body: any }> = [];
let registerReply: { status: number; body: unknown } = { status: 200, body: { registered: true, status: "active", ok: true, trunks: {} } };
let trunksReplyStatus = 200;
let syncedKeys: Record<string, string> = {};
let agentsOn: Record<string, number> = {};
let managedTelephony: unknown = undefined;

const core = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => null) : null;
    received.push({ method: req.method, path: url.pathname + url.search, body });
    if (url.pathname.endsWith("/bundle/config") && url.searchParams.get("format") === "env") {
      return new Response("HN_SLUG=acme\nHN_VERSION=0.4.0\nHN_REGISTRY_TOKEN=ghp_x\n", { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname.endsWith("/bundle/config")) {
      return Response.json({ slug: "acme", config: { clientPrefix: "771000", registry: { token: "ghp_secret" }, ...(managedTelephony ? { telephony: managedTelephony } : {}) } });
    }
    if (url.pathname.endsWith("/bundle/register")) return Response.json(registerReply.body, { status: registerReply.status });
    if (url.pathname.endsWith("/bundle/trunks")) {
      if (trunksReplyStatus !== 200) return Response.json({ error: { message: "Telephony is not configured in WinRiders yet" } }, { status: trunksReplyStatus });
      syncedKeys = { ...(body?.trunks ?? {}) };
      return Response.json({ ok: true, trunks: Object.fromEntries(Object.keys(syncedKeys).map((name) => [name, { status: "created" }])) });
    }
    if (url.pathname.endsWith("/bundle/telephony")) {
      const trunks: Record<string, unknown> = { direct: { phoneNumberId: "p1", keyHash: "0000000000000000", voiceServices: 1 } };
      for (const [mode, key] of Object.entries(syncedKeys)) {
        trunks[mode] = { phoneNumberId: `p-${mode}`, keyHash: createHash("sha256").update(key).digest("hex").slice(0, 16), voiceServices: 1, voiceServicesWithAgent: agentsOn[mode] ?? 0 };
      }
      return Response.json({ installation: { status: "active" }, trunks });
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => core.stop(true));

beforeEach(() => {
  received.length = 0;
  registerReply = { status: 200, body: { registered: true, status: "active", ok: true, trunks: {} } };
  trunksReplyStatus = 200;
  syncedKeys = {};
  agentsOn = {};
  managedTelephony = undefined;
  for (const key of ["telephony", "public_ip", "bundle_config", "core_installation", "cabinet_domain"]) deleteSetting(key);
});


describe("cli", () => {
  test("env files from 0.3.1 are read with comments, export and quotes", () => {
    expect(parseEnvLines("# keys\nexport FF3_KEY=AB\nCABINET_PASSWORD='p=q'\nEMPTY=\nbroken line\n")).toEqual({ FF3_KEY: "AB", CABINET_PASSWORD: "p=q", EMPTY: "" });
  });

  test("import brings the old keys and modes in and checks them against the base", async () => {
    const env = `FF3_KEY=${keys.ff3Key}\nFF3_TWEAK=${keys.ff3Tweak}\nTRUNK_IPAUTH_API_KEY=TESTKEY0123456789ab\nTRUNK_IPAUTH_HOST=5.129.228.77\nTRUNK_IPAUTH_PREFIX=771#\nMY_PUBLIC_IP=157.245.75.233\n`;
    const input = async () => env;
    const { output, exitCode } = await run(["import"], input);
    expect(exitCode).toBe(0);
    expect(output).toMatchObject({ modes: ["ipauth"], mismatched: 0 });
    expect((await run(["status", "--get", "publicIp"])).output).toBe("157.245.75.233");
  });

  test("an import with a different FF3 key is refused", async () => {
    const input = async () => "FF3_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
    await expect(run(["import"], input)).rejects.toThrow(/FF3_KEY/);
  });

  test("connect stores the core, takes the prefix from it and registers; the registry token is not kept", async () => {
    const body = JSON.stringify({ coreUrl: `http://127.0.0.1:${core.port}`, slug: "acme", apiKey: "wr_live_cabinet_key_0123456789", publicIp: "157.245.75.233" });
    const { output, exitCode } = await run(["connect"], async () => body);
    expect(exitCode).toBe(0);
    expect((output as any).register.status).toBe("active");
    const register = received.find((r) => r.path.endsWith("/register"))!;
    expect(register.body).toMatchObject({ publicIp: "157.245.75.233", installationId: keys.installationId, ff3Fingerprint: keys.fingerprint, takeover: false });
    expect(register.body.coreKey.length).toBeGreaterThanOrEqual(16);
    expect(register.body).not.toHaveProperty("domain");
    expect(keys.clientPrefix()).toBe("771000");
    expect(JSON.stringify((await run(["status"])).output)).not.toContain("ghp_secret");
    expect((await run(["bundle-env"])).output).toContain("HN_REGISTRY_TOKEN=ghp_x");
  });

  test("the cabinet domain goes to WinRiders with every registration until it is cleared", async () => {
    const body = JSON.stringify({ coreUrl: `http://127.0.0.1:${core.port}`, slug: "acme", apiKey: "wr_live_cabinet_key_0123456789", publicIp: "157.245.75.233", domain: "Cabinet.Example.com" });
    expect((await run(["connect"], async () => body)).exitCode).toBe(0);
    expect((await run(["status", "--get", "domain"])).output).toBe("cabinet.example.com");
    await run(["register"]);
    expect(received.filter((r) => r.path.endsWith("/register")).map((r) => r.body.domain)).toEqual(["cabinet.example.com", "cabinet.example.com"]);
    expect((await run(["domain", "--clear"])).output).toEqual({ domain: null });
    await run(["register"]);
    expect(received.filter((r) => r.path.endsWith("/register")).at(-1)!.body).not.toHaveProperty("domain");
    await expect(run(["domain", "10.0.0.1"])).rejects.toThrow(/hostname/);
  });

  test("changing a trunk key finishes once WinRiders has it, and keeps both keys while it does not", async () => {
    const { changeTrunkKeyAndSync } = await import("./core");
    const { getTelephony, setCarrier, trunkKeyMode } = await import("./telephony");
    saveWrConfig({ baseUrl: `http://127.0.0.1:${core.port}`, slug: "acme", apiKey: "k", playerSegment: "seg", fields: DEFAULT_WR_FIELDS });
    setCarrier("ipauth", { host: "5.129.228.77" }, "wr_0000test0000key0000test0000key");

    trunksReplyStatus = 503;
    const stuck = await changeTrunkKeyAndSync("ipauth", "first_new_trunk_key_0123456789");
    expect(stuck).toMatchObject({ synced: false, error: "Telephony is not configured in WinRiders yet" });
    expect(trunkKeyMode("wr_0000test0000key0000test0000key")).toBe("ipauth");
    expect(trunkKeyMode("first_new_trunk_key_0123456789")).toBe("ipauth");

    trunksReplyStatus = 200;
    const done = await changeTrunkKeyAndSync("ipauth");
    expect(done.synced).toBe(true);
    expect(getTelephony().modes.ipauth).not.toHaveProperty("prevKey");
    expect(trunkKeyMode("wr_0000test0000key0000test0000key")).toBeNull();
    expect(trunkKeyMode("first_new_trunk_key_0123456789")).toBeNull();
    expect(trunkKeyMode(done.key)).toBe("ipauth");
    expect(syncedKeys.ipauth).toBe(done.key);
  });

  test("a route gets its own number in WinRiders and cannot be removed while an agent calls through it", async () => {
    const { addRouteAndSync, removeRouteAndSync } = await import("./core");
    const { setCarrier, trunkKeyLookup } = await import("./telephony");
    saveWrConfig({ baseUrl: `http://127.0.0.1:${core.port}`, slug: "acme", apiKey: "k", playerSegment: "seg", fields: DEFAULT_WR_FIELDS });
    setCarrier("ipauth", { host: "5.129.228.77" }, "wr_0000test0000key0000test0000key");

    expect(await addRouteAndSync("ipauth", "tdm", "02183")).toEqual({ mode: "ipauth", route: "tdm", synced: true });
    expect(Object.keys(syncedKeys).sort()).toEqual(["ipauth", "ipauth.tdm"]);
    expect(trunkKeyLookup(syncedKeys["ipauth.tdm"])).toEqual({ mode: "ipauth", route: "tdm", prefix: "02183" });

    agentsOn["ipauth.tdm"] = 1;
    await expect(removeRouteAndSync("ipauth", "tdm")).rejects.toThrow(/still used by 1 voice service/);
    expect(trunkKeyLookup(syncedKeys["ipauth.tdm"])?.route).toBe("tdm");

    agentsOn["ipauth.tdm"] = 0;
    expect(await removeRouteAndSync("ipauth", "tdm")).toEqual({ mode: "ipauth", route: "tdm", synced: true });
    expect(Object.keys(syncedKeys)).toEqual(["ipauth"]);
  });

  test("routes set in the WinRiders client card appear here on the next config sync, and leave only when free", async () => {
    const { syncBundleConfig } = await import("./core");
    const { setCarrier, trunkKeyLookup, getTelephony, isSourceAllowed, saveManagedTelephony } = await import("./telephony");
    saveWrConfig({ baseUrl: `http://127.0.0.1:${core.port}`, slug: "acme", apiKey: "k", playerSegment: "seg", fields: DEFAULT_WR_FIELDS });
    setCarrier("ipauth", { host: "5.129.228.77" }, "wr_0000test0000key0000test0000key");

    managedTelephony = { routes: { ipauth: [{ id: "tdm", prefix: "02183" }] }, allowedSources: ["199.88.252.0/24"] };
    await syncBundleConfig();
    expect(Object.keys(syncedKeys).sort()).toEqual(["ipauth", "ipauth.tdm"]);
    expect(trunkKeyLookup(syncedKeys["ipauth.tdm"])).toEqual({ mode: "ipauth", route: "tdm", prefix: "02183" });
    expect(isSourceAllowed("203.0.113.9")).toBe(false);

    managedTelephony = { routes: { ipauth: [{ id: "tdm", prefix: "02184" }] } };
    await syncBundleConfig();
    expect(trunkKeyLookup(syncedKeys["ipauth.tdm"])?.prefix).toBe("02184");
    expect(isSourceAllowed("203.0.113.9")).toBe(true);

    agentsOn["ipauth.tdm"] = 1;
    managedTelephony = { routes: { ipauth: [] } };
    await syncBundleConfig();
    expect(getTelephony().modes.ipauth!.routes.map((r) => r.id)).toEqual(["default", "tdm"]);

    agentsOn["ipauth.tdm"] = 0;
    await syncBundleConfig();
    expect(getTelephony().modes.ipauth!.routes.map((r) => r.id)).toEqual(["default"]);
    expect(Object.keys(syncedKeys)).toEqual(["ipauth"]);
    saveManagedTelephony({});
  });

  test("a pending registration stops the push worker until a takeover", async () => {
    saveWrConfig({ baseUrl: `http://127.0.0.1:${core.port}`, slug: "acme", apiKey: "k", playerSegment: "seg", fields: DEFAULT_WR_FIELDS });
    await run(["public-ip", "157.245.75.233"]);
    registerReply = { status: 202, body: { registered: false, status: "pending", reason: "other_installation" } };
    expect((await run(["register"])).output).toMatchObject({ status: "pending" });
    expect((await drainPushQueue()).skipped).toMatch(/takeover/);
    registerReply = { status: 200, body: { registered: true, status: "active", ok: true, trunks: {} } };
    await run(["register", "--takeover"]);
    expect(received.filter((r) => r.path.endsWith("/register")).map((r) => r.body.takeover)).toEqual([false, true]);
    expect((await drainPushQueue()).skipped).toBeUndefined();
  });

  test("carrier details never print keys or passwords, and trunks sync sends only keys of enabled modes", async () => {
    saveWrConfig({ baseUrl: `http://127.0.0.1:${core.port}`, slug: "acme", apiKey: "k", playerSegment: "seg", fields: DEFAULT_WR_FIELDS });
    const input = async () => JSON.stringify({ host: "sip.example", user: "acme", pass: "s3cret!" });
    await run(["carrier", "set", "digest"], input);
    const shown = JSON.stringify((await run(["carrier", "get", "digest"])).output);
    expect(shown).toContain("sip.example");
    expect(shown).not.toContain("s3cret!");
    await run(["trunks", "sync"]);
    const sync = received.find((r) => r.path.endsWith("/trunks"))!;
    expect(Object.keys(sync.body.trunks)).toEqual(["digest"]);
    expect(sync.body.installationId).toBe(keys.installationId);
  });

  test("the rtpengine ping reports a dead socket instead of hanging", async () => {
    expect(await rtpenginePing("127.0.0.1:9", 200)).toMatchObject({ ok: false });
  });

  test("an rtpengine that answers pong is reported alive", async () => {
    const fake = await Bun.udpSocket({
      socket: {
        data(socket, buf, port, address) {
          const [cookie] = Buffer.from(buf).toString().split(" ");
          socket.send(`${cookie} d6:result4:ponge`, port, address);
        },
      },
    });
    expect(await rtpenginePing(`127.0.0.1:${fake.port}`, 1000)).toMatchObject({ ok: true });
    fake.close();
  });
});
