import { beforeEach, describe, expect, test } from "bun:test";
import { allRecords, deleteNumber, deleteSetting, getSetting, insertNumbers, uploadIdByLabel } from "./db";
import { encryptPhone } from "./fpe";
import { internalFetch } from "./internal";
import { changeDecryptKey, changeEncryptionKeys, changeLogin, encryptionKeysInfo, exportKeysEnv } from "./key-settings";
import { keys } from "./keys";
import { setCarrier } from "./telephony";

const ORIGINAL = { ff3Key: keys.ff3Key, ff3Tweak: keys.ff3Tweak, routeDigit: keys.routeDigit };

function restoreOriginal() {
  for (const row of allRecords()) deleteNumber(row.id);
  changeEncryptionKeys(ORIGINAL);
}

const internal = (key: string) =>
  internalFetch(new Request("http://cabinet:3501/config/kamailio", { headers: { "x-decrypt-key": key } })).status;

describe("key settings", () => {
  beforeEach(() => {
    restoreOriginal();
    deleteSetting("decrypt_key_prev");
  });

  test("encryption keys can be filled in from scratch while the base is empty, and the tokens follow them", () => {
    const fresh = { ff3Key: "0123456789ABCDEF0123456789ABCDEF", ff3Tweak: "0011223344556677", routeDigit: "7" };
    const info = changeEncryptionKeys(fresh);
    expect(info).toMatchObject(fresh);
    expect(keys.ff3Key).toBe(fresh.ff3Key);
    expect(encryptPhone("+491512345678").startsWith("+7")).toBe(true);
    const generated = changeEncryptionKeys("generate");
    expect(generated.ff3Key).not.toBe(fresh.ff3Key);
    expect(generated.ff3Key).toMatch(/^[0-9A-F]{32}$/);
    expect(() => changeEncryptionKeys({ ff3Key: "xyz", ff3Tweak: fresh.ff3Tweak, routeDigit: "7" })).toThrow(/FF3_KEY/);
    expect(() => changeEncryptionKeys({ ...fresh, routeDigit: "0" })).toThrow(/ROUTE_DIGIT/);
  });

  test("with numbers in the base only the keys that decrypt them are accepted", () => {
    const uploadId = uploadIdByLabel("key-settings");
    insertNumbers(uploadId, [{ real: "+491512345678", token: encryptPhone("+491512345678") }]);
    expect(() => changeEncryptionKeys("generate")).toThrow(/numbers/);
    expect(() => changeEncryptionKeys({ ...ORIGINAL, ff3Key: "0123456789ABCDEF0123456789ABCDEF" })).toThrow(/do not decrypt/);
    expect(changeEncryptionKeys({ ...ORIGINAL }).fingerprint).toBe(encryptionKeysInfo().fingerprint);
  });

  test("login and password change together and are validated", () => {
    changeLogin("operator", "a-long-password");
    expect(keys.cabinetUser()).toBe("operator");
    expect(keys.cabinetPassword()).toBe("a-long-password");
    expect(() => changeLogin("bad user", "a-long-password")).toThrow();
    expect(() => changeLogin("operator", "short")).toThrow();
  });

  test("a new decrypt key is accepted at once and the previous one until the SIP proxy shows up with the new one", () => {
    const before = keys.decryptKey();
    const next = changeDecryptKey();
    expect(next).not.toBe(before);
    expect(internal(before)).toBe(200);
    expect(getSetting("decrypt_key_prev")).toBe(before);
    expect(internal(next)).toBe(200);
    expect(getSetting("decrypt_key_prev")).toBeNull();
    expect(internal(before)).toBe(401);
    expect(() => changeDecryptKey("short")).toThrow();
  });

  test("the export holds every key needed to rebuild this cabinet, including the trunk keys", () => {
    setCarrier("ipauth", { host: "5.129.228.77" }, "wr_0000test0000key0000test0000key");
    const env = exportKeysEnv();
    expect(env).toContain(`FF3_KEY=${keys.ff3Key}`);
    expect(env).toContain(`FF3_TWEAK=${keys.ff3Tweak}`);
    expect(env).toContain(`ROUTE_DIGIT=${keys.routeDigit}`);
    expect(env).toContain(`DECRYPT_KEY=${keys.decryptKey()}`);
    expect(env).toContain(`CABINET_PASSWORD=${keys.cabinetPassword()}`);
    expect(env).toContain("TRUNK_IPAUTH_API_KEY=wr_0000test0000key0000test0000key");
    expect(env).toContain("TRUNK_IPAUTH_HOST=5.129.228.77");
  });
});
