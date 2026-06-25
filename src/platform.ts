import { config } from "./config";
import type { NumberRow } from "./db";

// Pushes records to Platform via the documented client-integration API (guide §2):
//   POST {WR_BASE_URL}/webhook/clients/{slug}/events
//   Authorization: Bearer {api_key}
//   { type, event_id, occurred_at,
//     player: { external_id, phone_e164, first_name?, last_name?, country?, language? },
//     data:   { player_segment, cohort? } }
// phone_e164 carries the TOKEN; player_segment makes Platform build a segment.
// event_id makes retries idempotent (WR dedupes on it). 202 = received.

export type PushResult = {
  token: string;
  status: number;
  ok: boolean;
  deduped?: boolean;
  error?: string;
};

// Optional fields are included only when they satisfy platform'
// event-envelope.schema.ts, so one malformed value (e.g. country "Ukraine" instead
// of "UA") can't 400 the whole event.
function buildEvent(r: NumberRow) {
  const player: Record<string, string> = {
    external_id: (r.external_id ?? r.token).slice(0, 255),
    phone_e164: r.token,
  };
  if (r.first_name) player.first_name = r.first_name.slice(0, 128);
  if (r.last_name) player.last_name = r.last_name.slice(0, 128);
  if (r.country && r.country.length === 2) player.country = r.country;
  if (r.language && r.language.length >= 2 && r.language.length <= 8) player.language = r.language;

  const data: Record<string, string> = {
    player_segment: r.segment ?? config.platform.playerSegment,
  };
  const cohort = r.cohort ?? config.platform.cohort;
  if (cohort) data.cohort = cohort;

  return {
    type: config.platform.eventType,
    event_id: `hn-${r.token}`,
    occurred_at: new Date().toISOString(),
    player,
    data,
  };
}

export async function pushRecords(records: NumberRow[]): Promise<PushResult[]> {
  const wr = config.platform;
  if (!wr.baseUrl || !wr.slug || !wr.apiKey) {
    throw new Error("set WR_BASE_URL, WR_SLUG and WR_API_KEY to push to Platform");
  }
  const url = `${wr.baseUrl.replace(/\/$/, "")}/webhook/clients/${wr.slug}/events`;
  const results: PushResult[] = [];

  for (const r of records) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${wr.apiKey}` },
        body: JSON.stringify(buildEvent(r)),
      });
      let deduped = false;
      try {
        const j = (await res.json()) as { deduplicated?: boolean };
        deduped = Boolean(j?.deduplicated);
      } catch {
        // non-JSON body — ignore
      }
      results.push({ token: r.token, status: res.status, ok: res.status === 202, deduped });
    } catch (e) {
      results.push({ token: r.token, status: 0, ok: false, error: String((e as Error).message) });
    }
  }
  return results;
}
