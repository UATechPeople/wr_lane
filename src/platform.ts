import axios from "axios";
import { Cron } from "croner";
import { duePushRequests, getNumber, markRequestPushAbandoned, markRequestPushFailed, markRequestPushed, type NumberRow, type RequestRow } from "./db";
import { backoffSeconds } from "./outbox";
import { looksLikeToken } from "./fpe";
import { getWrConfig, TOKEN_ONLY_TARGETS, type StoredWrConfig } from "./webhook";

export const PUSH_MAX_ATTEMPTS = 12;

export type PushResult = {
  token: string;
  call_id: string;
  status: number;
  ok: boolean;
  deduped?: boolean;
  error?: string;
};

const PLAYER_TARGETS = new Set(["phone_e164", "country", "language", "first_name", "last_name"]);

function sourceValue(r: NumberRow, req: RequestRow, from: string, wr: StoredWrConfig): string | null {
  if (from === "token") return r.token;
  if (from === "user_id") return r.user_id;
  if (from === "country") return r.country && r.country.length === 2 ? r.country : null;
  if (from === "language") return r.language && r.language.length >= 2 && r.language.length <= 8 ? r.language : null;
  if (from === "first_name") return r.first_name ? r.first_name.slice(0, 128) : null;
  if (from === "last_name") return r.last_name ? r.last_name.slice(0, 128) : null;
  if (from === "segment") return req.segment ?? r.segment ?? wr.playerSegment;
  if (from === "cohort") return req.cohort ?? r.cohort ?? wr.cohort ?? null;
  return null;
}

export function buildEvent(r: NumberRow, req: RequestRow, wr: StoredWrConfig) {
  if (!looksLikeToken(r.token) || r.token === r.real) {
    throw new Error(`refusing to send a real phone number to Platform (row ${r.id})`);
  }

  const player: Record<string, string> = { external_id: req.call_id };
  const data: Record<string, string> = {};

  for (const field of wr.fields) {
    if ((field.as as string) === "external_id") continue;
    const value = sourceValue(r, req, field.from, wr);
    if (value == null || value === "") continue;
    if ((TOKEN_ONLY_TARGETS as readonly string[]).includes(field.as) && value !== r.token) {
      throw new Error(`refusing to send a non-token value in ${field.as} (row ${r.id})`);
    }
    if (PLAYER_TARGETS.has(field.as)) player[field.as] = value;
    else data[field.as] = value;
  }

  if (!player.phone_e164) throw new Error(`phone_e164 is not mapped (row ${r.id})`);

  return {
    type: wr.eventType,
    event_id: `hn-${req.call_id}`,
    occurred_at: new Date().toISOString(),
    player,
    data,
  };
}

function requireWr() {
  const wr = getWrConfig();
  if (!wr.baseUrl || !wr.slug || !wr.apiKey) {
    throw new Error("set the Platform url, client slug and api key in the cabinet settings");
  }
  return { ...wr, url: `${wr.baseUrl.replace(/\/$/, "")}/webhook/clients/${wr.slug}/events` };
}

export async function pushRequest(req: RequestRow): Promise<PushResult> {
  const wr = requireWr();
  const record = getNumber(req.number_id);
  if (!record) {
    return { token: "", call_id: req.call_id, status: 0, ok: false, error: `number ${req.number_id} is gone` };
  }
  let event: ReturnType<typeof buildEvent>;
  try {
    event = buildEvent(record, req, wr);
  } catch (e) {
    console.error(`[hidden-numbers] ${(e as Error).message}`);
    markRequestPushAbandoned(req.call_id, (e as Error).message, PUSH_MAX_ATTEMPTS);
    return { token: record.token, call_id: req.call_id, status: 0, ok: false, error: (e as Error).message };
  }
  try {
    const response = await axios.post(wr.url, event, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${wr.apiKey}`,
        "x-client-event-id": event.event_id,
      },
      timeout: 15_000,
      validateStatus: () => true,
    });
    const body = response.data as { deduplicated?: boolean } | undefined;
    const ok = response.status === 202;
    if (ok) markRequestPushed(req.call_id);
    else markRequestPushFailed(req.call_id, `platform responded ${response.status}`, backoffSeconds(req.push_attempts + 1));
    return {
      token: record.token,
      call_id: req.call_id,
      status: response.status,
      ok,
      deduped: Boolean(body?.deduplicated),
    };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const error = err.code ?? err.message ?? "request failed";
    markRequestPushFailed(req.call_id, error, backoffSeconds(req.push_attempts + 1));
    return { token: record.token, call_id: req.call_id, status: 0, ok: false, error };
  }
}

export async function pushRequests(requests: RequestRow[], concurrency = 4): Promise<PushResult[]> {
  requireWr();
  const results: PushResult[] = new Array(requests.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < requests.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await pushRequest(requests[index]);
    }
  };

  const size = Math.max(1, Math.min(concurrency, requests.length));
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

export async function retryPushes(limit = 50): Promise<{ sent: number; failed: number }> {
  const due = duePushRequests(PUSH_MAX_ATTEMPTS, limit);
  if (due.length === 0) return { sent: 0, failed: 0 };
  let results: PushResult[];
  try {
    results = await pushRequests(due);
  } catch (e) {
    console.error(`[hidden-numbers] push retry skipped: ${(e as Error).message}`);
    return { sent: 0, failed: due.length };
  }
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

export function startPushRetryCron(pattern = "*/30 * * * * *"): Cron {
  return new Cron(pattern, { protect: true, name: "push-retry" }, async () => {
    try {
      await retryPushes();
    } catch (e) {
      console.error("[hidden-numbers] push retry failed", e);
    }
  });
}

export type LeadCall = {
  id: string;
  status: string | null;
  provider: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  transcript: string | null;
  summary: string | null;
  recordingUrl: string | null;
};

export type LeadTranscript = { available: boolean; calls: LeadCall[]; error?: string };

const asText = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export async function fetchLeadTranscript(leadId: string): Promise<LeadTranscript> {
  const wr = getWrConfig();
  if (!wr.baseUrl || !wr.slug || !wr.apiKey) {
    return { available: false, calls: [], error: "Platform connection is not configured" };
  }
  const url = `${wr.baseUrl.replace(/\/$/, "")}/v1/clients/${wr.slug}/leads/${encodeURIComponent(leadId)}`;
  try {
    const response = await axios.get(url, {
      headers: { authorization: `Bearer ${wr.apiKey}` },
      timeout: 15_000,
      validateStatus: () => true,
    });
    if (response.status === 404) return { available: false, calls: [], error: "lead not found in Platform" };
    if (response.status < 200 || response.status >= 300) {
      return { available: false, calls: [], error: `Platform responded ${response.status}` };
    }
    const raw = (response.data as { calls?: unknown[] } | null)?.calls ?? [];
    const calls: LeadCall[] = raw.map((c) => {
      const call = c as Record<string, unknown>;
      return {
        id: String(call.id ?? ""),
        status: asText(call.status),
        provider: asText(call.provider),
        startedAt: asText(call.startedAt),
        endedAt: asText(call.endedAt),
        durationSeconds: typeof call.durationSeconds === "number" ? call.durationSeconds : null,
        transcript: asText(call.transcript) ?? asText(call.transcription),
        summary: asText(call.summary) ?? asText(call.transcript_summary),
        recordingUrl: asText(call.recordingUrl) ?? asText(call.recording),
      };
    });
    return { available: calls.some((c) => c.transcript !== null), calls };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { available: false, calls: [], error: err.code ?? err.message ?? "request failed" };
  }
}
