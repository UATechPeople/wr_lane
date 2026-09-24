import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "./config";
import { countNumbers, deleteSetting, getSetting, insertSettingIfAbsent, sampleTokenPairs, setSetting } from "./db";
import { ff3Fingerprint, resolveSecrets, type ResolvedSecrets, type SecretName } from "./secrets";

const settingKey = (name: SecretName) => `secret.${name}`;

export const secretStore = {
  get: (name: SecretName) => getSetting(settingKey(name)),
  setIfAbsent: (name: SecretName, value: string) => insertSettingIfAbsent(settingKey(name), value),
};

export function setClientPrefix(prefix: string | null): void {
  if (prefix === null || prefix === "") {
    deleteSetting(settingKey("client_prefix"));
    return;
  }
  if (!/^\d{1,12}$/.test(prefix)) throw new Error("client prefix must be 1-12 digits");
  setSetting(settingKey("client_prefix"), prefix);
}

export function setCabinetPassword(password: string): void {
  if (password.length < 8) throw new Error("password must be at least 8 characters");
  setSetting(settingKey("cabinet_password"), password);
}

export function initKeys(env: Record<string, string | undefined>): ResolvedSecrets {
  return resolveSecrets(secretStore, env, countNumbers() === 0 ? "all" : "unfrozen");
}

export function importKeys(env: Record<string, string | undefined>): ResolvedSecrets {
  return resolveSecrets(secretStore, env, "none");
}

type Fixed = { ff3Key: string; ff3Tweak: string; routeDigit: string; fingerprint: string };

let fixedCache: Fixed | null = null;

export function resetKeysCache(): void {
  fixedCache = null;
}

function required(name: SecretName): string {
  const value = secretStore.get(name);
  if (!value) throw new Error(`cabinet keys are not set up (${name} is missing); start the cabinet once or run the import`);
  return value;
}

function fixed(): Fixed {
  if (!fixedCache) {
    const ff3Key = required("ff3_key");
    const ff3Tweak = required("ff3_tweak");
    const routeDigit = required("route_digit");
    fixedCache = { ff3Key, ff3Tweak, routeDigit, fingerprint: ff3Fingerprint(ff3Key, ff3Tweak, routeDigit) };
  }
  return fixedCache;
}

export const keys = {
  get ff3Key() {
    return fixed().ff3Key;
  },
  get ff3Tweak() {
    return fixed().ff3Tweak;
  },
  get routeDigit() {
    return fixed().routeDigit;
  },
  get installationId() {
    return required("installation_id");
  },
  get fingerprint() {
    return fixed().fingerprint;
  },
  decryptKey: () => secretStore.get("decrypt_key") ?? "",
  cabinetUser: () => secretStore.get("cabinet_user") ?? "admin",
  cabinetPassword: () => secretStore.get("cabinet_password") ?? "",
  clientPrefix: () => secretStore.get("client_prefix"),
};

export type KeyCheck = { checked: number; mismatched: number };

export function checkKeysAgainstBase(encrypt: (real: string) => string, looksLikeToken: (value: string) => boolean, sample = 20): KeyCheck {
  const digits = (v: string) => v.replace(/\D/g, "");
  let checked = 0;
  let mismatched = 0;
  for (const row of sampleTokenPairs(sample * 5)) {
    if (checked >= sample) break;
    if (!looksLikeToken(row.token) || digits(row.token) === digits(row.real)) continue;
    checked += 1;
    let token: string;
    try {
      token = encrypt(row.real);
    } catch {
      mismatched += 1;
      continue;
    }
    if (digits(token) !== digits(row.token)) mismatched += 1;
  }
  return { checked, mismatched };
}

export function writeSharedDecryptKey(): string | null {
  if (!config.sharedDir) return null;
  mkdirSync(config.sharedDir, { recursive: true });
  const path = join(config.sharedDir, "decrypt.key");
  writeFileSync(path, keys.decryptKey(), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
