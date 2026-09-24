import { timingSafeEqual } from "crypto";
import { Elysia, t } from "elysia";
import { encryptPhone, looksLikeToken } from "./fpe";
import {
  batchResponseByKey,
  createBatch,
  getByReal,
  getByToken,
  getRequest,
  inTransaction,
  insertNumbers,
  insertRequests,
  latestOpenRequestForNumber,
  outboxEnqueue,
  recordCallResult,
  recordRequestResult,
  saveBatchResponse,
  uploadIdByLabel,
  type NewNumber,
  type NewRequest,
  type RequestRow,
} from "./db";
import { buildResultBody, getCrmConfig, getCoreKey, getInboundKey, parsePayload } from "./webhook";
import { resultForOutcome } from "./status";
import { BULK_PRIORITY, kickPushWorker, LIVE_BATCH_MAX, LIVE_PRIORITY } from "./winriders";

export const STREAM_LABEL = "CRM stream";

export const MAX_PLAYERS_PER_REQUEST = 5000;

const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,200}$/;

function presentedKey(headers: Record<string, string | undefined>): string | null {
  const auth = headers.authorization;
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return headers["x-api-key"] ?? null;
}

type Guard = { ok: true } | { ok: false; status: number; body: { error: string } };

function guard(headers: Record<string, string | undefined>, expected: string | null): Guard {
  if (!expected) return { ok: false, status: 503, body: { error: "key is not configured in the cabinet" } };
  const presented = presentedKey(headers);
  if (presented == null) return { ok: false, status: 401, body: { error: "unauthorized" } };
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, status: 401, body: { error: "unauthorized" } };
  }
  return { ok: true };
}

const PLAYER_EXAMPLE = {
  phone: "+31612345678",
  segment: "hidden",
  cohort: "deau1",
  webhook_url: "https://api-eu.customer.io/v1/webhook/764e97035ef6a03e",
  payload: { a: "b", user_id: "12345" },
};

const playerSchema = t.Object(
  {
    phone: t.String({ description: "Real phone number in E.164. Never a token.", examples: ["+31612345678"] }),
    segment: t.Optional(t.String({ description: "Together with cohort selects the WinRiders campaign.", examples: ["hidden"] })),
    cohort: t.Optional(t.String({ description: "Together with segment selects the WinRiders campaign.", examples: ["deau1"] })),
    webhook_url: t.Optional(
      t.String({
        description: "Where the result of this call must be posted.",
        examples: ["https://api-eu.customer.io/v1/webhook/764e97035ef6a03e"],
      }),
    ),
    payload: t.Optional(
      t.Any({
        description: "Anything you want back with the result. Returned untouched.",
        examples: [{ a: "b", user_id: "12345" }],
      }),
    ),
  },
  { description: "One player to call.", examples: [PLAYER_EXAMPLE] },
);

const playersBody = t.Union([playerSchema, t.Array(playerSchema, { minItems: 1, examples: [[PLAYER_EXAMPLE]] })], {
  description: "A single player or an array of them. Each element becomes a separate call with its own call_id.",
  examples: [PLAYER_EXAMPLE],
});

const acceptedRowSchema = t.Object({
  phone: t.String(),
  token: t.Nullable(t.String({ description: "15-digit token WinRiders will dial." })),
  call_id: t.Nullable(t.String({ format: "uuid", description: "Identifier of this call. Comes back with the result." })),
  ok: t.Boolean(),
  error: t.Optional(t.String()),
  warning: t.Optional(t.String()),
});

const ACCEPTED_EXAMPLE = {
  received: 1,
  accepted: 1,
  pushed: null,
  queued: 1,
  batch_id: 42,
  rows: [{ phone: "+31612345678", token: "+913694993501880", call_id: "5d8982cd-8220-4f97-ac7d-452dbd01f630", ok: true }],
};

