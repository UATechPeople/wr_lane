import { timingSafeEqual } from "crypto";
import { Elysia, t } from "elysia";
import { encryptPhone, looksLikeToken } from "./fpe";
import {
  getByReal,
  getByToken,
  getRequest,
  insertNumbers,
  insertRequest,
  latestOpenRequestForNumber,
  markPushed,
  outboxEnqueue,
  recordCallResult,
  recordRequestResult,
  uploadIdByLabel,
  type NewNumber,
  type RequestRow,
} from "./db";
import { buildResultBody, getCrmConfig, getCoreKey, getInboundKey, isWebhookId, parsePayload, resolveCrmUrl } from "./webhook";
import { resultForOutcome } from "./status";
import { pushRequests } from "./platform";

const STREAM_LABEL = "CRM stream";

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

const playerSchema = t.Object(
  {
    phone: t.String({ description: "Real phone number in E.164. Never a token.", examples: ["+31612345678"] }),
    user_id: t.Optional(
      t.Union([t.String(), t.Number()], {
        description: "Your id for this person. Prefer a string — long numeric ids lose digits in JSON. Falls back to payload.user_id.",
      }),
    ),
    first_name: t.Optional(t.String({ maxLength: 128 })),
    last_name: t.Optional(t.String({ maxLength: 128 })),
    country: t.Optional(t.String({ description: "ISO-3166 alpha-2, e.g. NL. Anything else is dropped." })),
    language: t.Optional(t.String({ description: "2–8 characters, e.g. nl." })),
    segment: t.Optional(t.String({ description: "Geo or product segment. Together with cohort selects the Platform campaign.", examples: ["nl"] })),
    cohort: t.Optional(t.String({ description: "Type of touch, e.g. welcome or reactivation.", examples: ["welcome"] })),
    webhook_url: t.Optional(
      t.String({
        description: "Where the result of this very call must be posted. Overrides the addresses configured in the cabinet.",
        examples: ["https://crm.example.com/hooks/call-results"],
      }),
    ),
    payload: t.Optional(t.Any({ description: "Anything you want back with the result. Returned untouched." })),
  },
  { description: "One player to call. Unknown fields are ignored.", additionalProperties: true },
);

const playersBody = t.Union([playerSchema, t.Array(playerSchema, { minItems: 1 })], {
  description: "A single player or an array of them. Each element becomes a separate call with its own call_id.",
});

const acceptedRowSchema = t.Object({
  phone: t.String(),
  token: t.Nullable(t.String({ description: "15-digit token Platform will dial." })),
  call_id: t.Nullable(t.String({ format: "uuid", description: "Identifier of this call. Comes back with the result." })),
  ok: t.Boolean(),
  error: t.Optional(t.String()),
  warning: t.Optional(t.String()),
});

const playersResponse = t.Object({
  received: t.Integer(),
  accepted: t.Integer({ description: "Rows that became calls and were sent to Platform." }),
  pushed: t.Nullable(t.Object({ sent: t.Integer(), failed: t.Integer(), error: t.Optional(t.String()) })),
  rows: t.Array(acceptedRowSchema),
});

const errorResponse = t.Object({ error: t.String() });

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
  { additionalProperties: true, description: "Body posted by a Platform flow-graph webhook node." },
);

const callResultResponse = t.Object({
  received: t.Boolean(),
  matched: t.Boolean(),
  call_id: t.Optional(t.String()),
  queued: t.Optional(t.Boolean({ description: "True when a result was put in the delivery queue to your CRM." })),
  reason: t.Optional(t.String()),
  error: t.Optional(t.String()),
});

const INBOUND_DETAIL = {
  tags: ["Players"],
  security: [{ inboundKey: [] }],
  description:
    "Send a player to be called. The number is encrypted into a token here; only the token leaves your infrastructure. Every request is a separate call with its own call_id, even for a number you have sent before. The result comes back to `webhook_url` from the request, or to the address configured in the cabinet, as `{ phone, call_id, result, payload }`.",
};

