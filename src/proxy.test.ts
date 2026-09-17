import { expect, test, describe } from "bun:test";
import { rmSync } from "node:fs";

process.env.FF3_KEY ??= "EF4359D8D580AA4F7F036D6F04FC6A94";
process.env.DECRYPT_KEY ??= "test-decrypt-key";
process.env.DB_PATH = "/tmp/hn-proxy-test.sqlite";
rmSync(process.env.DB_PATH, { force: true });

const { resultForOutcome } = await import("./status");
const { buildResultBody, parsePayload, crmConfigSchema, DEFAULT_CRM_CONFIG } = await import("./webhook");
const { backoffSeconds } = await import("./outbox");
const {
  outboxEnqueue,
  outboxClaim,
  outboxMarkDelivered,
  insertNumbers,
  uploadIdByLabel,
  getByToken,
  insertRequest,
  getRequest,
  requestsForNumber,
  latestOpenRequestForNumber,
  recordRequestResult,
  markRequestPushed,
  markRequestPushFailed,
  duePushRequests,
} = await import("./db");
const { normalizeUserId, payloadUserId, validWebhookUrl, callIdFromExternalId } = await import("./hooks");
const { getWrConfig, saveWrConfig } = await import("./webhook");
const { getSetting } = await import("./db");
const { looksLikeToken, encryptPhone } = await import("./fpe");
const { pushRequests, buildEvent, PUSH_MAX_ATTEMPTS } = await import("./platform");
const { wrConfigSchema, DEFAULT_WR_FIELDS } = await import("./webhook");

const FACTS = {
  phone: "+447700900123",
  call_id: "5f0c1e4a-6d3f-4b2b-9a1e-8d2c3b4a5f60",
  result: "send_sms",
  payload: { a: "b", user_id: "12345" },
};

const TOKEN = "+940612579184136";

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
  test("emits the fixed shape the client agreed on", () => {
    expect(buildResultBody(FACTS)).toEqual({
      phone: "+447700900123",
      call_id: FACTS.call_id,
      result: "send_sms",
      payload: { a: "b", user_id: "12345" },
    });
  });

  test("sends the decrypted number and never the token", () => {
    expect(JSON.stringify(buildResultBody(FACTS))).not.toContain(TOKEN);
  });

  test("passes the client payload back untouched, nested and all", () => {
    const payload = { a: "b", nested: { deep: [1, 2, { x: "y" }] }, user_id: 42 };
    expect(buildResultBody({ ...FACTS, payload }).payload).toEqual(payload);
  });

  test("a request that carried no payload yields null, not a missing key", () => {
    const body = buildResultBody({ ...FACTS, payload: undefined });
    expect("payload" in body).toBe(true);
    expect(body.payload).toBeNull();
  });

  test("stored payload is decoded from text and survives a non-json string", () => {
    expect(parsePayload(JSON.stringify({ a: "b" }))).toEqual({ a: "b" });
    expect(parsePayload(null)).toBeNull();
    expect(parsePayload("")).toBeNull();
    expect(parsePayload("plain")).toBe("plain");
  });

  test("rejects a malformed url", () => {
    expect(() => crmConfigSchema.parse({ url: "not-a-url" })).toThrow();
  });

  test("a stored config from the mapping era still loads", () => {
    const parsed = crmConfigSchema.parse({ url: "https://crm.example/hook", fields: [{ as: "user", from: "phone" }] });
    expect(parsed.url).toBe("https://crm.example/hook");
    expect("fields" in parsed).toBe(false);
  });

  test("default config has no address and no headers", () => {
    expect(DEFAULT_CRM_CONFIG.url).toBe("");
    expect(DEFAULT_CRM_CONFIG.headers).toEqual({});
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
  const wr = { baseUrl: "https://core.example", slug: "s", apiKey: "k", playerSegment: "seg", eventType: "player.registered", fields: DEFAULT_WR_FIELDS };
  const request = { call_id: "c-1", number_id: 1, segment: null, cohort: null } as never;
  const row = (over: Record<string, unknown>) =>
    ({ id: 1, real: "+447700900123", token: "+447700900123", segment: null, cohort: null, user_id: null, country: null, language: null, first_name: null, last_name: null, ...over }) as never;

  test("refuses to push a row whose token is really a phone number", () => {
    expect(() => buildEvent(row({}), request, wr)).toThrow(/refusing to send a real phone number/);
  });

  test("refuses when the token equals the real number even if it looks token-shaped", () => {
    const same = encryptPhone("+447700900123");
    expect(() => buildEvent(row({ real: same, token: same }), request, wr)).toThrow(/refusing to send a real phone number/);
  });

  test("a push that cannot build an event marks the request failed instead of silently dropping it", async () => {
    const phone = "+38093" + String(Date.now()).slice(-7);
    insertNumbers(uploadIdByLabel("leak-test"), [{ real: phone, token: phone }]);
    const number = getByToken(phone)!;
    const req = insertRequest({ call_id: crypto.randomUUID(), number_id: number.id });
    const [result] = await pushRequests([req]);
    expect(result.ok).toBe(false);
    const stored = getRequest(req.call_id)!;
    expect(stored.push_error).toContain("refusing to send a real phone number");
    expect(stored.pushed_at).toBeNull();
    expect(stored.push_attempts).toBe(PUSH_MAX_ATTEMPTS);
    expect(duePushRequests(PUSH_MAX_ATTEMPTS).some((r) => r.call_id === req.call_id)).toBe(false);
  });
});

