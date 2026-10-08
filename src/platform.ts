import axios from "axios";
import { Cron } from "croner";
import {
  duePushRequests,
  getNumber,
  getSetting,
  markRequestPushAbandoned,
  markRequestPushFailed,
  markRequestPushDeferred,
  markRequestPushed,
  markRequestTried,
  pushAttemptsInLastMinute,
  pushQueueStats,
  setSetting,
  type NumberRow,
  type RequestRow,
} from "./db";
import { backoffSeconds } from "./outbox";
import { looksLikeToken } from "./fpe";
import { getPlatformConfig, TOKEN_ONLY_TARGETS, type StoredPlatformConfig } from "./webhook";
import { pushBlockedReason } from "./core";

export const PUSH_MAX_ATTEMPTS = 12;

const KEY_REJECTED_PAUSE_S = 300;

let keyRejectedAt: number | null = null;

function keyRejectedReason(): string | null {
  if (keyRejectedAt === null) return null;
  if (Date.now() - keyRejectedAt > KEY_REJECTED_PAUSE_S * 1000) {
    keyRejectedAt = null;
    return null;
  }
  return "The platform rejected the cabinet key; sending is paused for five minutes without using up attempts";
}

export type PushResult = {
  token: string;
  call_id: string;
  status: number;
  ok: boolean;
  deduped?: boolean;
  error?: string;
};

const PLAYER_TARGETS = new Set(["phone_e164", "country", "language", "first_name", "last_name"]);

function sourceValue(r: NumberRow, req: RequestRow, from: string, platform: StoredPlatformConfig): string | null {
  if (from === "token") return r.token;
  if (from === "user_id") return r.user_id;
  if (from === "country") return r.country && r.country.length === 2 ? r.country : null;
  if (from === "language") return r.language && r.language.length >= 2 && r.language.length <= 8 ? r.language : null;
  if (from === "first_name") return r.first_name ? r.first_name.slice(0, 128) : null;
  if (from === "last_name") return r.last_name ? r.last_name.slice(0, 128) : null;
  if (from === "segment") return req.segment ?? r.segment ?? platform.playerSegment;
  if (from === "cohort") return req.cohort ?? r.cohort ?? platform.cohort ?? null;
  return null;
}

export function buildEvent(r: NumberRow, req: RequestRow, platform: StoredPlatformConfig) {
  if (!looksLikeToken(r.token) || r.token === r.real) {
    throw new Error(`refusing to send a real phone number to the platform (row ${r.id})`);
  }

  const player: Record<string, string> = { external_id: req.call_id };
  const data: Record<string, string> = {};
  const realTail = r.real.replace(/\D/g, "").slice(-8);

  for (const field of platform.fields) {
    if ((field.as as string) === "external_id") continue;
    const value = sourceValue(r, req, field.from, platform);
    if (value == null || value === "") continue;
    if ((TOKEN_ONLY_TARGETS as readonly string[]).includes(field.as)) {
      if (value !== r.token) throw new Error(`refusing to send a non-token value in ${field.as} (row ${r.id})`);
    } else if (realTail && value.replace(/\D/g, "").includes(realTail)) {
      throw new Error(`refusing to send a real phone number in ${field.as} (row ${r.id})`);
    }
    if (PLAYER_TARGETS.has(field.as)) player[field.as] = value;
    else data[field.as] = value;
  }

  if (!player.phone_e164) throw new Error(`phone_e164 is not mapped (row ${r.id})`);

  return {
    type: platform.eventType,
    event_id: `hn-${req.call_id}`,
    occurred_at: new Date().toISOString(),
    player,
    data,
  };
}

function requirePlatform() {
  const platform = getPlatformConfig();
  if (!platform.baseUrl || !platform.slug || !platform.apiKey) {
    throw new Error("set the platform url, client slug and api key in the cabinet settings");
  }
  return { ...platform, url: `${platform.baseUrl.replace(/\/$/, "")}/webhook/clients/${platform.slug}/events` };
}