type PlayerInput = {
  phone: string;
  user_id?: string | number;
  first_name?: string;
  last_name?: string;
  country?: string;
  language?: string;
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

type Pending = { input: PlayerInput; token: string; userId?: string; webhookUrl: string | null };

async function acceptPlayers({ body, headers, set }: PlayersContext, webhookId: string | null) {
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

  const pending: Pending[] = [];
  const rows: AcceptedRow[] = inputs.map((input) => {
    if (looksLikeToken(input.phone)) {
      return { phone: input.phone, token: null, call_id: null, ok: false, error: "this is already a token, send the real phone number" };
    }
    if (input.webhook_url && validWebhookUrl(input.webhook_url) === null) {
      return { phone: input.phone, token: null, call_id: null, ok: false, error: "webhook_url must be an http(s) url" };
    }
    const userId = normalizeUserId(input.user_id ?? payloadUserId(input.payload));
    try {
      const token = encryptPhone(input.phone);
      pending.push({ input, token, userId: userId.value, webhookUrl: validWebhookUrl(input.webhook_url) });
      return { phone: input.phone, token, call_id: null, ok: true, ...(userId.warning ? { warning: userId.warning } : {}) };
    } catch (e) {
      return { phone: input.phone, token: null, call_id: null, ok: false, error: (e as Error).message };
    }
  });

  if (pending.length > 0) {
    const numbers: NewNumber[] = pending.map(({ input, token, userId }) => ({
      real: input.phone,
      token,
      user_id: userId,
      webhook_id: webhookId ?? undefined,
      first_name: input.first_name,
      last_name: input.last_name,
      country: input.country,
      language: input.language,
      segment: input.segment,
      cohort: input.cohort,
    }));
    insertNumbers(uploadIdByLabel(STREAM_LABEL), numbers);
  }

  const requests: RequestRow[] = [];
  for (const item of pending) {
    const number = getByToken(item.token);
    const row = rows.find((r) => r.ok && r.token === item.token && r.call_id === null);
    if (!number || !row) continue;
    const request = insertRequest({
      call_id: crypto.randomUUID(),
      number_id: number.id,
      webhook_id: webhookId,
      webhook_url: item.webhookUrl,
      payload: item.input.payload,
      segment: item.input.segment ?? null,
      cohort: item.input.cohort ?? null,
    });
    row.call_id = request.call_id;
    requests.push(request);
  }

  let pushed: { sent: number; failed: number; error?: string } | null = null;
  if (requests.length > 0) {
    try {
      const results = await pushRequests(requests);
      markPushed(results.filter((r) => r.ok).map((r) => r.token));
      pushed = { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
    } catch (e) {
      pushed = { sent: 0, failed: requests.length, error: (e as Error).message };
    }
  }

  set.status = 202;
  return { received: rows.length, accepted: requests.length, pushed, rows };
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
  .post("/players", async (ctx) => acceptPlayers(ctx as PlayersContext, null), {
    body: playersBody,
    response: { 202: playersResponse, 401: errorResponse, 422: errorResponse, 503: errorResponse },
    detail: { ...INBOUND_DETAIL, summary: "Send players" },
  })
  .post(
    "/players/:webhookId",
    async (ctx) => {
      const { params, set } = ctx as PlayersContext & { params: { webhookId: string } };
      if (!isWebhookId(params.webhookId)) {
        set.status = 422;
        return { error: "webhook id may only contain letters, digits, dashes and underscores" };
      }
      return acceptPlayers(ctx as PlayersContext, params.webhookId);
    },
    {
      body: playersBody,
      params: t.Object({
        webhookId: t.String({
          pattern: "^[A-Za-z0-9_-]{1,128}$",
          description: "Your routing id, e.g. a brand or campaign. Substituted for {id} in the cabinet's URL template when the request carries no webhook_url.",
        }),
      }),
      response: { 202: playersResponse, 401: errorResponse, 422: errorResponse, 503: errorResponse },
      detail: { ...INBOUND_DETAIL, summary: "Send players tagged with a routing id" },
    },
  )
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

      const crm = getCrmConfig();
      const url = request.webhook_url ?? resolveCrmUrl(crm, request.webhook_id);
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
        tags: ["Platform"],
        security: [{ coreKey: [] }],
        summary: "Receive a call result from Platform",
        description:
          "Called by the Platform flow graph when a call reaches a terminal outcome. The cabinet matches the request by `externalId` (the call_id), maps `outcome` to your result vocabulary and queues delivery to your CRM. Always answers 200 for a well-formed body so Platform does not retry; a real phone number in `phone` is refused with 422.",
      },
    },
  );