const playersResponse = t.Object(
  {
    received: t.Number(),
    accepted: t.Number({ description: "Rows that became calls and were queued for WinRiders." }),
    pushed: t.Nullable(
      t.Object(
        { sent: t.Number(), failed: t.Number(), error: t.Optional(t.String()) },
        { description: "Always null: calls are sent to WinRiders in the background at the configured rate." },
      ),
    ),
    queued: t.Number({ description: "Calls queued for WinRiders by this request." }),
    batch_id: t.Nullable(t.Number({ description: "Batch of this request. Track it in the cabinet." })),
    rows: t.Array(acceptedRowSchema),
  },
  { examples: [ACCEPTED_EXAMPLE] },
);

const errorResponse = t.Object({ error: t.String() }, { examples: [{ error: "unauthorized" }] });

const CALL_RESULT_EXAMPLE = {
  event: "call.lost",
  campaignId: "9a0390ee-f6f4-45a9-ac10-f081a9ab79be",
  leadId: "bb2bb77c-199e-4d7f-b350-c517d674caee",
  externalId: "lalastars:5d8982cd-8220-4f97-ac7d-452dbd01f630",
  outcome: "no_answer",
  attempts: { call: 2, sms: 0 },
  phone: "+913694993501880",
  sentAt: "2026-09-16T12:00:00.000Z",
};

const callResultBody = t.Object(
  {
    event: t.Optional(t.String({ examples: ["call.lost"] })),
    campaignId: t.Optional(t.String()),
    leadId: t.Optional(t.String()),
    externalId: t.Optional(t.Nullable(t.String({ description: "call_id issued by this cabinet, optionally prefixed with the client slug." }))),
    outcome: t.Optional(t.Nullable(t.String({ examples: ["no_answer"] }))),
    attempts: t.Optional(t.Nullable(t.Union([t.Record(t.String(), t.Number()), t.Number()]))),
    phone: t.Optional(t.Nullable(t.String({ description: "The token that was dialled." }))),
    sentAt: t.Optional(t.String()),
  },
  { additionalProperties: true, description: "Body posted by a WinRiders flow-graph webhook node.", examples: [CALL_RESULT_EXAMPLE] },
);

const callResultResponse = t.Object(
  {
    received: t.Boolean(),
    matched: t.Boolean(),
    call_id: t.Optional(t.String()),
    queued: t.Optional(t.Boolean({ description: "True when a result was put in the delivery queue to your CRM." })),
    reason: t.Optional(t.String()),
    error: t.Optional(t.String()),
  },
  { examples: [{ received: true, matched: true, call_id: "5d8982cd-8220-4f97-ac7d-452dbd01f630", queued: true }] },
);

const INBOUND_DETAIL = {
  tags: ["Players"],
  security: [{ inboundKey: [] }],
  description:
    "Send a player to be called. The number is encrypted into a token here; only the token leaves your infrastructure. Every request is a separate call with its own call_id. The result comes back to `webhook_url` as `{ \"phone\": \"+31612345678\", \"call_id\": \"uuid\", \"result\": \"no_answer\", \"payload\": { \"a\": \"b\", \"user_id\": \"12345\" } }`. Calls are queued and sent to WinRiders in the background at the rate set in the cabinet. At most 5000 players per request. Send an `Idempotency-Key` header to make a retried request return the first response instead of creating new calls.",
};

type PlayerInput = {
  phone: string;
  segment?: string;
  cohort?: string;
  webhook_url?: string;
  payload?: unknown;
};

type AcceptedRow = { phone: string; token: string | null; call_id: string | null; ok: boolean; error?: string; warning?: string };

export function normalizeUserId(value: string | number | undefined): { value?: string; warning?: string } {
  if (value == null) return {};
  if (typeof value === "string") return { value };
  if (!Number.isSafeInteger(value)) {
    return {
      value: String(value),
      warning: "user_id exceeded the precision JSON numbers can carry and was rounded — send it as a string",
    };
  }
  return { value: String(value) };
}

export function payloadUserId(payload: unknown): string | number | undefined {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>).user_id;
  if (typeof value === "string" || typeof value === "number") return value;
  return undefined;
}

export function validWebhookUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return value;
  } catch {
    return null;
  }
}

function toList(body: PlayerInput | PlayerInput[]): PlayerInput[] {
  if (Array.isArray(body)) return body;
  return [body];
}

type PlayersContext = {
  body: PlayerInput | PlayerInput[];
  headers: Record<string, string | undefined>;
  set: { status?: number };
};

