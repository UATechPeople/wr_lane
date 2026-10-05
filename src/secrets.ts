import { createHash, randomBytes, randomUUID } from "crypto";

export type SecretName =
  | "ff3_key"
  | "ff3_tweak"
  | "route_digit"
  | "decrypt_key"
  | "cabinet_user"
  | "cabinet_password"
  | "client_prefix"
  | "installation_id";

type Spec = {
  env: string | null;
  frozen: boolean;
  legacyDefault?: boolean;
  valid: (value: string) => boolean;
  initial: () => string | null;
};

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

function password(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(randomBytes(16), (b) => alphabet[b % alphabet.length]).join("");
}

export const DEFAULT_FF3_TWEAK = "D8E7920AFA330A73";

export const SECRET_SPECS: Record<SecretName, Spec> = {
  ff3_key: {
    env: "FF3_KEY",
    frozen: true,
    valid: (v) => /^([0-9A-Fa-f]{32}|[0-9A-Fa-f]{48}|[0-9A-Fa-f]{64})$/.test(v),
    initial: () => hex(16).toUpperCase(),
  },
  ff3_tweak: {
    env: "FF3_TWEAK",
    frozen: true,
    legacyDefault: true,
    valid: (v) => /^([0-9A-Fa-f]{14}|[0-9A-Fa-f]{16})$/.test(v),
    initial: () => DEFAULT_FF3_TWEAK,
  },
  route_digit: { env: "ROUTE_DIGIT", frozen: true, legacyDefault: true, valid: (v) => /^[1-9]$/.test(v), initial: () => "9" },
  decrypt_key: { env: "DECRYPT_KEY", frozen: false, valid: (v) => v.length >= 16, initial: () => hex(24) },
  cabinet_user: { env: "CABINET_USER", frozen: false, valid: (v) => /^[\w.@-]{1,64}$/.test(v), initial: () => "admin" },
  cabinet_password: { env: "CABINET_PASSWORD", frozen: false, valid: (v) => v.length >= 8, initial: password },
  client_prefix: { env: "CLIENT_PREFIX", frozen: false, valid: (v) => /^\d{1,12}$/.test(v), initial: () => null },
  installation_id: { env: null, frozen: false, valid: (v) => /^[0-9a-f-]{36}$/.test(v), initial: () => randomUUID() },
};

export type SecretStore = { get: (name: SecretName) => string | null; setIfAbsent: (name: SecretName, value: string) => string };

export type GenerateMode = "all" | "unfrozen" | "none";

export type ResolvedSecrets = {
  values: Partial<Record<SecretName, string>>;
  imported: SecretName[];
  generated: SecretName[];
  ignoredEnv: SecretName[];
};

export class FrozenSecretConflict extends Error {
  constructor(readonly names: SecretName[]) {
    super(
      `${names.map((n) => SECRET_SPECS[n].env).join(", ")} in the environment differ from the values this cabinet already uses. ` +
        "Changing them would make every token already issued undecryptable. Remove them from the environment or restore the original values.",
    );
  }
}

export class MissingFrozenSecret extends Error {
  constructor(readonly names: SecretName[]) {
    super(
      `${names.map((n) => SECRET_SPECS[n].env).join(", ")} ${names.length === 1 ? "is" : "are"} not set, but this cabinet already holds numbers encrypted with the old key. ` +
        "Import the keys of the previous installation instead of generating new ones.",
    );
  }
}

export function resolveSecrets(store: SecretStore, env: Record<string, string | undefined>, generate: GenerateMode = "all"): ResolvedSecrets {
  const result: ResolvedSecrets = { values: {}, imported: [], generated: [], ignoredEnv: [] };
  const conflicts: SecretName[] = [];
  const missing: SecretName[] = [];
  const pending: Array<[SecretName, string]> = [];

  for (const name of Object.keys(SECRET_SPECS) as SecretName[]) {
    const spec = SECRET_SPECS[name];
    const stored = store.get(name);
    const fromEnv = spec.env ? env[spec.env]?.trim() || null : null;
    if (fromEnv !== null && !spec.valid(fromEnv)) {
      throw new Error(`${spec.env} has an invalid value`);
    }
    if (stored !== null) {
      result.values[name] = stored;
      if (fromEnv !== null && !sameSecret(name, fromEnv, stored)) {
        if (spec.frozen) conflicts.push(name);
        else result.ignoredEnv.push(name);
      }
      continue;
    }
    if (fromEnv !== null) {
      pending.push([name, fromEnv]);
      result.imported.push(name);
      result.values[name] = fromEnv;
      continue;
    }
    const allowed = generate === "all" || spec.legacyDefault === true || (generate === "unfrozen" && !spec.frozen);
    if (!allowed) {
      if (spec.frozen && generate === "unfrozen") missing.push(name);
      continue;
    }
    const initial = spec.initial();
    if (initial === null) continue;
    pending.push([name, initial]);
    result.generated.push(name);
    result.values[name] = initial;
  }

  if (conflicts.length > 0) throw new FrozenSecretConflict(conflicts);
  if (missing.length > 0) throw new MissingFrozenSecret(missing);
  for (const [name, value] of pending) result.values[name] = store.setIfAbsent(name, value);
  return result;
}

function sameSecret(name: SecretName, a: string, b: string): boolean {
  if (name === "ff3_key" || name === "ff3_tweak") return a.toUpperCase() === b.toUpperCase();
  return a === b;
}

export function ff3Fingerprint(key: string, tweak: string, routeDigit: string): string {
  return createHash("sha256").update(`${key.toUpperCase()}|${tweak.toUpperCase()}|${routeDigit}`).digest("hex").slice(0, 16);
}
