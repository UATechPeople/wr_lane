import { randomBytes } from "crypto";
import { countNumbers, pushQueueStats } from "./db";
import {
  bundleEnvFromCore,
  compareTelephonyWithCore,
  connectToCore,
  getCoreState,
  addRouteAndSync,
  changeTrunkKeyAndSync,
  modesSummary,
  removeRouteAndSync,
  registerWithCore,
  syncBundleConfig,
  syncTrunks,
} from "./core";
import { encryptPhone, looksLikeToken } from "./fpe";
import { checkKeysAgainstBase, importKeys, keys, secretStore, setCabinetPassword } from "./keys";
import { FrozenSecretConflict } from "./secrets";
import { exportKeysEnv } from "./key-settings";
import { probeOptions } from "./sip-probe";
import {
  DEFAULT_ROUTE,
  disableMode,
  finishRotation,
  getDomain,
  getManagedTelephony,
  getPublicIp,
  getTelephony,
  importLegacyTelephony,
  setCarrier,
  setDomain,
  setPublicIp,
  setRoutePrefix,
  TRUNK_MODES,
  type TrunkMode,
} from "./telephony";
import { buildInfo } from "./version";
import { getWrConfig } from "./webhook";

export class CliError extends Error {}

export function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function modeArg(value: string | undefined): TrunkMode {
  if (!value || !(TRUNK_MODES as readonly string[]).includes(value)) throw new CliError(`expected a mode: ${TRUNK_MODES.join(", ")}`);
  return value as TrunkMode;
}

function pick(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

async function parseJson(text: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CliError("expected a JSON object on stdin");
  }
}

function status() {
  const wr = getWrConfig();
  const queue = pushQueueStats(12);
  let fingerprint: string | null = null;
  let installationId: string | null = null;
  try {
    fingerprint = keys.fingerprint;
    installationId = keys.installationId;
  } catch {
    fingerprint = null;
  }
  return {
    version: buildInfo.version,
    installationId,
    fingerprint,
    publicIp: getPublicIp(),
    domain: getDomain(),
    clientPrefix: keys.clientPrefix(),
    core: { url: wr.baseUrl || null, slug: wr.slug || null, connected: Boolean(wr.baseUrl && wr.slug && wr.apiKey), state: getCoreState() },
    modes: modesSummary(),
    numbers: countNumbers(),
    queue,
  };
}

export async function rtpenginePing(target: string, timeoutMs = 2000): Promise<{ ok: boolean; reply: string | null }> {
  const [host, portText] = target.split(":");
  const port = Number(portText);
  if (!host || !Number.isInteger(port)) throw new CliError("expected host:port");
  const cookie = randomBytes(4).toString("hex");
  let reply: string | null = null;
  let wake: (() => void) | null = null;
  const socket = await Bun.udpSocket({
    socket: {
      data(_s, buf) {
        reply = Buffer.from(buf).toString("utf8");
        wake?.();
      },
    },
  });
  try {
    socket.send(`${cookie} d7:command4:pinge`, port, host);
    await Promise.race([new Promise<void>((resolve) => (wake = resolve)), Bun.sleep(timeoutMs)]);
  } finally {
    socket.close();
  }
  const text = reply as string | null;
  return { ok: Boolean(text && text.startsWith(cookie) && text.includes("pong")), reply: text };
}

export type Check = { level: "ok" | "warn" | "fail"; text: string };

