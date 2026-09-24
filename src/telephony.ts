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

export const carrierSchemas = {
  ipauth: z.object({ host, port, prefix: z.string().trim().regex(/^[0-9#*+]{0,16}$/, "prefix may hold digits, #, * and + only").default("") }).strict(),
  digest: z
    .object({
      host,
      port,
      user: z.string().trim().regex(/^[A-Za-z0-9._~+-]{1,64}$/, "user may hold letters, digits and . _ ~ + - only"),
      pass: z.string().regex(/^[\x21-\x7e]{1,128}$/, "password must be 1-128 printable characters without spaces"),
      realm: z.string().trim().max(128).default(""),
    })
    .strict(),
  direct: z.object({ host, port }).strict(),
} as const;

export type CarrierInput = {
  ipauth: z.input<typeof carrierSchemas.ipauth>;
  digest: z.input<typeof carrierSchemas.digest>;
  direct: z.input<typeof carrierSchemas.direct>;
};

type Carrier = {
  ipauth: z.output<typeof carrierSchemas.ipauth>;
  digest: z.output<typeof carrierSchemas.digest>;
  direct: z.output<typeof carrierSchemas.direct>;
};

export type ModeState<M extends TrunkMode = TrunkMode> = Carrier[M] & { key: string; prevKey?: string };

export type TelephonyState = { modes: { [M in TrunkMode]?: ModeState<M> } };

export function newTrunkKey(): string {
  return `hn${randomBytes(24).toString("base64url")}`;
}

export function getTelephony(): TelephonyState {
  const raw = getSetting(TELEPHONY_KEY);
  if (!raw) return { modes: {} };
  const parsed = JSON.parse(raw) as TelephonyState;
  return { modes: parsed.modes ?? {} };
}

function saveTelephony(state: TelephonyState): void {
  setSetting(TELEPHONY_KEY, JSON.stringify(state));
}

export function setCarrier<M extends TrunkMode>(mode: M, input: unknown, key?: string): ModeState<M> {
  const details = carrierSchemas[mode].parse(input) as Carrier[M];
  const state = getTelephony();
  const existing = state.modes[mode];
  const chosenKey = key === undefined ? existing?.key ?? newTrunkKey() : trunkKey.parse(key);
  const next = { ...details, key: chosenKey, ...(existing?.prevKey ? { prevKey: existing.prevKey } : {}) } as ModeState<M>;
  state.modes[mode] = next as TelephonyState["modes"][M];
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

function putMode(state: TelephonyState, mode: TrunkMode, value: ModeState): void {
  (state.modes as Partial<Record<TrunkMode, ModeState>>)[mode] = value;
}

export function rotateKey<M extends TrunkMode>(mode: M): { key: string; prevKey: string } {
  const state = getTelephony();
  const current: ModeState<M> | undefined = state.modes[mode];
  if (!current) throw new Error(`${mode} is not enabled`);
  if (current.prevKey) throw new Error(`${mode} is already rotating; finish the rotation first`);
  const rotated: ModeState<M> = { ...current, prevKey: current.key, key: newTrunkKey() };
  putMode(state, mode, rotated);
  saveTelephony(state);
  return { key: rotated.key, prevKey: current.key };
}

export function changeTrunkKey<M extends TrunkMode>(mode: M, key?: string): { key: string; prevKey: string | null } {
  const state = getTelephony();
  const current: ModeState<M> | undefined = state.modes[mode];
  if (!current) throw new Error(`${mode} is not enabled`);
  const next = key === undefined ? newTrunkKey() : trunkKey.parse(key.trim());
  if (next === current.key) return { key: next, prevKey: current.prevKey ?? null };
  const prevKey = current.prevKey ?? current.key;
  const changed: ModeState<M> = { ...current, key: next, prevKey };
  if (prevKey === next) delete changed.prevKey;
  putMode(state, mode, changed);
  saveTelephony(state);
  return { key: next, prevKey: changed.prevKey ?? null };
}

export function trunkKeyMode(key: string | null | undefined): TrunkMode | null {
  if (!key) return null;
  const state = getTelephony();
  for (const mode of TRUNK_MODES) {
    const m = state.modes[mode];
    if (!m) continue;
    if (secretEquals(key, m.key) || (m.prevKey && secretEquals(key, m.prevKey))) return mode;
  }
  return null;
}

export function finishRotation<M extends TrunkMode>(mode: M): boolean {
  const state = getTelephony();
  const current: ModeState<M> | undefined = state.modes[mode];
  if (!current?.prevKey) return false;
  const finished: ModeState<M> = { ...current };
  delete finished.prevKey;
  putMode(state, mode, finished);
  saveTelephony(state);
  return true;
}

export function enabledModes(): TrunkMode[] {
  const state = getTelephony();
  return TRUNK_MODES.filter((m) => state.modes[m]);
}

export function trunkKeysForCore(): Partial<Record<TrunkMode, string>> {
  const state = getTelephony();
  const out: Partial<Record<TrunkMode, string>> = {};
  for (const mode of TRUNK_MODES) {
    const m = state.modes[mode];
    if (m) out[mode] = m.key;
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
    const m = state.modes[mode];
    if (m) modes[mode] = { ...m, prevKey: m.prevKey ?? null };
  }
  return { publicIp: getPublicIp(), modes };
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
      () => ({ host: hostOf("TRUNK_DIGEST_HOST"), port: portOf("TRUNK_DIGEST_PORT"), user: env.TRUNK_DIGEST_USER?.trim() ?? "", pass: env.TRUNK_DIGEST_PASS ?? "" }),
    ],
    ["direct", legacyKey(env, "TRUNK_DIRECT_API_KEY"), () => ({ host: hostOf("TRUNK_DIRECT_HOST"), port: portOf("TRUNK_DIRECT_PORT") })],
  ];
  for (const [mode, key, details] of candidates) {
    if (!key) continue;
    const input = details() as { host: string };
    if (LEGACY_PLACEHOLDER_HOSTS.has(input.host)) continue;
    const parsed = carrierSchemas[mode].safeParse(input);
    if (!parsed.success) continue;
    setCarrier(mode, parsed.data, key);
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
