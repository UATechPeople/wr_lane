import FF3Cipher from "ff3/lib/FF3Cipher";
import { keys } from "./keys";

const MIN_LEN = 8;
const MAX_LEN = 13;
const BODY_WIDTH = 13;
const CT_WIDTH = 14;

let cipherCache: FF3Cipher | null = null;

function cipher(): FF3Cipher {
  cipherCache ??= new FF3Cipher(keys.ff3Key, keys.ff3Tweak, 10);
  return cipherCache;
}

export function resetCipher(): void {
  cipherCache = null;
}

export type FpeKeys = { ff3Key: string; ff3Tweak: string; routeDigit: string };

export function encryptPhoneWith(e164: string, candidate: FpeKeys): string {
  return encryptWith(e164, new FF3Cipher(candidate.ff3Key, candidate.ff3Tweak, 10), candidate.routeDigit);
}

export function encryptPhone(e164: string): string {
  return encryptWith(e164, cipher(), keys.routeDigit);
}

function encryptWith(e164: string, ff3: FF3Cipher, routeDigit: string): string {
  const d = e164.replace(/\D/g, "");
  if (d.length < MIN_LEN || d.length > MAX_LEN) {
    throw new Error(`phone must have ${MIN_LEN}-${MAX_LEN} digits, got ${d.length}`);
  }
  const lenCode = String(d.length - MIN_LEN);
  const body = d.padStart(BODY_WIDTH, "0");
  const plaintext = lenCode + body;
  const ciphertext = ff3.encrypt(plaintext);
  return "+" + routeDigit + ciphertext;
}

export function decryptToken(token: string): string {
  const t = token.replace(/\D/g, "");
  if (t.length !== 1 + CT_WIDTH) {
    throw new Error(`bad token length: expected ${1 + CT_WIDTH} digits, got ${t.length}`);
  }
  const ciphertext = t.slice(1);
  const plaintext = cipher().decrypt(ciphertext);
  const len = Number(plaintext[0]) + MIN_LEN;
  if (!Number.isInteger(len) || len < MIN_LEN || len > MAX_LEN) {
    throw new Error("token does not belong to this cabinet");
  }
  const body = plaintext.slice(1);
  const real = body.slice(BODY_WIDTH - len);
  return "+" + real;
}

export function looksLikeToken(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  return digits.length === 15 && digits.startsWith(keys.routeDigit);
}