export async function doctor(): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (level: Check["level"], text: string) => checks.push({ level, text });
  const st = status();
  add(st.fingerprint ? "ok" : "fail", st.fingerprint ? `encryption key in place (fingerprint ${st.fingerprint})` : "encryption key is missing");
  add(st.publicIp ? "ok" : "fail", st.publicIp ? `public ip ${st.publicIp}` : "public ip is not set");
  if (st.clientPrefix) add("ok", `legacy client prefix ${st.clientPrefix} is stripped from dialled numbers`);
  if (!st.core.connected) {
    add("fail", "not connected to WinRiders");
    return checks;
  }
  const state = st.core.state?.status;
  if (state === "active") add("ok", `connected to ${st.core.url} as ${st.core.slug}, this installation is active`);
  else if (state === "pending") add("warn", "this installation waits for a takeover; another server still receives the calls");
  else add("warn", `connected to ${st.core.url}, but this installation never registered`);

  const queue = st.queue;
  if (queue.abandoned > 0) add("warn", `${queue.abandoned} call(s) gave up reaching WinRiders; retry them in Batches`);
  add(queue.pending > 0 ? "warn" : "ok", queue.pending > 0 ? `${queue.pending} call(s) waiting to be sent to WinRiders` : "nothing waits to be sent to WinRiders");

  const modes = modesSummary();
  if (modes.length === 0) add("fail", "no telephony mode is enabled; no call can leave this server");

  let comparison: Awaited<ReturnType<typeof compareTelephonyWithCore>> | null = null;
  try {
    comparison = await compareTelephonyWithCore();
    add("ok", "WinRiders answers with this cabinet key");
  } catch (e) {
    add("fail", `WinRiders cannot be asked about telephony: ${(e as Error).message}`);
  }
  if (comparison) {
    const inst = comparison.installation as { installationId?: string | null; publicIp?: string | null };
    if (inst.installationId && inst.installationId !== comparison.thisInstallation) {
      add(state === "pending" ? "warn" : "fail", `WinRiders sends calls to another installation (${inst.publicIp ?? "unknown ip"})`);
    } else if (inst.installationId && inst.publicIp !== st.publicIp) {
      add("fail", `WinRiders sends call results to ${inst.publicIp}, not to this server`);
    }
  }

  for (const m of modes) {
    const current = getTelephony().modes[m.mode] as { host: string; port: number; user?: string; pass?: string };
    const probe = await probeOptions({ host: current.host, port: current.port, user: current.user, pass: current.pass, fromHost: st.publicIp ?? "0.0.0.0" });
    if (probe.ok) add("ok", `${m.mode}: ${current.host}:${current.port} answers OPTIONS with ${probe.status}${probe.authenticated ? " after authentication" : ""}`);
    else if (probe.stage === "timeout") add("warn", `${m.mode}: ${current.host}:${current.port} does not answer OPTIONS (not whitelisted, or the carrier ignores OPTIONS)`);
    else add(probe.stage === "dns" ? "fail" : "warn", `${m.mode}: ${probe.reason}`);
    const beforeTakeover = state === "pending";
    for (const route of m.routes) {
      const name = route.id === DEFAULT_ROUTE ? m.mode : `${m.mode}.${route.id}`;
      const trunk = comparison?.trunks.find((t) => t.name === name);
      const label = route.prefix ? `${name} (prefix ${route.prefix})` : name;
      if (comparison && !trunk?.core) add(beforeTakeover ? "warn" : "fail", `${label}: WinRiders has no number for this route${beforeTakeover ? " yet; it is created at the takeover" : "; run update.sh --trunks"}`);
      else if (trunk && trunk.keysMatch === false && !trunk.prevKeyMatches) {
        add(beforeTakeover ? "warn" : "fail", `${label}: the key WinRiders sends differs from the one this server accepts${beforeTakeover ? "; it is switched at the takeover" : ""}`);
      }
      else if (trunk && trunk.keysMatch === false && trunk.prevKeyMatches) add("warn", `${label}: key change in progress; WinRiders still sends the previous key`);
      else if (trunk) add("ok", `${label}: the trunk key matches WinRiders`);
      if (trunk && trunk.voiceServicesWithAgent === 0) add("ok", `${label}: the number is ready; its voice service in WinRiders waits for an agent`);
    }
  }
  for (const t of comparison?.trunks ?? []) {
    if (t.core && !t.local) add("warn", `${t.name}: WinRiders still has a number for a route this server does not accept`);
  }

  const allowed = getManagedTelephony().allowedSources ?? [];
  add("ok", allowed.length > 0 ? `SIP is accepted only from ${allowed.join(", ")} (set in WinRiders)` : "SIP is accepted from any address (no allow list in WinRiders)");

  const rtp = await rtpenginePing("172.28.0.1:22222", 1500).catch(() => ({ ok: false }));
  add(rtp.ok ? "ok" : "fail", rtp.ok ? "rtpengine answers on 172.28.0.1:22222" : "rtpengine does not answer on 172.28.0.1:22222; calls would connect without sound");
  return checks;
}

