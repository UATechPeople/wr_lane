import { expect, test, describe } from "bun:test";
import { rmSync } from "node:fs";

process.env.FF3_KEY ??= "EF4359D8D580AA4F7F036D6F04FC6A94";
process.env.DECRYPT_KEY ??= "test-decrypt-key";
process.env.DB_PATH = "/tmp/hn-proxy-test.sqlite";
rmSync(process.env.DB_PATH, { force: true });

const { resultForOutcome } = await import("./status");
const { buildBody, crmConfigSchema, DEFAULT_CRM_CONFIG, resolveCrmUrl, isWebhookId } = await import("./webhook");
const { backoffSeconds } = await import("./outbox");
const { outboxEnqueue, outboxClaim, outboxMarkDelivered, insertNumbers, uploadIdByLabel, getByToken } = await import("./db");
const { normalizeUserId } = await import("./hooks");
const { getWrConfig, saveWrConfig } = await import("./webhook");
const { getSetting } = await import("./db");
const { looksLikeToken, encryptPhone } = await import("./fpe");
const { pushRecords } = await import("./platform");
const { wrConfigSchema, DEFAULT_WR_FIELDS } = await import("./webhook");

const FACTS = {
  phone: "+447700900123",
  token: "+940612579184136",
  user_id: "12345",
  result: "send_sms",
  outcome: "agreed",
  attempts: 2,
  lead_id: "lead-1",
  campaign_id: "camp-1",
  event: "call.finished",
  sent_at: "2026-08-26T10:00:00Z",
};

describe("outcome mapping", () => {
  test("maps every status the client asked for", () => {
    expect(resultForOutcome("agreed")).toBe("send_sms");
    expect(resultForOutcome("interested")).toBe("send_sms");
    expect(resultForOutcome("no_answer")).toBe("no_answer");
    expect(resultForOutcome("voicemail")).toBe("voicemail");
    expect(resultForOutcome("busy")).toBe("busy");
    expect(resultForOutcome("short_call")).toBe("hang_up");
    expect(resultForOutcome("rejected")).toBe("hang_up");
    expect(resultForOutcome("not_interested")).toBe("not_interested");
    expect(resultForOutcome("declined")).toBe("not_interested");
    expect(resultForOutcome("telephony_failure")).toBe("failed_call");
    expect(resultForOutcome("dnc")).toBe("blacklist");
    expect(resultForOutcome("self_excluded")).toBe("blacklist");
  });

  test("returns null for outcomes we deliberately do not forward", () => {
    expect(resultForOutcome("callback_missed")).toBeNull();
    expect(resultForOutcome("outside_window")).toBeNull();
    expect(resultForOutcome(null)).toBeNull();
    expect(resultForOutcome(undefined)).toBeNull();
  });
});

