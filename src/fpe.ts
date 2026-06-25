import FF3Cipher from "ff3/lib/FF3Cipher";
import { config } from "./config";

// Format-preserving encryption (NIST SP 800-38G FF3-1), radix 10.
//
// Token layout (ALWAYS 15 digits -> valid E.164, fixed length so the real number's
// length never leaks):
//
//   +  <routeDigit:1>  <FF3 ciphertext:14>
//
// FF3 plaintext (14 digits) encodes the real number losslessly:
//
//   <lenCode:1> <body:13>
//     lenCode = realLen - MIN_LEN          (one digit, 0..5)
//     body    = real digits, left-padded with '0' to 13
//
// Supported real significant length: 8..13 digits — covers every real-world E.164.
// (E.164's theoretical 15-digit max minus the fixed-width budget; reject longer.)
//
// FF3-1 is a bijection over the 14-digit domain, so:
//   - distinct real -> distinct token (no collisions)
//   - same real -> same token (deterministic: enables dedup / DNC on the WR side)
//   - the token reveals nothing about the real digits (key stays client-side only)

const MIN_LEN = 8;
const MAX_LEN = 13;
const BODY_WIDTH = 13;
const CT_WIDTH = 14;

const cipher = new FF3Cipher(config.ff3Key, config.ff3Tweak, 10);

export function encryptPhone(e164: string): string {
  const d = e164.replace(/\D/g, "");
  if (d.length < MIN_LEN || d.length > MAX_LEN) {
    throw new Error(`phone must have ${MIN_LEN}-${MAX_LEN} digits, got ${d.length}`);
  }
  const lenCode = String(d.length - MIN_LEN);
  const body = d.padStart(BODY_WIDTH, "0");
  const plaintext = lenCode + body;
  const ciphertext = cipher.encrypt(plaintext);
  return "+" + config.routeDigit + ciphertext;
}

export function decryptToken(token: string): string {
  const t = token.replace(/\D/g, "");
  if (t.length !== 1 + CT_WIDTH) {
    throw new Error(`bad token length: expected ${1 + CT_WIDTH} digits, got ${t.length}`);
  }
  const ciphertext = t.slice(1);
  const plaintext = cipher.decrypt(ciphertext);
  const len = Number(plaintext[0]) + MIN_LEN;
  const body = plaintext.slice(1);
  const real = body.slice(BODY_WIDTH - len);
  return "+" + real;
}
