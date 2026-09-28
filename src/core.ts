import { Cron } from "croner";
import axios from "axios";
import { createHash, randomBytes } from "crypto";
import { getSetting, setSetting } from "./db";
import { keys, setClientPrefix } from "./keys";
import {
  addRoute,
  changeTrunkKey,
  parseManagedTelephony,
  planManagedRoutes,
  saveManagedTelephony,
  setRoutePrefix,
  DEFAULT_ROUTE,
  enabledModes,
  finishRotation,
  getDomain,
  getPublicIp,
  getTelephony,
  localTrunks,
  removeRoute,
  saveBundleConfig,
  setDomain,
  setPublicIp,
  trunkKeysForCore,
  trunkName,
  TRUNK_MODES,
  type ModeState,
  type TrunkMode,
} from "./telephony";
import { buildInfo } from "./version";
import { getCoreKey, getWrConfig, saveWrConfig, setCoreKey } from "./webhook";

const CORE_STATE_KEY = "core_installation";

export type CoreInstallationState = { status: "active" | "pending"; reason?: string; at: string };

export function getCoreState(): CoreInstallationState | null {
  const raw = getSetting(CORE_STATE_KEY);
  return raw ? (JSON.parse(raw) as CoreInstallationState) : null;
}

function setCoreState(state: CoreInstallationState): void {
  setSetting(CORE_STATE_KEY, JSON.stringify(state));
}

export function pushBlockedReason(): string | null {
  const state = getCoreState();
  if (state?.status === "pending") return "this installation is waiting for a takeover in WinRiders; nothing is sent until then";
  return null;
}

type CoreResponse<T> = { status: number; data: T };

function coreBase(): { url: string; slug: string; apiKey: string } {
  const wr = getWrConfig();
  if (!wr.baseUrl || !wr.slug || !wr.apiKey) throw new Error("the WinRiders connection is not set");
  return { url: wr.baseUrl.replace(/\/$/, ""), slug: wr.slug, apiKey: wr.apiKey };
}

async function coreRequest<T>(method: "GET" | "POST", path: string, body?: unknown, responseType: "json" | "text" = "json"): Promise<CoreResponse<T>> {
  const base = coreBase();
  const response = await axios.request({
    method,
    url: `${base.url}/v1/clients/${encodeURIComponent(base.slug)}/bundle/${path}`,
    data: body,
    headers: {
      authorization: `Bearer ${base.apiKey}`,
      "content-type": "application/json",
      "x-bundle-version": buildInfo.version,
    },
    timeout: 60_000,
    responseType,
    validateStatus: () => true,
  });
  return { status: response.status, data: response.data as T };
}

function describeFailure(status: number, data: unknown): string {
  const error = (data as { error?: { code?: string; message?: string } | string } | null)?.error;
  if (typeof error === "string") return `WinRiders responded ${status}: ${error}`;
  if (error?.message) return `WinRiders responded ${status}: ${error.message}`;
  return `WinRiders responded ${status}`;
}

export async function syncBundleConfig(): Promise<Record<string, unknown>> {
  const res = await coreRequest<{ config?: Record<string, unknown> }>("GET", "config");
  if (res.status !== 200 || !res.data.config) throw new Error(describeFailure(res.status, res.data));
  const stored = saveBundleConfig(res.data.config);
  if (typeof stored.clientPrefix === "string" && stored.clientPrefix) setClientPrefix(stored.clientPrefix);
  await applyManagedTelephony(res.data.config.telephony);
  return res.data.config;
}

export type ManagedApply = {
  added: string[];
  prefixed: string[];
  removed: string[];
  keptInUse: string[];
  problems: string[];
  synced: boolean | null;
};

export async function applyManagedTelephony(raw: unknown): Promise<ManagedApply> {
  const { managed, problems } = parseManagedTelephony(raw);
  saveManagedTelephony(managed);
  const result: ManagedApply = { added: [], prefixed: [], removed: [], keptInUse: [], problems, synced: null };
  const plan = planManagedRoutes(managed);
  for (const item of plan.add) {
    addRoute(item.mode, item.id, item.prefix);
    result.added.push(trunkName(item.mode, item.id));
  }
  for (const item of plan.setPrefix) {
    setRoutePrefix(item.mode, item.id, item.prefix);
    result.prefixed.push(trunkName(item.mode, item.id));
  }
  if (plan.remove.length > 0) {
    let inUse: Map<string, number> | null = null;
    try {
      inUse = new Map((await compareTelephonyWithCore()).trunks.map((t) => [t.name, t.voiceServicesWithAgent]));
    } catch (e) {
      result.problems.push(`routes to remove are kept: WinRiders cannot be asked whether they are in use (${(e as Error).message})`);
    }
    for (const item of plan.remove) {
      const name = trunkName(item.mode, item.id);
      if (!inUse || (inUse.get(name) ?? 0) > 0) {
        result.keptInUse.push(name);
        continue;
      }
      removeRoute(item.mode, item.id);
      result.removed.push(name);
    }
  }
  if (result.added.length > 0 || result.removed.length > 0) {
    try {
      const sync = await syncTrunks();
      result.synced = sync.httpStatus < 300;
      if (!result.synced) result.problems.push(syncError(sync));
    } catch (e) {
      result.synced = false;
      result.problems.push((e as Error).message);
    }
  }
  if (result.added.length || result.prefixed.length || result.removed.length || result.keptInUse.length || result.problems.length) {
    console.log(`[hidden-numbers] telephony from WinRiders: ${JSON.stringify(result)}`);
  }
  return result;
}