describe("event identity", () => {
  const wr = { baseUrl: "https://core.example", slug: "s", apiKey: "k", playerSegment: "seg", eventType: "player.registered", fields: DEFAULT_WR_FIELDS };
  const phone = "+447700900123";
  const token = encryptPhone(phone);
  const number = { id: 7, real: phone, token, segment: "hidden", cohort: null, user_id: "u1", country: null, language: null, first_name: null, last_name: null } as never;
  const request = (over: Record<string, unknown>) => ({ call_id: "11111111-2222-4333-8444-555555555555", number_id: 7, segment: null, cohort: null, ...over }) as never;

  test("external_id and event_id are the call id, phone_e164 is the token", () => {
    const event = buildEvent(number, request({}), wr);
    expect(event.player.external_id).toBe("11111111-2222-4333-8444-555555555555");
    expect(event.event_id).toBe("hn-11111111-2222-4333-8444-555555555555");
    expect(event.player.phone_e164).toBe(token);
    expect(JSON.stringify(event)).not.toContain(phone);
  });

  test("two requests for the same phone produce two distinct identities", () => {
    const a = buildEvent(number, request({ call_id: "a-1" }), wr);
    const b = buildEvent(number, request({ call_id: "b-2" }), wr);
    expect(a.player.external_id).not.toBe(b.player.external_id);
    expect(a.event_id).not.toBe(b.event_id);
    expect(a.player.phone_e164).toBe(b.player.phone_e164);
  });

  test("a legacy external_id mapping is ignored rather than overriding the call id", () => {
    const legacy = { ...wr, fields: [{ as: "external_id", from: "token" }, ...DEFAULT_WR_FIELDS] } as never;
    expect(buildEvent(number, request({}), legacy).player.external_id).toBe("11111111-2222-4333-8444-555555555555");
  });

  test("segment and cohort come from the request first, then the number, then the defaults", () => {
    expect(buildEvent(number, request({ segment: "nl", cohort: "welcome" }), wr).data).toEqual({ player_segment: "nl", cohort: "welcome" });
    expect(buildEvent(number, request({}), wr).data).toEqual({ player_segment: "hidden" });
    expect(buildEvent({ ...(number as object), segment: null } as never, request({}), { ...wr, cohort: "base" }).data).toEqual({
      player_segment: "seg",
      cohort: "base",
    });
  });
});

