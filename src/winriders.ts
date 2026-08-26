import axios from "axios";
import type { NumberRow } from "./db";
import { looksLikeToken } from "./fpe";
import { getWrConfig, TOKEN_ONLY_TARGETS, type StoredWrConfig } from "./webhook";

// Pushes records to WinRiders via the documented client-integration API (guide §2):
//   POST {WR_BASE_URL}/webhook/clients/{slug}/events
//   Authorization: Bearer {api_key}
//   { type, event_id, occurred_at,
//     player: { external_id, phone_e164, first_name?, last_name?, country?, language? },
//     data:   { player_segment, cohort? } }
// phone_e164 carries the TOKEN; player_segment makes WinRiders build a segment.
// event_id makes retries idempotent (WR dedupes on it). 202 = received.

export type PushResult = {
  token: string;
  status: number;
  ok: boolean;
  deduped?: boolean;
  error?: string;
};

// Optional fields are included only when they satisfy winriders'
// event-envelope.schema.ts, so one malformed value (e.g. country "Ukraine" instead
// of "UA") can't 400 the whole event.
const PLAYER_TARGETS = new Set(["external_id", "phone_e164", "country", "language", "first_name", "last_name"]);

function sourceValue(r: NumberRow, from: string, wr: StoredWrConfig): string | null {
  if (from === "token") return r.token;
  if (from === "user_id") return r.user_id;
  if (from === "country") return r.country && r.country.length === 2 ? r.country : null;
  if (from === "language") return r.language && r.language.length >= 2 && r.language.length <= 8 ? r.language : null;
  if (from === "first_name") return r.first_name ? r.first_name.slice(0, 128) : null;
  if (from === "last_name") return r.last_name ? r.last_name.slice(0, 128) : null;
  if (from === "segment") return r.segment ?? wr.playerSegment;
  if (from === "cohort") return r.cohort ?? wr.cohort ?? null;
  return null;
}

function buildEvent(r: NumberRow, wr: StoredWrConfig) {
  if (!looksLikeToken(r.token) || r.token === r.real) {
    throw new Error(`refusing to send a real phone number to WinRiders (row ${r.id})`);
  }

  const player: Record<string, string> = {};
  const data: Record<string, string> = {};

  for (const field of wr.fields) {
    const value = sourceValue(r, field.from, wr);
    if (value == null || value === "") continue;
    if ((TOKEN_ONLY_TARGETS as readonly string[]).includes(field.as) && value !== r.token) {
      throw new Error(`refusing to send a non-token value in ${field.as} (row ${r.id})`);
    }
    if (PLAYER_TARGETS.has(field.as)) player[field.as] = value;
    else data[field.as] = value;
  }

  if (!player.external_id) throw new Error(`external_id is not mapped (row ${r.id})`);

  return {
    type: wr.eventType,
    event_id: `hn-${r.token}`,
    occurred_at: new Date().toISOString(),
    player,
    data,
  };
}

function requireWr() {
  const wr = getWrConfig();
  if (!wr.baseUrl || !wr.slug || !wr.apiKey) {
    throw new Error("set the WinRiders url, client slug and api key in the cabinet settings");
  }
  return { ...wr, url: `${wr.baseUrl.replace(/\/$/, "")}/webhook/clients/${wr.slug}/events` };
}

export async function pushRecord(record: NumberRow): Promise<PushResult> {
  const wr = requireWr();
  let event: ReturnType<typeof buildEvent>;
  try {
    event = buildEvent(record, wr);
  } catch (e) {
    console.error(`[hidden-numbers] ${(e as Error).message}`);
    return { token: record.token, status: 0, ok: false, error: (e as Error).message };
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
    return {
      token: record.token,
      status: response.status,
      ok: response.status === 202,
      deduped: Boolean(body?.deduplicated),
    };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { token: record.token, status: 0, ok: false, error: err.code ?? err.message ?? "request failed" };
  }
}

export async function pushRecords(records: NumberRow[], concurrency = 4): Promise<PushResult[]> {
  requireWr();
  const results: PushResult[] = new Array(records.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < records.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await pushRecord(records[index]);
    }
  };

  const size = Math.max(1, Math.min(concurrency, records.length));
  await Promise.all(Array.from({ length: size }, worker));
  return results;
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
    return { available: false, calls: [], error: "WinRiders connection is not configured" };
  }
  const url = `${wr.baseUrl.replace(/\/$/, "")}/v1/clients/${wr.slug}/leads/${encodeURIComponent(leadId)}`;
  try {
    const response = await axios.get(url, {
      headers: { authorization: `Bearer ${wr.apiKey}` },
      timeout: 15_000,
      validateStatus: () => true,
    });
    if (response.status === 404) return { available: false, calls: [], error: "lead not found in WinRiders" };
    if (response.status < 200 || response.status >= 300) {
      return { available: false, calls: [], error: `WinRiders responded ${response.status}` };
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
