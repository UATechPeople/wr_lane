import { randomBytes } from "crypto";
import { countNumbers, getSetting, setSetting } from "./db";
import { encryptPhoneWith, resetCipher, type FpeKeys } from "./fpe";
import { DECRYPT_KEY_PREV } from "./internal";
import { checkKeysAgainstBase, keys, resetKeysCache, writeSharedDecryptKey } from "./keys";
import { SECRET_SPECS, type SecretName } from "./secrets";
import { getTelephony, TRUNK_MODES } from "./telephony";

function validated(name: SecretName, value: string): string {
  const trimmed = value.trim();
  if (!SECRET_SPECS[name].valid(trimmed)) throw new Error(`${SECRET_SPECS[name].env} has an invalid value`);
  return trimmed;
}

export function encryptionKeysInfo() {
  return { ff3Key: keys.ff3Key, ff3Tweak: keys.ff3Tweak, routeDigit: keys.routeDigit, fingerprint: keys.fingerprint, numbers: countNumbers() };
}

export function changeEncryptionKeys(input: FpeKeys | "generate") {
  const numbers = countNumbers();
  if (input === "generate") {
    if (numbers > 0) throw new Error(`${numbers} numbers are encrypted with the current key; new random keys would leave their tokens undecryptable`);
    input = { ff3Key: randomBytes(16).toString("hex").toUpperCase(), ff3Tweak: randomBytes(8).toString("hex").toUpperCase(), routeDigit: keys.routeDigit };
  }
  const candidate: FpeKeys = {
    ff3Key: validated("ff3_key", input.ff3Key).toUpperCase(),
    ff3Tweak: validated("ff3_tweak", input.ff3Tweak).toUpperCase(),
    routeDigit: validated("route_digit", input.routeDigit),
  };
  if (numbers > 0) {
    const check = checkKeysAgainstBase(
      (real) => encryptPhoneWith(real, candidate),
      (token) => {
        const digits = token.replace(/\D/g, "");
        return digits.length === 15 && digits.startsWith(keys.routeDigit);
      },
    );
    if (check.mismatched > 0) {
      throw new Error(`these keys do not decrypt the ${numbers} numbers already in the cabinet; enter the keys they were encrypted with`);
    }
  }
  setSetting("secret.ff3_key", candidate.ff3Key);
  setSetting("secret.ff3_tweak", candidate.ff3Tweak);
  setSetting("secret.route_digit", candidate.routeDigit);
  resetKeysCache();
  resetCipher();
  return encryptionKeysInfo();
}

export function changeLogin(user: string, password: string): void {
  const nextUser = validated("cabinet_user", user);
  const nextPassword = validated("cabinet_password", password);
  setSetting("secret.cabinet_user", nextUser);
  setSetting("secret.cabinet_password", nextPassword);
}

export function changeDecryptKey(value?: string): string {
  const next = value === undefined ? randomBytes(24).toString("hex") : validated("decrypt_key", value);
  const current = keys.decryptKey();
  if (next === current) return current;
  if (getSetting(DECRYPT_KEY_PREV) === null && current) setSetting(DECRYPT_KEY_PREV, current);
  setSetting("secret.decrypt_key", next);
  writeSharedDecryptKey();
  return next;
}

export function decryptKeyPending(): boolean {
  return getSetting(DECRYPT_KEY_PREV) !== null;
}

export function exportKeysEnv(): string {
  const lines = [
    `FF3_KEY=${keys.ff3Key}`,
    `FF3_TWEAK=${keys.ff3Tweak}`,
    `ROUTE_DIGIT=${keys.routeDigit}`,
    `DECRYPT_KEY=${keys.decryptKey()}`,
    `CABINET_USER=${keys.cabinetUser()}`,
    `CABINET_PASSWORD=${keys.cabinetPassword()}`,
    ...(keys.clientPrefix() ? [`CLIENT_PREFIX=${keys.clientPrefix()}`] : []),
  ];
  const state = getTelephony();
  for (const mode of TRUNK_MODES) {
    const m = state.modes[mode] as { key: string; host: string; port: number; prefix?: string; user?: string; pass?: string } | undefined;
    if (!m) continue;
    const M = mode.toUpperCase();
    lines.push(`TRUNK_${M}_API_KEY=${m.key}`, `TRUNK_${M}_HOST=${m.host}`, `TRUNK_${M}_PORT=${m.port}`);
    if (m.prefix) lines.push(`TRUNK_${M}_PREFIX=${m.prefix}`);
    if (m.user) lines.push(`TRUNK_${M}_USER=${m.user}`);
    if (m.pass) lines.push(`TRUNK_${M}_PASS=${m.pass}`);
  }
  return lines.join("\n");
}
