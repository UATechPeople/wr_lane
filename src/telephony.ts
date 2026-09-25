import { randomBytes } from "crypto";
import { z } from "zod";
import { deleteSetting, getSetting, setSetting } from "./db";
import { secretEquals } from "./equals";

export const TRUNK_MODES = ["ipauth", "digest", "direct"] as const;
export type TrunkMode = (typeof TRUNK_MODES)[number];

const TELEPHONY_KEY = "telephony";
const PUBLIC_IP_KEY = "public_ip";
const BUNDLE_CONFIG_KEY = "bundle_config";
const DOMAIN_KEY = "cabinet_domain";

const host = z.string().trim().regex(/^[A-Za-z0-9.-]{1,253}$/, "host must be a hostname or an IPv4 address");
const port = z.number().int().min(1).max(65535).default(5060);
const trunkKey = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

const prefix = z.string().trim().regex(/^[0-9#*+]{0,16}$/, "prefix may hold digits, #, * and + only");
const routeId = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "route name may hold latin letters, digits and - only, up to 32");

export const carrierSchemas = {
  ipauth: z.object({ host, port, prefix: prefix.optional() }).strict(),
  digest: z
    .object({
      host,
      port,
      user: z.string().trim().regex(/^[A-Za-z0-9._~+-]{1,64}$/, "user may hold letters, digits and . _ ~ + - only"),
      pass: z.string().regex(/^[\x21-\x7e]{1,128}$/, "password must be 1-128 printable characters without spaces"),
      realm: z.string().trim().max(128).default(""),
      prefix: prefix.optional(),
    })
    .strict(),
  direct: z.object({ host, port, prefix: prefix.optional() }).strict(),
} as const;

export type CarrierInput = {
  ipauth: z.input<typeof carrierSchemas.ipauth>;
  digest: z.input<typeof carrierSchemas.digest>;
  direct: z.input<typeof carrierSchemas.direct>;
};

type Carrier = {
  ipauth: Omit<z.output<typeof carrierSchemas.ipauth>, "prefix">;
  digest: Omit<z.output<typeof carrierSchemas.digest>, "prefix">;
  direct: Omit<z.output<typeof carrierSchemas.direct>, "prefix">;
};

export const DEFAULT_ROUTE = "default";

export type TrunkRoute = { id: string; prefix: string; key: string; prevKey?: string };

export type ModeState<M extends TrunkMode = TrunkMode> = Carrier[M] & { routes: TrunkRoute[] };

export type TelephonyState = { modes: { [M in TrunkMode]?: ModeState<M> } };

export function newTrunkKey(): string {
  return `hn${randomBytes(24).toString("base64url")}`;
}

export function trunkName(mode: TrunkMode, route: string): string {
  return route === DEFAULT_ROUTE ? mode : `${mode}.${route}`;
}

function normalizeMode(raw: Record<string, unknown>): ModeState {
  if (Array.isArray(raw.routes)) return raw as unknown as ModeState;
  const { key, prevKey, prefix: legacyPrefix, ...carrier } = raw as { key?: string; prevKey?: string; prefix?: string } & Record<string, unknown>;
  const route: TrunkRoute = { id: DEFAULT_ROUTE, prefix: legacyPrefix ?? "", key: key ?? newTrunkKey() };
  if (prevKey) route.prevKey = prevKey;
  return { ...(carrier as unknown as Carrier[TrunkMode]), routes: [route] } as ModeState;
}

export function getTelephony(): TelephonyState {
  const raw = getSetting(TELEPHONY_KEY);
  if (!raw) return { modes: {} };
  const parsed = JSON.parse(raw) as { modes?: Record<string, Record<string, unknown>> };
  const modes: Partial<Record<TrunkMode, ModeState>> = {};
  for (const mode of TRUNK_MODES) {
    const m = parsed.modes?.[mode];
    if (m) modes[mode] = normalizeMode(m);
  }
  return { modes } as TelephonyState;
}

function saveTelephony(state: TelephonyState): void {
  setSetting(TELEPHONY_KEY, JSON.stringify(state));
}

function modeOf(state: TelephonyState, mode: TrunkMode): ModeState {
  const current = state.modes[mode] as ModeState | undefined;
  if (!current) throw new Error(`${mode} is not enabled`);
  return current;
}

function routeOf(current: ModeState, mode: TrunkMode, id: string): TrunkRoute {
  const route = current.routes.find((r) => r.id === id);
  if (!route) throw new Error(`${mode} has no route "${id}"`);
  return route;
}

function putMode(state: TelephonyState, mode: TrunkMode, value: ModeState): void {
  (state.modes as Partial<Record<TrunkMode, ModeState>>)[mode] = value;
}

export function setCarrier<M extends TrunkMode>(mode: M, input: unknown, key?: string): ModeState<M> {
  const { prefix: defaultPrefix, ...details } = carrierSchemas[mode].parse(input) as Carrier[M] & { prefix?: string };
  const state = getTelephony();
  const existing = state.modes[mode] as ModeState | undefined;
  const routes = existing ? existing.routes.map((r) => ({ ...r })) : [{ id: DEFAULT_ROUTE, prefix: "", key: newTrunkKey() }];
  const primary = routes.find((r) => r.id === DEFAULT_ROUTE)!;
  if (defaultPrefix !== undefined) primary.prefix = defaultPrefix;
  if (key !== undefined) primary.key = trunkKey.parse(key);
  const next = { ...details, routes } as unknown as ModeState<M>;
  putMode(state, mode, next as ModeState);
  saveTelephony(state);
  return next;
}

export function disableMode(mode: TrunkMode): boolean {
  const state = getTelephony();
  if (!state.modes[mode]) return false;
  delete state.modes[mode];
  saveTelephony(state);
  return true;
}

export function addRoute(mode: TrunkMode, id: string, routePrefix = ""): TrunkRoute {
  const state = getTelephony();
  const current = modeOf(state, mode);
  const routeIdValue = routeId.parse(id);
  if (current.routes.some((r) => r.id === routeIdValue)) throw new Error(`${mode} already has a route "${routeIdValue}"`);
  const route: TrunkRoute = { id: routeIdValue, prefix: prefix.parse(routePrefix), key: newTrunkKey() };
  putMode(state, mode, { ...current, routes: [...current.routes, route] });
  saveTelephony(state);
  return route;
}

export function removeRoute(mode: TrunkMode, id: string): boolean {
  if (id === DEFAULT_ROUTE) throw new Error("the default route stays while the mode is enabled; disable the mode instead");
  const state = getTelephony();
  const current = modeOf(state, mode);
  const routes = current.routes.filter((r) => r.id !== id);
  if (routes.length === current.routes.length) return false;
  putMode(state, mode, { ...current, routes });
  saveTelephony(state);
  return true;
}

export function setRoutePrefix(mode: TrunkMode, id: string, routePrefix: string): TrunkRoute {
  const state = getTelephony();
  const current = modeOf(state, mode);
  const route = routeOf(current, mode, id);
  route.prefix = prefix.parse(routePrefix);
  putMode(state, mode, current);
  saveTelephony(state);
  return route;
}

export function rotateKey(mode: TrunkMode, id = DEFAULT_ROUTE): { key: string; prevKey: string } {
  const state = getTelephony();
  const current = modeOf(state, mode);
  const route = routeOf(current, mode, id);
  if (route.prevKey) throw new Error(`${trunkName(mode, id)} is already rotating; finish the rotation first`);
  const previous = route.key;
  route.prevKey = previous;
  route.key = newTrunkKey();
  putMode(state, mode, current);
  saveTelephony(state);
  return { key: route.key, prevKey: previous };
}

export function changeTrunkKey(mode: TrunkMode, key?: string, id = DEFAULT_ROUTE): { key: string; prevKey: string | null } {
  const state = getTelephony();
  const current = modeOf(state, mode);
  const route = routeOf(current, mode, id);
  const next = key === undefined ? newTrunkKey() : trunkKey.parse(key.trim());
  if (next === route.key) return { key: next, prevKey: route.prevKey ?? null };
  const owner = trunkKeyLookup(next);
  if (owner && !(owner.mode === mode && owner.route === id)) throw new Error(`this key already belongs to ${trunkName(owner.mode, owner.route)}; every route needs its own key`);
  const prevKey = route.prevKey ?? route.key;
  route.key = next;
  if (prevKey === next) delete route.prevKey;
  else route.prevKey = prevKey;
  putMode(state, mode, current);
  saveTelephony(state);
  return { key: next, prevKey: route.prevKey ?? null };
}

export type TrunkKeyMatch = { mode: TrunkMode; route: string; prefix: string };

export function trunkKeyLookup(key: string | null | undefined): TrunkKeyMatch | null {
  if (!key) return null;
  const state = getTelephony();
  for (const mode of TRUNK_MODES) {
    const m = state.modes[mode] as ModeState | undefined;
    if (!m) continue;
    for (const route of m.routes) {
      if (secretEquals(key, route.key) || (route.prevKey && secretEquals(key, route.prevKey))) return { mode, route: route.id, prefix: route.prefix };
    }
  }
  return null;
}

export function trunkKeyMode(key: string | null | undefined): TrunkMode | null {
  return trunkKeyLookup(key)?.mode ?? null;
}

export function finishRotation(mode: TrunkMode, id = DEFAULT_ROUTE): boolean {
  const state = getTelephony();
  const current = state.modes[mode] as ModeState | undefined;
  const route = current?.routes.find((r) => r.id === id);
  if (!current || !route?.prevKey) return false;
  delete route.prevKey;
  putMode(state, mode, current);
  saveTelephony(state);
  return true;
}

export function enabledModes(): TrunkMode[] {
  const state = getTelephony();
  return TRUNK_MODES.filter((m) => state.modes[m]);
}

export function trunkKeysForCore(): Record<string, string> {
  const state = getTelephony();
  const out: Record<string, string> = {};
  for (const mode of TRUNK_MODES) {
    const m = state.modes[mode] as ModeState | undefined;
    if (!m) continue;
    for (const route of m.routes) out[trunkName(mode, route.id)] = route.key;
  }
  return out;
}

export type LocalTrunk = { name: string; mode: TrunkMode; route: TrunkRoute };

export function localTrunks(): LocalTrunk[] {
  const state = getTelephony();
  const out: LocalTrunk[] = [];
  for (const mode of TRUNK_MODES) {
    const m = state.modes[mode] as ModeState | undefined;
    if (!m) continue;
    for (const route of m.routes) out.push({ name: trunkName(mode, route.id), mode, route });
  }
  return out;
}

export function getPublicIp(): string | null {
  return getSetting(PUBLIC_IP_KEY);
}

export function setPublicIp(ip: string): void {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.split(".").some((o) => Number(o) > 255)) throw new Error("public ip must be an IPv4 address");
  setSetting(PUBLIC_IP_KEY, ip);
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function getDomain(): string | null {
  return getSetting(DOMAIN_KEY);
}

export function setDomain(domain: string | null): void {
  if (domain === null) {
    deleteSetting(DOMAIN_KEY);
    return;
  }
  const normalized = domain.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(normalized)) throw new Error("the domain must be a hostname like cabinet.example.com");
  setSetting(DOMAIN_KEY, normalized);
}

