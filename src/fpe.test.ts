import { expect, test, describe } from "bun:test";

process.env.FF3_KEY ??= "EF4359D8D580AA4F7F036D6F04FC6A94";
process.env.FF3_TWEAK ??= "D8E7920AFA330A73";
process.env.DECRYPT_KEY ??= "test-decrypt-key";

const { encryptPhone, decryptToken } = await import("./fpe");

const SAMPLES = ["+380501112233", "+15551234567", "+447911123456", "+4915123456789", "+12025550199"];

describe("FF3 phone tokenization", () => {
  test("round-trips every sample", () => {
    for (const real of SAMPLES) {
      expect(decryptToken(encryptPhone(real))).toBe(real);
    }
  });

  test("is deterministic (same real -> same token)", () => {
    for (const real of SAMPLES) {
      expect(encryptPhone(real)).toBe(encryptPhone(real));
    }
  });

  test("token is a valid E.164 string accepted by WinRiders' regex", () => {
    const wr = /^\+[1-9]\d{1,14}$/;
    for (const real of SAMPLES) {
      expect(wr.test(encryptPhone(real))).toBe(true);
    }
  });

  test("token length is constant (real length never leaks)", () => {
    const lens = new Set(SAMPLES.map((r) => encryptPhone(r).length));
    expect(lens.size).toBe(1);
  });

  test("distinct reals -> distinct tokens", () => {
    const tokens = SAMPLES.map(encryptPhone);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  test("rejects out-of-range lengths", () => {
    expect(() => encryptPhone("+1234567")).toThrow();
    expect(() => encryptPhone("+123456789012345")).toThrow();
  });
});