export function startManagedConfigCron(pattern = "0 */2 * * * *"): Cron {
  return new Cron(pattern, { protect: true, name: "bundle-config" }, async () => {
    const wr = getWrConfig();
    if (!wr.baseUrl || !wr.slug || !wr.apiKey || getCoreState()?.status !== "active") return;
    try {
      await syncBundleConfig();
    } catch (e) {
      console.error(`[hidden-numbers] bundle config sync failed: ${(e as Error).message}`);
    }
  });
}

export function ensureCoreKey(): string {
  const existing = getCoreKey();
  if (existing) return existing;
  const generated = randomBytes(24).toString("hex");
  setCoreKey(generated);
  return generated;
}

export type RegisterResult = {
  status: "active" | "pending" | "rejected";
  httpStatus: number;
  body: Record<string, unknown>;
};

export async function registerWithCore(options: { takeover?: boolean } = {}): Promise<RegisterResult> {
  const publicIp = getPublicIp();
  if (!publicIp) throw new Error("the public ip of this server is not set");
  const domain = getDomain();
  const res = await coreRequest<Record<string, unknown>>("POST", "register", {
    publicIp,
    ...(domain ? { domain } : {}),
    coreKey: ensureCoreKey(),
    installationId: keys.installationId,
    ff3Fingerprint: keys.fingerprint,
    takeover: options.takeover === true,
    components: { cabinet: buildInfo.version },
  });
  const at = new Date().toISOString();
  if (res.status === 202 && res.data.status === "pending") {
    setCoreState({ status: "pending", reason: String(res.data.reason ?? ""), at });
    return { status: "pending", httpStatus: res.status, body: res.data };
  }
  if (res.data.registered === true) {
    setCoreState({ status: "active", at });
    return { status: "active", httpStatus: res.status, body: res.data };
  }
  if (res.status === 409 || res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
    return { status: "rejected", httpStatus: res.status, body: res.data };
  }
  throw new Error(describeFailure(res.status, res.data));
}

export type ConnectInput = { coreUrl: string; slug: string; apiKey: string; publicIp: string; domain?: string | null };

export async function connectToCore(input: ConnectInput): Promise<{ config: Record<string, unknown>; register: RegisterResult }> {
  const current = getWrConfig();
  saveWrConfig({
    ...current,
    baseUrl: input.coreUrl,
    slug: input.slug,
    apiKey: input.apiKey,
    playerSegment: current.playerSegment || "hidden_base",
  });
  setPublicIp(input.publicIp);
  if (input.domain !== undefined) setDomain(input.domain || null);
  const config = await syncBundleConfig();
  const register = await registerWithCore();
  return { config, register };
}

export async function syncTrunks(): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const res = await coreRequest<Record<string, unknown>>("POST", "trunks", { installationId: keys.installationId, trunks: trunkKeysForCore() });
  return { httpStatus: res.status, body: res.data };
}

export const keyHash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

export type TrunkComparison = {
  name: string;
  mode: TrunkMode;
  route: string;
  local: boolean;
  core: boolean;
  keysMatch: boolean | null;
  voiceServices: number;
  voiceServicesWithAgent: number;
  prevKeyMatches: boolean;
};

function splitTrunkName(name: string): { mode: TrunkMode; route: string } | null {
  const [mode, route] = name.split(".", 2);
  if (!(TRUNK_MODES as readonly string[]).includes(mode)) return null;
  return { mode: mode as TrunkMode, route: route ?? DEFAULT_ROUTE };
}