describe("crm body composition", () => {
  test("emits exactly the keys the client configured", () => {
    const config = crmConfigSchema.parse({
      url: "https://crm.example/hook",
      fields: [
        { as: "user", from: "phone" },
        { as: "client_id", from: "user_id" },
        { as: "status", from: "result" },
      ],
    });
    expect(buildBody(config, FACTS)).toEqual({ user: "+447700900123", client_id: "12345", status: "send_sms" });
  });

  test("sends the decrypted number, never the token, unless the token is asked for", () => {
    const config = crmConfigSchema.parse({ url: "https://crm.example/hook", fields: [{ as: "user", from: "phone" }] });
    expect(buildBody(config, FACTS).user).toBe(FACTS.phone);
    expect(JSON.stringify(buildBody(config, FACTS))).not.toContain(FACTS.token);
  });

  test("missing facts become null rather than dropping the key", () => {
    const config = crmConfigSchema.parse({ url: "https://crm.example/hook", fields: [{ as: "uid", from: "user_id" }] });
    expect(buildBody(config, { ...FACTS, user_id: null })).toEqual({ uid: null });
  });

  test("rejects an unknown source field", () => {
    expect(() => crmConfigSchema.parse({ url: "https://crm.example/hook", fields: [{ as: "x", from: "secret_key" }] })).toThrow();
  });

  test("every source field is addressable and lands under its own key", () => {
    const config = crmConfigSchema.parse({
      url: "https://crm.example/hook",
      fields: [
        { as: "a", from: "phone" },
        { as: "b", from: "token" },
        { as: "c", from: "user_id" },
        { as: "d", from: "result" },
        { as: "e", from: "outcome" },
        { as: "f", from: "attempts" },
        { as: "g", from: "lead_id" },
        { as: "h", from: "campaign_id" },
        { as: "i", from: "event" },
        { as: "j", from: "sent_at" },
      ],
    });
    expect(buildBody(config, FACTS)).toEqual({
      a: FACTS.phone,
      b: FACTS.token,
      c: FACTS.user_id,
      d: FACTS.result,
      e: FACTS.outcome,
      f: FACTS.attempts,
      g: FACTS.lead_id,
      h: FACTS.campaign_id,
      i: FACTS.event,
      j: FACTS.sent_at,
    });
  });

  test("one source can feed several keys", () => {
    const config = crmConfigSchema.parse({
      url: "https://crm.example/hook",
      fields: [
        { as: "phone", from: "phone" },
        { as: "msisdn", from: "phone" },
      ],
    });
    expect(buildBody(config, FACTS)).toEqual({ phone: FACTS.phone, msisdn: FACTS.phone });
  });

  test("an empty mapping sends an empty body rather than leaking defaults", () => {
    const config = crmConfigSchema.parse({ url: "https://crm.example/hook", fields: [] });
    expect(buildBody(config, FACTS)).toEqual({});
  });

  test("a repeated key keeps the last mapping and does not throw", () => {
    const config = crmConfigSchema.parse({
      url: "https://crm.example/hook",
      fields: [
        { as: "v", from: "phone" },
        { as: "v", from: "result" },
      ],
    });
    expect(buildBody(config, FACTS)).toEqual({ v: FACTS.result });
  });

  test("rejects a malformed url, an oversized mapping and a blank key", () => {
    expect(() => crmConfigSchema.parse({ url: "not-a-url" })).toThrow();
    expect(() =>
      crmConfigSchema.parse({
        url: "https://crm.example/hook",
        fields: Array.from({ length: 33 }, (_, i) => ({ as: `k${i}`, from: "phone" })),
      }),
    ).toThrow();
    expect(() => crmConfigSchema.parse({ url: "https://crm.example/hook", fields: [{ as: "", from: "phone" }] })).toThrow();
  });

  test("default config ships a usable mapping", () => {
    expect(DEFAULT_CRM_CONFIG.fields.map((f) => f.as)).toEqual(["user", "user_id", "result"]);
    expect(DEFAULT_CRM_CONFIG.url).toBe("");
  });
});

describe("delivery backoff", () => {
  test("grows exponentially from 30s and caps at an hour", () => {
    expect(backoffSeconds(0)).toBe(30);
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(120);
    expect(backoffSeconds(20)).toBe(3600);
  });
});

describe("outbox claim", () => {
  const run = String(Date.now());
  let n = 0;

  const seed = (): { id: number; key: string } => {
    n += 1;
    const suffix = String(n).padStart(3, "0");
    const token = `+9${run.slice(-11)}${suffix}`;
    insertNumbers(uploadIdByLabel("test batch"), [{ real: `+38${run.slice(-9)}${suffix}`, token }]);
    const row = getByToken(token);
    const key = `${run}-${suffix}`;
    outboxEnqueue(row!.id, key, { user: row!.real });
    return { id: row!.id, key };
  };

  test("a second concurrent drain sees nothing the first one already took", () => {
    const a = seed();
    const b = seed();
    const first = outboxClaim(100).map((r) => r.dedupe_key);
    const second = outboxClaim(100).map((r) => r.dedupe_key);
    expect(first).toContain(a.key);
    expect(first).toContain(b.key);
    expect(second).not.toContain(a.key);
    expect(second).not.toContain(b.key);
  });

  test("the same result is never queued twice", () => {
    const row = seed();
    const key = `${row.key}-dup`;
    expect(outboxEnqueue(row.id, key, { a: 1 })).toBe(true);
    expect(outboxEnqueue(row.id, key, { a: 1 })).toBe(false);
  });

  test("delivered rows are not claimed again", () => {
    const row = seed();
    const claimed = outboxClaim(100).find((r) => r.dedupe_key === row.key);
    expect(claimed).toBeDefined();
    outboxMarkDelivered(claimed!.id);
    expect(outboxClaim(100, 0).some((r) => r.dedupe_key === row.key)).toBe(false);
  });
});