export async function pushRequest(req: RequestRow): Promise<PushResult> {
  const platform = requirePlatform();
  const record = getNumber(req.number_id);
  if (!record) {
    const error = `number ${req.number_id} is gone`;
    markRequestPushAbandoned(req.call_id, error, PUSH_MAX_ATTEMPTS);
    return { token: "", call_id: req.call_id, status: 0, ok: false, error };
  }
  let event: ReturnType<typeof buildEvent>;
  try {
    event = buildEvent(record, req, platform);
  } catch (e) {
    console.error(`[hidden-numbers] ${(e as Error).message}`);
    markRequestPushAbandoned(req.call_id, (e as Error).message, PUSH_MAX_ATTEMPTS);
    return { token: record.token, call_id: req.call_id, status: 0, ok: false, error: (e as Error).message };
  }
  markRequestTried(req.call_id);
  try {
    const response = await axios.post(platform.url, event, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${platform.apiKey}`,
        "x-client-event-id": event.event_id,
      },
      timeout: 15_000,
      validateStatus: () => true,
    });
    const body = response.data as { deduplicated?: boolean } | undefined;
    const ok = response.status === 202;
    if (ok) {
      markRequestPushed(req.call_id);
      keyRejectedAt = null;
    } else if (response.status === 401 || response.status === 403) {
      keyRejectedAt = Date.now();
      markRequestPushDeferred(req.call_id, `The platform rejected the key (${response.status})`, KEY_REJECTED_PAUSE_S);
    } else {
      markRequestPushFailed(req.call_id, `The platform responded ${response.status}`, backoffSeconds(req.push_attempts + 1));
    }
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
  requirePlatform();
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

export const PUSH_RATE_SETTING = "push_rate_per_min";
export const DEFAULT_PUSH_RATE_PER_MIN = 100;
export const MAX_PUSH_RATE_PER_MIN = 6000;
export const LIVE_PRIORITY = 0;
export const BULK_PRIORITY = 1;
export const LIVE_BATCH_MAX = 20;
const BULK_SHARE = 0.2;
const TICKS_PER_MINUTE = 12;

export function getPushRate(): number {
  const parsed = Number(getSetting(PUSH_RATE_SETTING));
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_PUSH_RATE_PER_MIN;
  return Math.min(parsed, MAX_PUSH_RATE_PER_MIN);
}

export function setPushRate(rate: number): number {
  if (!Number.isInteger(rate) || rate < 1 || rate > MAX_PUSH_RATE_PER_MIN) {
    throw new Error(`push rate must be a whole number from 1 to ${MAX_PUSH_RATE_PER_MIN} per minute`);
  }
  setSetting(PUSH_RATE_SETTING, String(rate));
  return rate;
}

export function tickBudget(ratePerMinute: number, attemptsLastMinute: number): number {
  return Math.max(0, Math.min(Math.ceil(ratePerMinute / TICKS_PER_MINUTE), ratePerMinute - attemptsLastMinute));
}

export function pickDueRequests(budget: number): RequestRow[] {
  if (budget <= 0) return [];
  const bulkReserve = Math.floor(budget * BULK_SHARE);
  const live = duePushRequests(PUSH_MAX_ATTEMPTS, budget - bulkReserve, LIVE_PRIORITY);
  const bulk = duePushRequests(PUSH_MAX_ATTEMPTS, budget - live.length, BULK_PRIORITY);
  return [...live, ...bulk];
}

function platformConfigured(): boolean {
  const platform = getPlatformConfig();
  return Boolean(platform.baseUrl && platform.slug && platform.apiKey);
}

export type DrainResult = { sent: number; failed: number; budget: number; skipped?: string };

export async function drainPushQueue(): Promise<DrainResult> {
  if (!platformConfigured()) return { sent: 0, failed: 0, budget: 0, skipped: "The platform connection is not configured" };
  const blocked = pushBlockedReason() ?? keyRejectedReason();
  if (blocked) return { sent: 0, failed: 0, budget: 0, skipped: blocked };
  const budget = tickBudget(getPushRate(), pushAttemptsInLastMinute());
  const due = pickDueRequests(budget);
  if (due.length === 0) return { sent: 0, failed: 0, budget };
  const results = await pushRequests(due);
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, budget };
}

const worker = { running: false, rerun: false, lastRunAt: null as string | null, lastError: null as string | null };

async function runPushWorker(): Promise<void> {
  worker.running = true;
  try {
    do {
      worker.rerun = false;
      await drainPushQueue();
      worker.lastError = null;
    } while (worker.rerun);
  } catch (e) {
    worker.lastError = (e as Error).message;
    console.error("[hidden-numbers] push worker failed", e);
  } finally {
    worker.running = false;
    worker.lastRunAt = new Date().toISOString();
  }
}

export function kickPushWorker(): void {
  if (worker.running) {
    worker.rerun = true;
    return;
  }
  void runPushWorker();
}

export function pushWorkerIdle(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => (worker.running ? setTimeout(check, 10) : resolve());
    check();
  });
}

export function pushQueueHealth() {
  const stats = pushQueueStats(PUSH_MAX_ATTEMPTS);
  const oldestAgeSeconds = stats.oldestPendingAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(`${stats.oldestPendingAt.replace(" ", "T")}Z`)) / 1000))
    : null;
  return {
    pending: stats.pending,
    due: stats.due,
    abandoned: stats.abandoned,
    oldest_pending_age_seconds: oldestAgeSeconds,
    rate_per_min: getPushRate(),
    attempts_last_minute: pushAttemptsInLastMinute(),
    platform_configured: platformConfigured(),
    blocked: pushBlockedReason() ?? keyRejectedReason(),
    worker_running: worker.running,
    worker_last_run_at: worker.lastRunAt,
    worker_last_error: worker.lastError,
  };
}

export function retryPushes(): { queued: number } {
  kickPushWorker();
  return { queued: pushQueueStats(PUSH_MAX_ATTEMPTS).due };
}

export function startPushWorkerCron(pattern = "*/5 * * * * *"): Cron {
  return new Cron(pattern, { name: "push-worker" }, () => kickPushWorker());
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
  const platform = getPlatformConfig();
  if (!platform.baseUrl || !platform.slug || !platform.apiKey) {
    return { available: false, calls: [], error: "The platform connection is not configured" };
  }
  const url = `${platform.baseUrl.replace(/\/$/, "")}/v1/clients/${platform.slug}/leads/${encodeURIComponent(leadId)}`;
  try {
    const response = await axios.get(url, {
      headers: { authorization: `Bearer ${platform.apiKey}` },
      timeout: 15_000,
      validateStatus: () => true,
    });
    if (response.status === 404) return { available: false, calls: [], error: "lead not found in the platform" };
    if (response.status < 200 || response.status >= 300) {
      return { available: false, calls: [], error: `The platform responded ${response.status}` };
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