export async function compareTelephonyWithCore(): Promise<{
  installation: Record<string, unknown>;
  thisInstallation: string;
  trunks: TrunkComparison[];
}> {
  const res = await coreRequest<{
    installation: Record<string, unknown>;
    trunks: Record<string, { phoneNumberId: string; keyHash: string; voiceServices: number; voiceServicesWithAgent?: number }>;
  }>("GET", "telephony");
  if (res.status !== 200) throw new Error(describeFailure(res.status, res.data));
  const local = new Map(localTrunks().map((t) => [t.name, t]));
  const names = [...new Set([...local.keys(), ...Object.keys(res.data.trunks ?? {})])].sort();
  const trunks: TrunkComparison[] = [];
  for (const name of names) {
    const parts = splitTrunkName(name);
    if (!parts) continue;
    const mine = local.get(name)?.route;
    const theirs = res.data.trunks?.[name];
    trunks.push({
      name,
      mode: parts.mode,
      route: parts.route,
      local: Boolean(mine),
      core: Boolean(theirs),
      keysMatch: mine && theirs ? keyHash(mine.key) === theirs.keyHash : null,
      voiceServices: theirs?.voiceServices ?? 0,
      voiceServicesWithAgent: theirs?.voiceServicesWithAgent ?? theirs?.voiceServices ?? 0,
      prevKeyMatches: Boolean(mine?.prevKey && theirs && keyHash(mine.prevKey) === theirs.keyHash),
    });
  }
  return { installation: res.data.installation, thisInstallation: keys.installationId, trunks };
}

export type TrunkKeyChange = { mode: TrunkMode; route: string; key: string; synced: boolean; error?: string };

function syncError(sync: { httpStatus: number; body: Record<string, unknown> }): string {
  const message = (sync.body as { error?: { message?: string } }).error?.message;
  return message ?? `WinRiders has not taken the change yet (HTTP ${sync.httpStatus})`;
}

export async function changeTrunkKeyAndSync(mode: TrunkMode, key?: string, route = DEFAULT_ROUTE): Promise<TrunkKeyChange> {
  const changed = changeTrunkKey(mode, key, route);
  if (!changed.prevKey) return { mode, route, key: changed.key, synced: true };
  try {
    const sync = await syncTrunks();
    const compare = await compareTelephonyWithCore();
    const row = compare.trunks.find((t) => t.name === trunkName(mode, route));
    if (row?.keysMatch === true) {
      finishRotation(mode, route);
      return { mode, route, key: changed.key, synced: true };
    }
    return { mode, route, key: changed.key, synced: false, error: syncError(sync) };
  } catch (e) {
    return { mode, route, key: changed.key, synced: false, error: (e as Error).message };
  }
}

export type RouteChange = { mode: TrunkMode; route: string; synced: boolean; error?: string };

export async function addRouteAndSync(mode: TrunkMode, route: string, prefix = ""): Promise<RouteChange> {
  const added = addRoute(mode, route, prefix);
  try {
    const sync = await syncTrunks();
    const outcome = (sync.body as { trunks?: Record<string, { status?: string }> }).trunks?.[trunkName(mode, added.id)]?.status;
    if (sync.httpStatus < 300 && outcome && outcome !== "failed" && outcome !== "skipped") return { mode, route: added.id, synced: true };
    return { mode, route: added.id, synced: false, error: syncError(sync) };
  } catch (e) {
    return { mode, route: added.id, synced: false, error: (e as Error).message };
  }
}

export async function removeRouteAndSync(mode: TrunkMode, route: string): Promise<RouteChange> {
  const name = trunkName(mode, route);
  let compare: Awaited<ReturnType<typeof compareTelephonyWithCore>>;
  try {
    compare = await compareTelephonyWithCore();
  } catch (e) {
    throw new Error(`cannot check with WinRiders whether ${name} is still in use: ${(e as Error).message}`);
  }
  const row = compare.trunks.find((t) => t.name === name);
  if (row && row.voiceServicesWithAgent > 0) {
    throw new Error(`${name} is still used by ${row.voiceServicesWithAgent} voice service(s) with an agent in WinRiders; move them to another route first`);
  }
  if (!removeRoute(mode, route)) throw new Error(`${mode} has no route "${route}"`);
  try {
    const sync = await syncTrunks();
    if (sync.httpStatus < 300) return { mode, route, synced: true };
    return { mode, route, synced: false, error: syncError(sync) };
  } catch (e) {
    return { mode, route, synced: false, error: (e as Error).message };
  }
}

export async function bundleEnvFromCore(): Promise<string> {
  const res = await coreRequest<string>("GET", "config?format=env", undefined, "text");
  if (res.status !== 200 || typeof res.data !== "string") throw new Error(describeFailure(res.status, res.data));
  return res.data.trim();
}

export function modesSummary() {
  const state = getTelephony();
  return enabledModes().map((mode) => {
    const m = state.modes[mode] as ModeState;
    return {
      mode,
      host: m.host,
      port: m.port,
      rotating: m.routes.some((r) => Boolean(r.prevKey)),
      routes: m.routes.map((r) => ({ id: r.id, prefix: r.prefix, rotating: Boolean(r.prevKey) })),
    };
  });
}