export type StoredBundleConfig = {
  bundle?: { version?: string; images?: Record<string, string> };
  clientPrefix?: string;
  slug?: string;
};

export function getBundleConfig(): StoredBundleConfig {
  const raw = getSetting(BUNDLE_CONFIG_KEY);
  return raw ? (JSON.parse(raw) as StoredBundleConfig) : {};
}

export function saveBundleConfig(config: Record<string, unknown>): StoredBundleConfig {
  const { registry: _registry, ...kept } = config;
  setSetting(BUNDLE_CONFIG_KEY, JSON.stringify(kept));
  return kept as StoredBundleConfig;
}

export function kamailioConfig() {
  const state = getTelephony();
  const modes: Record<string, unknown> = {};
  for (const mode of TRUNK_MODES) {
    const m = state.modes[mode] as ModeState | undefined;
    if (!m) continue;
    const { routes, ...carrier } = m;
    const primary = routes.find((r) => r.id === DEFAULT_ROUTE) ?? routes[0];
    modes[mode] = { ...carrier, key: primary?.key ?? null, prefix: primary?.prefix ?? "", routes: routes.map((r) => r.id) };
  }
  return { publicIp: getPublicIp(), modes };
}

function importLegacyRoutes(env: Record<string, string | undefined>, mode: TrunkMode): void {
  const pattern = new RegExp(`^TRUNK_${mode.toUpperCase()}_ROUTE_([A-Z0-9_]+)_KEY$`);
  for (const [name, value] of Object.entries(env)) {
    const match = pattern.exec(name);
    if (!match || !value?.trim()) continue;
    const id = match[1].toLowerCase().replace(/_/g, "-");
    const routePrefix = env[`TRUNK_${mode.toUpperCase()}_ROUTE_${match[1]}_PREFIX`]?.trim() ?? "";
    const route = addRoute(mode, id, routePrefix);
    changeTrunkKey(mode, value.trim(), route.id);
    finishRotation(mode, route.id);
  }
}