export async function run(argv: string[], stdin: () => Promise<string> = readStdin): Promise<{ output: unknown; exitCode: number }> {
  const readJsonStdin = async () => parseJson(await stdin());
  const getIndex = argv.indexOf("--get");
  const getPath = getIndex >= 0 ? argv[getIndex + 1] : null;
  const args = getIndex >= 0 ? [...argv.slice(0, getIndex), ...argv.slice(getIndex + 2)] : argv;
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const [command, sub, third] = args.filter((a) => !a.startsWith("--"));

  let output: unknown;
  let exitCode = 0;

  switch (command) {
    case "import": {
      const env = parseEnvLines(await stdin());
      if (!env.FF3_KEY && countNumbers() > 0 && !secretStore.get("ff3_key")) {
        throw new CliError("FF3_KEY is missing from the import, but this base holds numbers encrypted with it");
      }
      let resolved;
      try {
        resolved = importKeys(env);
      } catch (e) {
        if (e instanceof FrozenSecretConflict) throw new CliError(e.message);
        throw e;
      }
      const modes = importLegacyTelephony(env);
      const check = secretStore.get("ff3_key") ? checkKeysAgainstBase(encryptPhone, looksLikeToken) : { checked: 0, mismatched: 0 };
      output = { imported: resolved.imported, modes, ...check };
      if (check.mismatched > 0) exitCode = 1;
      break;
    }
    case "status":
      output = status();
      break;
    case "connect": {
      const body = await readJsonStdin();
      const input = {
        coreUrl: String(body.coreUrl ?? ""),
        slug: String(body.slug ?? ""),
        apiKey: String(body.apiKey ?? ""),
        publicIp: String(body.publicIp ?? ""),
        domain: typeof body.domain === "string" ? body.domain : undefined,
      };
      if (!input.coreUrl || !input.slug || !input.apiKey || !input.publicIp) throw new CliError("connect needs coreUrl, slug, apiKey and publicIp");
      const result = await connectToCore(input);
      output = { register: result.register };
      if (result.register.status === "rejected") exitCode = 1;
      break;
    }
    case "register": {
      const result = await registerWithCore({ takeover: flags.has("--takeover") });
      output = result;
      if (result.status === "rejected") exitCode = 1;
      break;
    }
    case "sync-config":
      output = { config: await syncBundleConfig(), clientPrefix: keys.clientPrefix() };
      break;
    case "bundle-env":
      output = await bundleEnvFromCore();
      break;
    case "domain":
      if (flags.has("--clear")) setDomain(null);
      else if (sub) setDomain(sub);
      output = { domain: getDomain() };
      break;
    case "public-ip":
      if (!sub) throw new CliError("public-ip needs an address");
      setPublicIp(sub);
      output = { publicIp: getPublicIp() };
      break;
    case "carrier": {
      if (sub === "set") {
        const mode = modeArg(third);
        const saved = setCarrier(mode, await readJsonStdin());
        output = { mode, host: saved.host, port: saved.port };
      } else if (sub === "disable") {
        output = { mode: modeArg(third), disabled: disableMode(modeArg(third)) };
      } else if (sub === "names") {
        output = modesSummary()
          .map((m) => m.mode)
          .join(" ");
      } else if (sub === "get") {
        const mode = modeArg(third);
        const current = getTelephony().modes[mode];
        output = current ? { ...current, pass: undefined, routes: current.routes.map((r) => ({ id: r.id, prefix: r.prefix, rotating: Boolean(r.prevKey) })) } : null;
      } else if (sub === "route") {
        const [, , action, modeName, routeName, routePrefix] = args.filter((x) => !x.startsWith("--"));
        const mode = modeArg(modeName);
        if (action === "add") {
          output = await addRouteAndSync(mode, routeName ?? "", routePrefix ?? "");
          if (!(output as { synced: boolean }).synced) exitCode = 1;
        } else if (action === "remove") {
          output = await removeRouteAndSync(mode, routeName ?? "");
          if (!(output as { synced: boolean }).synced) exitCode = 1;
        } else if (action === "prefix") {
          const route = setRoutePrefix(mode, routeName ?? "", routePrefix ?? "");
          output = { mode, route: route.id, prefix: route.prefix };
        } else {
          throw new CliError("carrier route add <mode> <name> [prefix] | remove <mode> <name> | prefix <mode> <name> <prefix>");
        }
      } else {
        output = modesSummary();
      }
      break;
    }
    case "probe": {
      const mode = modeArg(sub);
      const current = getTelephony().modes[mode] as { host: string; port: number; user?: string; pass?: string } | undefined;
      if (!current) throw new CliError(`${mode} is not enabled`);
      output = await probeOptions({ host: current.host, port: current.port, user: current.user, pass: current.pass, fromHost: getPublicIp() ?? "0.0.0.0" });
      break;
    }
    case "trunks": {
      if (sub === "sync") {
        const result = await syncTrunks();
        const trunks = ((result.body as { trunks?: Record<string, { status?: string }> }).trunks ?? {}) as Record<string, { status?: string }>;
        const lines = Object.entries(trunks).map(([mode, outcome]) => `${mode}\t${outcome.status ?? "unknown"}`);
        const message = (result.body as { error?: { message?: string } }).error?.message;
        output = [`http\t${result.httpStatus}`, ...lines, ...(message ? [`message\t${message}`] : [])].join("\n");
        if (result.httpStatus >= 400) exitCode = 1;
      } else if (sub === "compare") {
        output = await compareTelephonyWithCore();
      } else if (sub === "rotate") {
        const positional = args.filter((x) => !x.startsWith("--"));
        const routeFlag = args.find((x) => x.startsWith("--route="))?.slice("--route=".length) ?? DEFAULT_ROUTE;
        const result = await changeTrunkKeyAndSync(modeArg(third), positional[3], routeFlag);
        output = { mode: result.mode, route: result.route, synced: result.synced, ...(result.error ? { error: result.error } : {}) };
        if (!result.synced) exitCode = 1;
      } else if (sub === "finish") {
        output = { mode: third, finished: finishRotation(modeArg(third), args.find((x) => x.startsWith("--route="))?.slice("--route=".length) ?? DEFAULT_ROUTE) };
      } else {
        throw new CliError("trunks sync|compare|rotate <mode>|finish <mode>");
      }
      break;
    }
    case "rtpengine-ping":
      output = await rtpenginePing(sub ?? "172.28.0.1:22222");
      if (!(output as { ok: boolean }).ok) exitCode = 1;
      break;
    case "wr-key":
      output = getWrConfig().apiKey;
      break;
    case "doctor": {
      const report = await doctor();
      output = flags.has("--json") ? report : report.map((c) => `${c.level}\t${c.text}`).join("\n");
      if (report.some((c) => c.level === "fail")) exitCode = 1;
      break;
    }
    case "credentials":
      output = { user: keys.cabinetUser(), password: keys.cabinetPassword() };
      break;
    case "password": {
      const next = sub ?? randomBytes(12).toString("base64url");
      setCabinetPassword(next);
      output = { user: keys.cabinetUser(), password: next };
      break;
    }
    case "export-keys":
      output = exportKeysEnv();
      break;
    default:
      throw new CliError(
        "commands: import, status, connect, register [--takeover], sync-config, bundle-env, public-ip <ip>, domain [name|--clear], carrier [set|disable|get <mode>] | carrier route add|remove|prefix <mode> <name> [prefix], probe <mode>, trunks sync|compare|rotate|finish, rtpengine-ping [host:port], credentials, password [new], export-keys",
      );
  }

  if (getPath) {
    const value = pick(output, getPath);
    return { output: value === undefined || value === null ? "" : value, exitCode };
  }
  return { output, exitCode };
}

if (import.meta.main) {
  try {
    const { output, exitCode } = await run(Bun.argv.slice(2));
    if (typeof output === "string") console.log(output);
    else if (typeof output === "number" || typeof output === "boolean") console.log(String(output));
    else console.log(JSON.stringify(output, null, 2));
    process.exit(exitCode);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(e instanceof CliError ? 2 : 3);
  }
}
