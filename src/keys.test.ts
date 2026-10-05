import { describe, expect, test } from "bun:test";
import { insertNumbers, uploadIdByLabel } from "./db";
import { encryptPhone, looksLikeToken } from "./fpe";
import { checkKeysAgainstBase, keys } from "./keys";

describe("key check against the stored base", () => {
  test("tokens made with the current key pass and a token from another key is caught", () => {
    const phones = ["+4915112340001", "+4915112340002", "+4915112340003"];
    insertNumbers(
      uploadIdByLabel("key-check"),
      phones.map((real) => ({ real, token: encryptPhone(real) })),
    );
    expect(checkKeysAgainstBase(encryptPhone, looksLikeToken)).toMatchObject({ mismatched: 0 });

    const foreign = `+${keys.routeDigit}12345678901234`;
    insertNumbers(uploadIdByLabel("key-check"), [{ real: "+4915112340009", token: foreign }]);
    const check = checkKeysAgainstBase(encryptPhone, looksLikeToken);
    expect(check.checked).toBeGreaterThan(0);
    expect(check.mismatched).toBe(1);
  });

  test("the fingerprint is stable and does not reveal the key", () => {
    expect(keys.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(keys.fingerprint).toBe(keys.fingerprint);
    expect(keys.fingerprint).not.toContain(keys.ff3Key.slice(0, 6).toLowerCase());
  });
});