describe("user_id normalisation", () => {
  test("accepts a string as given", () => {
    expect(normalizeUserId("cust-777")).toEqual({ value: "cust-777" });
  });

  test("accepts a number and stores it as text", () => {
    expect(normalizeUserId(777)).toEqual({ value: "777" });
  });

  test("keeps a zero id instead of treating it as missing", () => {
    expect(normalizeUserId(0)).toEqual({ value: "0" });
  });

  test("absent stays absent", () => {
    expect(normalizeUserId(undefined)).toEqual({});
  });

  test("warns when a numeric id was already rounded by JSON parsing", () => {
    const out = normalizeUserId(12345678901234567890);
    expect(out.value).toBe("12345678901234567000");
    expect(out.warning).toContain("send it as a string");
  });

  test("the same id sent as a string survives intact", () => {
    expect(normalizeUserId("12345678901234567890")).toEqual({ value: "12345678901234567890" });
  });
});

describe("token shape guard", () => {
  test("recognises a token this cabinet issued", () => {
    expect(looksLikeToken(encryptPhone("+447700900123"))).toBe(true);
  });

  test("does not mistake a real number for a token", () => {
    expect(looksLikeToken("+447700900123")).toBe(false);
    expect(looksLikeToken("+15551234567")).toBe(false);
    expect(looksLikeToken("+441234567890")).toBe(false);
  });

  test("rejects anything of the wrong length", () => {
    expect(looksLikeToken("+90097911841136")).toBe(false);
    expect(looksLikeToken("+9009791184113650")).toBe(false);
    expect(looksLikeToken("")).toBe(false);
  });

  test("ignores formatting so a spaced or dashed token still matches", () => {
    const token = encryptPhone("+447700900123");
    const digits = token.replace(/\D/g, "");
    expect(looksLikeToken(`${digits.slice(0, 3)} ${digits.slice(3, 8)}-${digits.slice(8)}`)).toBe(true);
  });
});

