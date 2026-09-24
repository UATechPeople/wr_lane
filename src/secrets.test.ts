import { describe, expect, test } from "bun:test";
import { DEFAULT_FF3_TWEAK, ff3Fingerprint, FrozenSecretConflict, MissingFrozenSecret, resolveSecrets, type SecretName, type SecretStore } from "./secrets";

function memoryStore(initial: Partial<Record<SecretName, string>> = {}) {
  const data = new Map<SecretName, string>(Object.entries(initial) as [SecretName, string][]);
  const store: SecretStore = {
    get: (n) => data.get(n) ?? null,
    setIfAbsent: (n, v) => {
      if (!data.has(n)) data.set(n, v);
      return data.get(n)!;
    },
  };
  return { store, data };
}

const LEGACY_ENV = {
  FF3_KEY: "EF4359D8D580AA4F7F036D6F04FC6A94",
  FF3_TWEAK: "D8E7920AFA330A73",
  DECRYPT_KEY: "0123456789abcdef0123456789abcdef",
  CABINET_PASSWORD: "legacy-password",
  CLIENT_PREFIX: "123000",
};

describe("cabinet secrets", () => {
  test("a fresh cabinet generates its own keys and keeps them", () => {
    const { store, data } = memoryStore();
    const first = resolveSecrets(store, {});
    expect(first.generated).toContain("ff3_key");
    expect(first.values.ff3_key).toMatch(/^[0-9A-F]{32}$/);
    expect(first.values.ff3_tweak).toBe(DEFAULT_FF3_TWEAK);
    expect(first.values.route_digit).toBe("9");
    expect(first.values.cabinet_user).toBe("admin");
    expect(first.values.cabinet_password!.length).toBeGreaterThanOrEqual(16);
    expect(first.values.client_prefix).toBeUndefined();
    expect(data.has("client_prefix")).toBe(false);

    const second = resolveSecrets(store, {});
    expect(second.generated).toEqual([]);
    expect(second.values).toEqual(first.values);
  });

  test("an upgraded 0.3.1 cabinet imports the keys it already had instead of generating new ones", () => {
    const { store } = memoryStore();
    const result = resolveSecrets(store, LEGACY_ENV);
    expect(result.values.ff3_key).toBe(LEGACY_ENV.FF3_KEY);
    expect(result.values.decrypt_key).toBe(LEGACY_ENV.DECRYPT_KEY);
    expect(result.values.cabinet_password).toBe(LEGACY_ENV.CABINET_PASSWORD);
    expect(result.values.client_prefix).toBe("123000");
    expect(result.imported).toEqual(expect.arrayContaining(["ff3_key", "ff3_tweak", "decrypt_key", "cabinet_password", "client_prefix"]));
    expect(result.generated).not.toContain("ff3_key");
  });

  test("the same values in env after the import are accepted, whatever the hex case", () => {
    const { store } = memoryStore();
    resolveSecrets(store, LEGACY_ENV);
    const again = resolveSecrets(store, { ...LEGACY_ENV, FF3_KEY: LEGACY_ENV.FF3_KEY.toLowerCase() });
    expect(again.ignoredEnv).toEqual([]);
  });

  test("a different FF3 key in env stops the cabinet and nothing is written", () => {
    const { store, data } = memoryStore({ ff3_key: LEGACY_ENV.FF3_KEY, ff3_tweak: DEFAULT_FF3_TWEAK, route_digit: "9" });
    const before = new Map(data);
    expect(() => resolveSecrets(store, { FF3_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).toThrow(FrozenSecretConflict);
    expect(data).toEqual(before);
  });

  test("a different tweak or route digit is refused too", () => {
    const { store } = memoryStore({ ff3_key: LEGACY_ENV.FF3_KEY, ff3_tweak: DEFAULT_FF3_TWEAK, route_digit: "9" });
    expect(() => resolveSecrets(store, { FF3_TWEAK: "0000000000000000" })).toThrow(/FF3_TWEAK/);
    expect(() => resolveSecrets(store, { ROUTE_DIGIT: "7" })).toThrow(/ROUTE_DIGIT/);
  });

  test("a changed password in env is ignored in favour of the stored one and reported", () => {
    const { store } = memoryStore();
    resolveSecrets(store, LEGACY_ENV);
    const again = resolveSecrets(store, { ...LEGACY_ENV, CABINET_PASSWORD: "another-password" });
    expect(again.values.cabinet_password).toBe(LEGACY_ENV.CABINET_PASSWORD);
    expect(again.ignoredEnv).toEqual(["cabinet_password"]);
  });

  test("a cabinet that already holds numbers never generates a new FF3 key", () => {
    const { store, data } = memoryStore();
    expect(() => resolveSecrets(store, {}, "unfrozen")).toThrow(MissingFrozenSecret);
    expect(data.has("ff3_key")).toBe(false);
  });

  test("with numbers present the legacy tweak and route digit defaults still apply and other secrets are generated", () => {
    const { store } = memoryStore();
    const result = resolveSecrets(store, { FF3_KEY: LEGACY_ENV.FF3_KEY }, "unfrozen");
    expect(result.values.ff3_tweak).toBe(DEFAULT_FF3_TWEAK);
    expect(result.values.route_digit).toBe("9");
    expect(result.generated).toContain("decrypt_key");
  });

  test("an import writes only what it was given plus the legacy defaults", () => {
    const { store, data } = memoryStore();
    const result = resolveSecrets(store, { FF3_KEY: LEGACY_ENV.FF3_KEY, DECRYPT_KEY: LEGACY_ENV.DECRYPT_KEY }, "none");
    expect(result.imported.sort()).toEqual(["decrypt_key", "ff3_key"]);
    expect(data.get("ff3_tweak")).toBe(DEFAULT_FF3_TWEAK);
    expect(data.has("cabinet_password")).toBe(false);
    expect(data.has("installation_id")).toBe(false);
  });

  test("when two processes race, the value written first wins and is reported", () => {
    const { store, data } = memoryStore();
    const racing: SecretStore = {
      get: (n) => (n === "decrypt_key" ? null : store.get(n)),
      setIfAbsent: (n, v) => {
        if (n === "decrypt_key" && !data.has(n)) data.set(n, "written-by-the-other-process");
        return store.setIfAbsent(n, v);
      },
    };
    expect(resolveSecrets(racing, {}).values.decrypt_key).toBe("written-by-the-other-process");
  });

  test("a malformed key in env is refused rather than stored", () => {
    const { store, data } = memoryStore();
    expect(() => resolveSecrets(store, { FF3_KEY: "not-hex" })).toThrow(/FF3_KEY/);
    expect(data.size).toBe(0);
  });

  test("the fingerprint changes with any part of the token format and never shows the key", () => {
    const base = ff3Fingerprint(LEGACY_ENV.FF3_KEY, DEFAULT_FF3_TWEAK, "9");
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(ff3Fingerprint(LEGACY_ENV.FF3_KEY.toLowerCase(), DEFAULT_FF3_TWEAK, "9")).toBe(base);
    expect(ff3Fingerprint(LEGACY_ENV.FF3_KEY, DEFAULT_FF3_TWEAK, "8")).not.toBe(base);
    expect(ff3Fingerprint(LEGACY_ENV.FF3_KEY, "0000000000000000", "9")).not.toBe(base);
    expect(base).not.toContain(LEGACY_ENV.FF3_KEY.slice(0, 8).toLowerCase());
  });
});