const LEGACY_PLACEHOLDER_HOSTS = new Set(["", "127.0.0.1"]);

function legacyKey(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name]?.trim() ?? "";
  if (!value || value === "placeholder") return null;
  return trunkKey.safeParse(value).success ? value : null;
}

export function importLegacyTelephony(env: Record<string, string | undefined>): TrunkMode[] {
  if (getSetting(TELEPHONY_KEY) !== null) return [];
  const imported: TrunkMode[] = [];
  const hostOf = (name: string) => env[name]?.trim() ?? "";
  const portOf = (name: string) => Number(env[name]?.trim() || 5060);
  const candidates: Array<[TrunkMode, string | null, () => unknown]> = [
    ["ipauth", legacyKey(env, "TRUNK_IPAUTH_API_KEY"), () => ({ host: hostOf("TRUNK_IPAUTH_HOST"), port: portOf("TRUNK_IPAUTH_PORT"), prefix: env.TRUNK_IPAUTH_PREFIX?.trim() ?? "" })],
    [
      "digest",
      legacyKey(env, "TRUNK_DIGEST_API_KEY"),
      () => ({ host: hostOf("TRUNK_DIGEST_HOST"), port: portOf("TRUNK_DIGEST_PORT"), user: env.TRUNK_DIGEST_USER?.trim() ?? "", pass: env.TRUNK_DIGEST_PASS ?? "", prefix: env.TRUNK_DIGEST_PREFIX?.trim() ?? "" }),
    ],
    ["direct", legacyKey(env, "TRUNK_DIRECT_API_KEY"), () => ({ host: hostOf("TRUNK_DIRECT_HOST"), port: portOf("TRUNK_DIRECT_PORT"), prefix: env.TRUNK_DIRECT_PREFIX?.trim() ?? "" })],
  ];
  for (const [mode, key, details] of candidates) {
    if (!key) continue;
    const input = details() as { host: string };
    if (LEGACY_PLACEHOLDER_HOSTS.has(input.host)) continue;
    const parsed = carrierSchemas[mode].safeParse(input);
    if (!parsed.success) continue;
    setCarrier(mode, parsed.data, key);
    importLegacyRoutes(env, mode);
    imported.push(mode);
  }
  if (imported.length === 0) saveTelephony({ modes: {} });
  const legacyIp = env.MY_PUBLIC_IP?.trim();
  if (legacyIp && getPublicIp() === null) {
    try {
      setPublicIp(legacyIp);
    } catch {
      return imported;
    }
  }
  return imported;
}