describe("requests", () => {
  const fresh = () => {
    const phone = "+38097" + String(Date.now() + Math.floor(Math.random() * 1000)).slice(-7);
    const token = encryptPhone(phone);
    insertNumbers(uploadIdByLabel("requests-test"), [{ real: phone, token }]);
    return getByToken(token)!;
  };

  test("one phone can carry many requests, each with its own call id and payload", () => {
    const number = fresh();
    const first = insertRequest({ call_id: crypto.randomUUID(), number_id: number.id, cohort: "welcome", payload: { user_id: "1" } });
    const second = insertRequest({ call_id: crypto.randomUUID(), number_id: number.id, cohort: "reactivation", payload: { user_id: "1", touch: 2 } });
    const list = requestsForNumber(number.id);
    expect(list.map((r) => r.call_id).sort()).toEqual([first.call_id, second.call_id].sort());
    expect(parsePayload(second.payload)).toEqual({ user_id: "1", touch: 2 });
  });

  test("the latest open request is the one still waiting for a result", () => {
    const number = fresh();
    const older = insertRequest({ call_id: crypto.randomUUID(), number_id: number.id });
    recordRequestResult(older.call_id, { leadId: "l1", campaignId: "c1", outcome: "no_answer", result: "no_answer", attempts: 2 });
    const newer = insertRequest({ call_id: crypto.randomUUID(), number_id: number.id });
    expect(latestOpenRequestForNumber(number.id)!.call_id).toBe(newer.call_id);
  });


  test("a failed push is scheduled for a retry, a successful one closes the request", () => {
    const number = fresh();
    const req = insertRequest({ call_id: crypto.randomUUID(), number_id: number.id });
    expect(duePushRequests(PUSH_MAX_ATTEMPTS).some((r) => r.call_id === req.call_id)).toBe(true);
    markRequestPushFailed(req.call_id, "boom", 600);
    const failed = getRequest(req.call_id)!;
    expect(failed.push_error).toBe("boom");
    expect(failed.pushed_at).toBeNull();
    expect(failed.push_attempts).toBe(1);
    expect(failed.next_push_at).not.toBeNull();
    expect(duePushRequests(PUSH_MAX_ATTEMPTS).some((r) => r.call_id === req.call_id)).toBe(false);
    markRequestPushed(req.call_id);
    const done = getRequest(req.call_id)!;
    expect(done.push_error).toBeNull();
    expect(done.pushed_at).not.toBeNull();
    expect(done.next_push_at).toBeNull();
  });

  test("a retry becomes due once its backoff has passed and stops after the cap", () => {
    const number = fresh();
    const req = insertRequest({ call_id: crypto.randomUUID(), number_id: number.id });
    markRequestPushFailed(req.call_id, "boom", 0);
    expect(duePushRequests(PUSH_MAX_ATTEMPTS).some((r) => r.call_id === req.call_id)).toBe(true);
    for (let i = 1; i < PUSH_MAX_ATTEMPTS; i += 1) markRequestPushFailed(req.call_id, "boom", 0);
    expect(getRequest(req.call_id)!.push_attempts).toBe(PUSH_MAX_ATTEMPTS);
    expect(duePushRequests(PUSH_MAX_ATTEMPTS).some((r) => r.call_id === req.call_id)).toBe(false);
  });
});

describe("inbound request fields", () => {
  test("user_id is read from the payload when the top level has none", () => {
    expect(payloadUserId({ a: "b", user_id: "12345" })).toBe("12345");
    expect(payloadUserId({ user_id: 7 })).toBe(7);
    expect(payloadUserId({ a: "b" })).toBeUndefined();
    expect(payloadUserId(null)).toBeUndefined();
    expect(payloadUserId([1, 2])).toBeUndefined();
    expect(payloadUserId("x")).toBeUndefined();
  });

  test("webhook_url must be an http(s) address", () => {
    expect(validWebhookUrl("https://crm.example.com/hooks/call-results")).toBe("https://crm.example.com/hooks/call-results");
    expect(validWebhookUrl("ftp://x")).toBeNull();
    expect(validWebhookUrl("not a url")).toBeNull();
    expect(validWebhookUrl(undefined)).toBeNull();
  });

  test("the call id is recovered from a client-prefixed external id", () => {
    expect(callIdFromExternalId("client1:5f0c1e4a-6d3f-4b2b-9a1e-8d2c3b4a5f60")).toBe("5f0c1e4a-6d3f-4b2b-9a1e-8d2c3b4a5f60");
    expect(callIdFromExternalId("5f0c1e4a-6d3f-4b2b-9a1e-8d2c3b4a5f60")).toBe("5f0c1e4a-6d3f-4b2b-9a1e-8d2c3b4a5f60");
    expect(callIdFromExternalId(null)).toBeNull();
    expect(callIdFromExternalId("slug:")).toBeNull();
  });
});