type Pending = { input: PlayerInput; token: string; userId?: string; webhookUrl: string | null; row: AcceptedRow };

function acceptPlayers({ body, headers, set }: PlayersContext) {
  const allowed = guard(headers, getInboundKey());
  if (!allowed.ok) {
    set.status = allowed.status;
    return allowed.body;
  }

  const inputs = toList(body);
  if (inputs.length === 0) {
    set.status = 422;
    return { error: "no records" };
  }
  if (inputs.length > MAX_PLAYERS_PER_REQUEST) {
    set.status = 413;
    return { error: `too many records: ${inputs.length}, send at most ${MAX_PLAYERS_PER_REQUEST} per request` };
  }

  const idempotencyKey = headers["idempotency-key"]?.trim() || null;
  if (idempotencyKey !== null && !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    set.status = 422;
    return { error: "Idempotency-Key must be 1-200 printable ASCII characters" };
  }
  if (idempotencyKey !== null) {
    const stored = batchResponseByKey(idempotencyKey);
    if (stored !== null) {
      set.status = 202;
      return JSON.parse(stored) as unknown;
    }
  }

  const pending: Pending[] = [];
  const rows: AcceptedRow[] = inputs.map((input) => {
    if (looksLikeToken(input.phone)) {
      return { phone: input.phone, token: null, call_id: null, ok: false, error: "this is already a token, send the real phone number" };
    }
    if (input.webhook_url && validWebhookUrl(input.webhook_url) === null) {
      return { phone: input.phone, token: null, call_id: null, ok: false, error: "webhook_url must be an http(s) url" };
    }
    const userId = normalizeUserId(payloadUserId(input.payload));
    try {
      const token = encryptPhone(input.phone);
      const row: AcceptedRow = { phone: input.phone, token, call_id: null, ok: true, ...(userId.warning ? { warning: userId.warning } : {}) };
      pending.push({ input, token, userId: userId.value, webhookUrl: validWebhookUrl(input.webhook_url), row });
      return row;
    } catch (e) {
      return { phone: input.phone, token: null, call_id: null, ok: false, error: (e as Error).message };
    }
  });

  const priority = pending.length <= LIVE_BATCH_MAX ? LIVE_PRIORITY : BULK_PRIORITY;

  const response = inTransaction(() => {
    const replayed = idempotencyKey === null ? null : batchResponseByKey(idempotencyKey);
    if (replayed !== null) return JSON.parse(replayed) as { queued: number };
    let batchId: number | null = null;
    let queued = 0;
    if (pending.length > 0) {
      const numbers: NewNumber[] = pending.map(({ input, token, userId }) => ({
        real: input.phone,
        token,
        user_id: userId,
        segment: input.segment,
        cohort: input.cohort,
      }));
      insertNumbers(uploadIdByLabel(STREAM_LABEL), numbers);
      batchId = createBatch({ source: "hook", idempotencyKey });

      const numberIds = new Map<string, number>();
      const requests: NewRequest[] = [];
      for (const item of pending) {
        let numberId = numberIds.get(item.token);
        if (numberId === undefined) {
          numberId = getByToken(item.token)?.id;
          if (numberId === undefined) continue;
          numberIds.set(item.token, numberId);
        }
        const callId = crypto.randomUUID();
        requests.push({
          call_id: callId,
          number_id: numberId,
          webhook_url: item.webhookUrl,
          payload: item.input.payload,
          segment: item.input.segment ?? null,
          cohort: item.input.cohort ?? null,
          batch_id: batchId,
          priority,
        });
        item.row.call_id = callId;
      }
      insertRequests(requests);
      queued = requests.length;
    } else if (idempotencyKey !== null) {
      batchId = createBatch({ source: "hook", idempotencyKey });
    }
    const result = { received: rows.length, accepted: queued, pushed: null, queued, batch_id: batchId, rows };
    if (batchId !== null) saveBatchResponse(batchId, result);
    return result;
  });

  if (response.queued > 0) kickPushWorker();
  set.status = 202;
  return response;
}