describe("outbound leak guard", () => {
  const row = (over: Record<string, unknown>) =>
    ({ id: 1, real: "+447700900123", token: "+447700900123", segment: null, cohort: null, ...over }) as never;

  test("refuses to push a row whose token is really a phone number", async () => {
    const [result] = await pushRecords([row({})]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("refusing to send a real phone number");
  });

  test("refuses when the token equals the real number even if it looks token-shaped", async () => {
    const same = encryptPhone("+447700900123");
    const [result] = await pushRecords([row({ real: same, token: same })]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("refusing to send a real phone number");
  });
});

describe("platform mapping guard", () => {
  const base = { baseUrl: "https://core.example", slug: "s", apiKey: "k", playerSegment: "seg" };

  test("the real phone number is not even an allowed source", () => {
    expect(() =>
      wrConfigSchema.parse({ ...base, fields: [{ as: "external_id", from: "token" }, { as: "phone_e164", from: "phone" }] }),
    ).toThrow();
  });

  test("identity fields refuse any source other than the token", () => {
    expect(() =>
      wrConfigSchema.parse({ ...base, fields: [{ as: "external_id", from: "token" }, { as: "phone_e164", from: "user_id" }] }),
    ).toThrow(/phone_e164 may only carry the token/);
    expect(() =>
      wrConfigSchema.parse({ ...base, fields: [{ as: "external_id", from: "segment" }, { as: "phone_e164", from: "token" }] }),
    ).toThrow(/external_id may only carry the token/);
  });

  test("identity fields cannot be dropped from the mapping", () => {
    expect(() => wrConfigSchema.parse({ ...base, fields: [{ as: "external_id", from: "token" }] })).toThrow(
      /phone_e164 must be mapped/,
    );
  });

  test("a correct mapping saves, and the shipped default is one", () => {
    const parsed = wrConfigSchema.parse({ ...base, fields: DEFAULT_WR_FIELDS });
    expect(parsed.fields).toEqual(DEFAULT_WR_FIELDS);
    expect(DEFAULT_WR_FIELDS.filter((f) => f.as === "external_id" || f.as === "phone_e164").every((f) => f.from === "token")).toBe(true);
  });
});

describe("platform connection seeding", () => {
  test("the first read persists the env values so later env edits are ignored", () => {
    const first = getWrConfig();
    expect(getSetting("wr_connection")).not.toBeNull();

    const stored = JSON.parse(getSetting("wr_connection") as string) as { slug: string };
    expect(stored.slug).toBe(first.slug);
  });

  test("what the operator saves wins over anything the env says", () => {
    saveWrConfig({
      baseUrl: "https://operator.example",
      slug: "operator-slug",
      apiKey: "operator-key",
      playerSegment: "operator-segment",
      fields: [
        { as: "external_id", from: "token" },
        { as: "phone_e164", from: "token" },
      ],
    });
    expect(getWrConfig().slug).toBe("operator-slug");
    expect(getWrConfig().playerSegment).toBe("operator-segment");
  });
});

describe("per-campaign result routing", () => {
  const config = crmConfigSchema.parse({
    url: "https://fallback.example/hook",
    urlTemplate: "https://crm.example.com/hooks/{id}",
  });

  test("builds the address from the webhook id carried by the record", () => {
    expect(resolveCrmUrl(config, "4b3bf9c2afab5dek")).toBe("https://crm.example.com/hooks/4b3bf9c2afab5dek");
  });

  test("falls back to the shared address when the record has no id", () => {
    expect(resolveCrmUrl(config, null)).toBe("https://fallback.example/hook");
  });

  test("refuses an id that could bend the address", () => {
    expect(isWebhookId("../../evil")).toBe(false);
    expect(isWebhookId("host.example/path")).toBe(false);
    expect(isWebhookId("4b3bf9c2afab5dek")).toBe(true);
    expect(resolveCrmUrl(config, "../../evil")).toBe("https://fallback.example/hook");
  });

  test("without a template every record goes to the shared address", () => {
    const plain = crmConfigSchema.parse({ url: "https://fallback.example/hook" });
    expect(resolveCrmUrl(plain, "4b3bf9c2afab5dek")).toBe("https://fallback.example/hook");
  });

  test("a template must be a url carrying the placeholder", () => {
    expect(crmConfigSchema.safeParse({ urlTemplate: "https://crm.example.com/hooks/" }).success).toBe(false);
    expect(crmConfigSchema.safeParse({ urlTemplate: "crm.example.com/{id}" }).success).toBe(false);
    expect(crmConfigSchema.safeParse({ urlTemplate: "https://crm.example.com/hooks/{id}" }).success).toBe(true);
  });
});

describe("outbox keeps its own target", () => {
  test("a queued result remembers where it must go", () => {
    const phone = "+38095" + String(Date.now()).slice(-7);
    const token = encryptPhone(phone);
    insertNumbers(uploadIdByLabel("routing-test"), [{ real: phone, token, webhook_id: "camp42" }]);
    const row = getByToken(token)!;
    const key = "route-" + Date.now();
    expect(outboxEnqueue(row.id, key, { hello: "world" }, "https://crm.example.com/hooks/camp42")).toBe(true);
    const claimed = outboxClaim(50).filter((r: { dedupe_key: string }) => r.dedupe_key === key);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].url).toBe("https://crm.example.com/hooks/camp42");
    expect(getByToken(token)!.webhook_id).toBe("camp42");
    outboxMarkDelivered(claimed[0].id);
  });
});
