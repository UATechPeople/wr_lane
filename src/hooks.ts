import { timingSafeEqual } from "crypto";
import { Elysia, t } from "elysia";
import { encryptPhone, looksLikeToken } from "./fpe";
import {
  getByReal,
  getByToken,
  insertNumbers,
  markPushed,
  outboxEnqueue,
  recordCallResult,
  uploadIdByLabel,
  type NewNumber,
  type NumberRow,
} from "./db";
import { buildBody, getCrmConfig, getCoreKey, getInboundKey, isWebhookId, resolveCrmUrl, type ResultFacts } from "./webhook";
import { resultForOutcome } from "./status";
import { pushRecords } from "./winriders";

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

const playerSchema = t.Object({
  phone: t.String(),
  user_id: t.Optional(t.Union([t.String(), t.Number()])),
  first_name: t.Optional(t.String()),
  last_name: t.Optional(t.String()),
  country: t.Optional(t.String()),
  language: t.Optional(t.String()),
  segment: t.Optional(t.String()),
  cohort: t.Optional(t.String()),
});

type PlayerInput = {
  phone: string;
  user_id?: string | number;
  first_name?: string;
  last_name?: string;
  country?: string;
  language?: string;
  segment?: string;
  cohort?: string;
};

type AcceptedRow = { phone: string; token: string | null; ok: boolean; error?: string; warning?: string };

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

function toList(body: PlayerInput | PlayerInput[]): PlayerInput[] {
  if (Array.isArray(body)) return body;
  return [body];
}

type PlayersContext = {
  body: PlayerInput | PlayerInput[];
  headers: Record<string, string | undefined>;
  set: { status?: number };
};

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

  const accepted: NewNumber[] = [];
  const rows: AcceptedRow[] = inputs.map((input) => {
    const userId = normalizeUserId(input.user_id);
    if (looksLikeToken(input.phone)) {
      return { phone: input.phone, token: null, ok: false, error: "this is already a token, send the real phone number" };
    }
    try {
      const token = encryptPhone(input.phone);
      accepted.push({
        real: input.phone,
        token,
        user_id: userId.value,
        webhook_id: webhookId ?? undefined,
        first_name: input.first_name,
        last_name: input.last_name,
        country: input.country,
        language: input.language,
        segment: input.segment,
        cohort: input.cohort,
      });
      return { phone: input.phone, token, ok: true, ...(userId.warning ? { warning: userId.warning } : {}) };
    } catch (e) {
      return { phone: input.phone, token: null, ok: false, error: (e as Error).message };
    }
  });

  if (accepted.length > 0) insertNumbers(uploadIdByLabel(STREAM_LABEL), accepted);

  let pushed: { sent: number; failed: number; error?: string } | null = null;
  if (accepted.length > 0) {
    const stored = accepted.map((r) => getByToken(r.token)).filter((r): r is NumberRow => r !== null);
    try {
      const results = await pushRecords(stored);
      markPushed(results.filter((r) => r.ok).map((r) => r.token));
      pushed = { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
    } catch (e) {
      pushed = { sent: 0, failed: stored.length, error: (e as Error).message };
    }
  }

  set.status = 202;
  return { received: rows.length, accepted: accepted.length, pushed, rows };
}

export const hooks = new Elysia({ prefix: "/hook" })
  .post(
    "/players",
    async (ctx) => acceptPlayers(ctx as PlayersContext, null),
    { body: t.Union([playerSchema, t.Array(playerSchema)]) },
  )
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
    { body: t.Union([playerSchema, t.Array(playerSchema)]) },
  )
  .post(
    "/call-result",
    ({ body, headers, set }) => {
      const allowed = guard(headers, getCoreKey());
      if (!allowed.ok) {
        set.status = allowed.status;
        return allowed.body;
      }

      const payload = body as {
        event?: string;
        campaignId?: string;
        leadId?: string;
        outcome?: string | null;
        attempts?: Record<string, number> | number | null;
        phone?: string | null;
        sentAt?: string;
      };

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

      const attempts =
        typeof payload.attempts === "number" ? payload.attempts : (payload.attempts?.call ?? null);
      const result = resultForOutcome(payload.outcome);

      recordCallResult(row.id, {
        leadId: payload.leadId ?? null,
        outcome: payload.outcome ?? null,
        result,
        attempts,
      });

      if (!result) return { received: true, matched: true, queued: false, reason: "outcome is not mapped" };

      const facts: ResultFacts = {
        phone: row.real,
        token: row.token,
        user_id: row.user_id,
        result,
        outcome: payload.outcome ?? null,
        attempts,
        lead_id: payload.leadId ?? null,
        campaign_id: payload.campaignId ?? null,
        event: payload.event ?? null,
        sent_at: payload.sentAt ?? null,
      };

      const crm = getCrmConfig();
      const dedupeKey = [payload.campaignId, payload.leadId, payload.event, payload.outcome, attempts].join(":");
      const queued = outboxEnqueue(row.id, dedupeKey, buildBody(crm, facts), resolveCrmUrl(crm, row.webhook_id));

      return { received: true, matched: true, queued };
    },
    { body: t.Any() },
  );