type CallResultPayload = {
  event?: string;
  campaignId?: string;
  leadId?: string;
  externalId?: string | null;
  outcome?: string | null;
  attempts?: Record<string, number> | number | null;
  phone?: string | null;
  sentAt?: string;
};

export function callIdFromExternalId(externalId: string | null | undefined): string | null {
  if (!externalId) return null;
  const idx = externalId.indexOf(":");
  const bare = idx < 0 ? externalId : externalId.slice(idx + 1);
  return bare || null;
}

export const hooks = new Elysia({ prefix: "/hook" })
  .post("/players", (ctx) => acceptPlayers(ctx as PlayersContext), {
    body: playersBody,
    response: { 202: playersResponse, 401: errorResponse, 413: errorResponse, 422: errorResponse, 503: errorResponse },
    detail: { ...INBOUND_DETAIL, summary: "Send players" },
  })
  .post(
    "/call-result",
    ({ body, headers, set }) => {
      const allowed = guard(headers, getCoreKey());
      if (!allowed.ok) {
        set.status = allowed.status;
        return allowed.body;
      }

      const payload = body as CallResultPayload;

      const digits = (payload.phone ?? "").replace(/\D/g, "");
      if (!digits) return { received: true, matched: false, reason: "no phone in payload" };

      const leaked = getByReal(`+${digits}`) ?? getByReal(digits);
      if (leaked) {
        console.error(`[hidden-numbers] REAL NUMBER RECEIVED WHERE A TOKEN WAS EXPECTED (row ${leaked.id}) — tokenisation is bypassed upstream`);
        set.status = 422;
        return {
          received: true,
          matched: false,
          error: "real_number_received",
          reason: "this is a real phone number, not a token — the campaign is dialling untokenised numbers, fix it before results can be accepted",
        };
      }

      if (!looksLikeToken(digits)) {
        set.status = 422;
        return {
          received: true,
          matched: false,
          error: "not_a_token",
          reason: `expected a ${15}-digit token, got something else — check that the campaign was seeded from this cabinet`,
        };
      }

      const row = getByToken(`+${digits}`) ?? getByToken(digits);
      if (!row) return { received: true, matched: false, reason: "unknown token" };

      const callId = callIdFromExternalId(payload.externalId);
      const request: RequestRow | null = callId ? getRequest(callId) : latestOpenRequestForNumber(row.id);
      if (!request) {
        return { received: true, matched: false, reason: callId ? "unknown call_id" : "no open request for this token" };
      }
      if (request.number_id !== row.id) {
        set.status = 422;
        return { received: true, matched: false, error: "call_id_mismatch", reason: "call_id belongs to a different number" };
      }

      const attempts =
        typeof payload.attempts === "number" ? payload.attempts : (payload.attempts?.call ?? null);
      const result = resultForOutcome(payload.outcome);
      const stored = {
        leadId: payload.leadId ?? null,
        outcome: payload.outcome ?? null,
        result,
        attempts,
      };

      recordRequestResult(request.call_id, { ...stored, campaignId: payload.campaignId ?? null });
      recordCallResult(row.id, stored);

      if (!result) return { received: true, matched: true, call_id: request.call_id, queued: false, reason: "outcome is not mapped" };

      const url = request.webhook_url ?? getCrmConfig().url;
      const dedupeKey = [request.call_id, payload.event, payload.outcome, attempts].join(":");
      const queued = outboxEnqueue(
        row.id,
        dedupeKey,
        buildResultBody({ phone: row.real, call_id: request.call_id, result, payload: parsePayload(request.payload) }),
        url,
        request.call_id,
      );

      return { received: true, matched: true, call_id: request.call_id, queued };
    },
    {
      body: callResultBody,
      response: { 200: callResultResponse, 401: errorResponse, 422: callResultResponse, 503: errorResponse },
      detail: {
        tags: ["WinRiders"],
        security: [{ coreKey: [] }],
        summary: "Receive a call result from WinRiders",
        description:
          "Called by the WinRiders flow graph when a call reaches a terminal outcome. The cabinet matches the request by `externalId` (the call_id), maps `outcome` to your result vocabulary and queues delivery to your CRM. Always answers 200 for a well-formed body so WinRiders does not retry; a real phone number in `phone` is refused with 422.",
      },
    },
  );