describe("platform mapping guard", () => {
  const base = { baseUrl: "https://core.example", slug: "s", apiKey: "k", playerSegment: "seg" };

  test("the real phone number is not even an allowed source", () => {
    expect(() => wrConfigSchema.parse({ ...base, fields: [{ as: "phone_e164", from: "phone" }] })).toThrow();
  });

  test("phone_e164 refuses any source other than the token", () => {
    expect(() => wrConfigSchema.parse({ ...base, fields: [{ as: "phone_e164", from: "user_id" }] })).toThrow(
      /phone_e164 may only carry the token/,
    );
  });

  test("phone_e164 cannot be dropped from the mapping", () => {
    expect(() => wrConfigSchema.parse({ ...base, fields: [{ as: "cohort", from: "cohort" }] })).toThrow(/phone_e164 must be mapped/);
  });

  test("external_id is no longer mappable — it is always the call id", () => {
    expect(() => wrConfigSchema.parse({ ...base, fields: [{ as: "external_id", from: "token" }, { as: "phone_e164", from: "token" }] })).toThrow();
  });

  test("a correct mapping saves, and the shipped default is one", () => {
    const parsed = wrConfigSchema.parse({ ...base, fields: DEFAULT_WR_FIELDS });
    expect(parsed.fields).toEqual(DEFAULT_WR_FIELDS);
    expect(DEFAULT_WR_FIELDS.find((f) => f.as === "phone_e164")!.from).toBe("token");
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
      fields: [{ as: "phone_e164", from: "token" }],
    });
    expect(getWrConfig().slug).toBe("operator-slug");
    expect(getWrConfig().playerSegment).toBe("operator-segment");
  });

  test("a config saved before call ids loses its external_id row on read", async () => {
    const { setSetting } = await import("./db");
    setSetting(
      "wr_connection",
      JSON.stringify({
        baseUrl: "https://old.example",
        slug: "old",
        apiKey: "k",
        playerSegment: "seg",
        fields: [
          { as: "external_id", from: "token" },
          { as: "phone_e164", from: "token" },
        ],
      }),
    );
    expect(getWrConfig().fields).toEqual([{ as: "phone_e164", from: "token" }]);
  });
});

describe("outbox keeps its own target", () => {
  test("a queued result remembers where it must go", () => {
    const phone = "+38095" + String(Date.now()).slice(-7);
    const token = encryptPhone(phone);
    insertNumbers(uploadIdByLabel("routing-test"), [{ real: phone, token }]);
    const row = getByToken(token)!;
    const key = "route-" + Date.now();
    expect(outboxEnqueue(row.id, key, { hello: "world" }, "https://crm.example.com/hooks/camp42", "call-42")).toBe(true);
    const claimed = outboxClaim(50).filter((r: { dedupe_key: string }) => r.dedupe_key === key);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].url).toBe("https://crm.example.com/hooks/camp42");
    expect(claimed[0].call_id).toBe("call-42");
    outboxMarkDelivered(claimed[0].id);
  });
});

describe("legacy numbers keep receiving results", () => {
  test("a number pushed before call ids gets a request keyed by its token", async () => {
    const { backfillLegacyRequests, markPushed } = await import("./db");
    const phone = "+38099" + String(Date.now()).slice(-7);
    const token = encryptPhone(phone);
    insertNumbers(uploadIdByLabel("legacy"), [{ real: phone, token, user_id: "legacy-user", webhook_id: "brand1" }]);
    markPushed([token]);
    const number = getByToken(token)!;
    expect(backfillLegacyRequests()).toBeGreaterThanOrEqual(1);
    expect(backfillLegacyRequests()).toBe(0);
    const req = getRequest(token)!;
    expect(req.number_id).toBe(number.id);
    expect(req.webhook_id).toBe("brand1");
    expect(parsePayload(req.payload)).toEqual({ user_id: "legacy-user" });
    expect(callIdFromExternalId(`client1:${token}`)).toBe(token);
  });

  test("a number never pushed is left alone", async () => {
    const { backfillLegacyRequests } = await import("./db");
    const phone = "+38098" + String(Date.now()).slice(-7);
    const token = encryptPhone(phone);
    insertNumbers(uploadIdByLabel("legacy"), [{ real: phone, token }]);
    backfillLegacyRequests();
    expect(requestsForNumber(getByToken(token)!.id)).toHaveLength(0);
  });
});

describe("one token, one row, whatever the formatting", () => {
  test("a number first stored without + is reused when it arrives in E.164", () => {
    const suffix = String(Date.now()).slice(-7);
    const bare = "38095" + suffix;
    const e164 = "+" + bare;
    const token = encryptPhone(e164);
    expect(encryptPhone(bare)).toBe(token);
    insertNumbers(uploadIdByLabel("csv"), [{ real: bare, token }]);
    const before = getByToken(token)!;
    insertNumbers(uploadIdByLabel("crm"), [{ real: e164, token, user_id: "u-1" }]);
    const after = getByToken(token)!;
    expect(after.id).toBe(before.id);
    expect(after.real).toBe(e164);
    expect(after.user_id).toBe("u-1");
  });
});
