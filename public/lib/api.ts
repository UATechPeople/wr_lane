export type Row = {
  id: number;
  real: string;
  token: string;
  user_id: string | null;
  external_id: string | null;
  first_name: string | null;
  segment: string | null;
  pushed_at: string | null;
  outcome: string | null;
  result: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
  requests_count: number;
  last_activity: string;
};

export type RequestRow = {
  call_id: string;
  webhook_url: string | null;
  payload: string | null;
  segment: string | null;
  cohort: string | null;
  created_at: string;
  pushed_at: string | null;
  push_error: string | null;
  push_attempts: number;
  lead_id: string | null;
  campaign_id: string | null;
  outcome: string | null;
  result: string | null;
  result_at: string | null;
  delivery_status: string | null;
  delivered_at: string | null;
  delivery_error: string | null;
};

export type TranscriptCall = {
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

export type Transcript = { available: boolean; calls: TranscriptCall[]; error?: string; leadId?: string };

export type CrmConfig = {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
};

export type WrField = { as: string; from: string };

export type WrConfig = {
  baseUrl: string;
  slug: string;
  apiKey: string;
  playerSegment: string;
  eventType: string;
  cohort?: string;
  fields: WrField[];
};

export type Settings = {
  crm: CrmConfig;
  wr: WrConfig;
  inboundKey: string | null;
  coreKey: string | null;
  defaults: CrmConfig;
  pushRatePerMin: number;
  trunks: TrunkKey[];
  keys: CabinetKeys;
};

export type CabinetKeys = {
  ff3Key: string;
  ff3Tweak: string;
  routeDigit: string;
  fingerprint: string;
  numbers: number;
  decryptKey: string;
  decryptKeyPending: boolean;
  cabinetUser: string;
  cabinetPassword: string;
};

export type EncryptionInput = { generate: true } | { ff3Key: string; ff3Tweak: string; routeDigit: string };

export type KeyChangeResult = { error?: string; reregistered?: string };

export type TrunkKey = { mode: "ipauth" | "digest" | "direct"; host: string; port: number; key: string; previousKeyAccepted: boolean };

export type TrunkKeyChange = { mode: string; key?: string; synced?: boolean; error?: string };

export type Batch = {
  id: number;
  source: "hook" | "upload";
  label: string | null;
  upload_id: number | null;
  created_at: string;
  total: number;
  pushed: number;
  queued: number;
  abandoned: number;
  results: number;
  delivered: number;
};

export type BatchError = { call_id: string; push_error: string | null; push_attempts: number };

export type QueueHealth = {
  pending: number;
  due: number;
  abandoned: number;
  oldest_pending_age_seconds: number | null;
  rate_per_min: number;
  attempts_last_minute: number;
  wr_configured: boolean;
  blocked: string | null;
  worker_running: boolean;
  worker_last_run_at: string | null;
  worker_last_error: string | null;
};

export type SendUploadInput = { force?: boolean };

export type SendUploadResult = { batch?: Batch; error?: string; batch_ids?: number[]; conflict?: boolean };

export type TestResult = {
  sent?: Record<string, unknown>;
  response?: { ok: boolean; status: number; error?: string };
  error?: string;
};

export type Upload = { id: number; label: string; created_at: string; count: number };

export type Preview = {
  headers: string[];
  mapping: Record<string, string>;
  unmappedHeaders: string[];
  sample: Record<string, string>[];
  rowCount: number;
};

export type ImportSummary = { total: number; added: number; known: number; changed: number; rejected: number };

export type UploadResult = {
  accepted: number;
  total: number;
  summary: ImportSummary;
  rows: { real: string; ok: boolean; status: "new" | "known" | "rejected"; changed?: { field: string; from: string | null; to: string }[]; error?: string }[];
};


export const FIELDS: { key: string; label: string; required?: boolean }[] = [
  { key: "phone", label: "Phone → token", required: true },
  { key: "user_id", label: "User ID" },
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "country", label: "Country (ISO-2)" },
  { key: "language", label: "Language" },
  { key: "segment", label: "Segment" },
  { key: "cohort", label: "Cohort" },
  { key: "webhook_url", label: "Result webhook" },
];

export function invertMap(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, header] of Object.entries(map)) if (header) out[header] = field;
  return out;
}

async function postFile<T>(url: string, file: File, headerMap?: Record<string, string>): Promise<T> {
  const fd = new FormData();
  fd.append("file", file);
  if (headerMap && Object.keys(headerMap).length) fd.append("header_map", JSON.stringify(headerMap));
  return fetch(url, { method: "POST", body: fd }).then((r) => r.json());
}

export type BuildInfo = { version: string; commit: string | null; builtAt: string | null };

const json = (r: Response) => r.json();

export const api = {
  me: (): Promise<{ user: string; build?: BuildInfo }> =>
    fetch("/api/me").then((r) => {
      if (!r.ok) throw new Error("unauthenticated");
      return r.json();
    }),
  login: (user: string, pass: string): Promise<{ ok: boolean; error?: string }> =>
    fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, pass }),
    }).then(async (r) => ({ ok: r.ok, ...(await r.json()) })),
  logout: (): Promise<unknown> => fetch("/api/logout", { method: "POST" }).then(json),
  list: (page: number, size: number, q?: string, uploadId?: number | null): Promise<{ total: number; numbers: Row[] }> =>
    fetch(
      `/api/numbers?limit=${size}&offset=${page * size}` +
        (q ? `&q=${encodeURIComponent(q)}` : "") +
        (uploadId != null ? `&upload_id=${uploadId}` : ""),
    ).then(json),
  uploads: (): Promise<{ uploads: Upload[] }> => fetch("/api/uploads").then(json),
  deleteUpload: (id: number): Promise<unknown> => fetch(`/api/uploads/${id}`, { method: "DELETE" }).then(json),
  preview: (file: File, headerMap?: Record<string, string>): Promise<Preview> =>
    postFile("/api/numbers/preview", file, headerMap),
  upload: (file: File, headerMap?: Record<string, string>): Promise<UploadResult & { error?: string }> =>
    postFile("/api/numbers/upload", file, headerMap),
  paste: (numbers: string[]): Promise<UploadResult> =>
    fetch("/api/numbers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ numbers }),
    }).then(json),
  transcript: (id: number): Promise<Transcript> => fetch(`/api/numbers/${id}/transcript`).then(json),
  settings: (): Promise<Settings> => fetch("/api/settings").then(json),
  saveCrm: (crm: CrmConfig): Promise<{ crm?: CrmConfig; error?: string }> =>
    fetch("/api/settings/crm", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(crm),
    }).then(json),
  saveWr: (wr: WrConfig): Promise<{ wr?: WrConfig; error?: string }> =>
    fetch("/api/settings/wr", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wr),
    }).then(json),
  rotateKey: (which: "inbound" | "core"): Promise<{ key: string }> =>
    fetch(`/api/settings/keys/${which}`, { method: "POST" }).then(json),
  changeEncryption: (input: EncryptionInput): Promise<KeyChangeResult> =>
    fetch("/api/settings/encryption", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }).then(json),
  changeLogin: (user: string, password: string): Promise<KeyChangeResult> =>
    fetch("/api/settings/login", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ user, password }) }).then(json),
  changeDecryptKey: (key?: string): Promise<KeyChangeResult> =>
    fetch("/api/settings/decrypt-key", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(key ? { key } : {}) }).then(json),
  changeTrunkKey: (mode: string, key?: string): Promise<TrunkKeyChange> =>
    fetch(`/api/settings/trunks/${mode}/key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(key ? { key } : {}),
    }).then(json),
  testCrm: (): Promise<TestResult> => fetch("/api/settings/test", { method: "POST" }).then(json),
  resend: (id: number): Promise<{ queued?: boolean; error?: string }> =>
    fetch(`/api/numbers/${id}/resend`, { method: "POST" }).then(json),
  requests: (id: number): Promise<{ requests: RequestRow[]; error?: string }> => fetch(`/api/numbers/${id}/requests`).then(json),
  resendRequest: (callId: string): Promise<{ queued?: boolean; error?: string }> =>
    fetch(`/api/requests/${callId}/resend`, { method: "POST" }).then(json),
  savePushRate: (rate: number): Promise<{ pushRatePerMin?: number; error?: string }> =>
    fetch("/api/settings/push", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rate }),
    }).then(json),
  sendUpload: (id: number, input: SendUploadInput): Promise<SendUploadResult> =>
    fetch(`/api/uploads/${id}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then(async (r) => ({ ...(await r.json()), conflict: r.status === 409 })),
  batches: (offset = 0, limit = 20): Promise<{ batches: Batch[]; total: number }> => fetch(`/api/batches?offset=${offset}&limit=${limit}`).then(json),
  batch: (id: number): Promise<{ batch?: Batch; errors?: BatchError[]; error?: string }> => fetch(`/api/batches/${id}`).then(json),
  retryBatch: (id: number): Promise<{ requeued?: number; error?: string }> =>
    fetch(`/api/batches/${id}/retry`, { method: "POST" }).then(json),
  health: (): Promise<{ queue: QueueHealth }> => fetch("/health").then(json),
  pushAgain: (id: number): Promise<{ sent?: number; failed?: number; error?: string }> =>
    fetch(`/api/numbers/${id}/push`, { method: "POST" }).then(json),

  patch: (id: number, body: Record<string, string>): Promise<Row & { error?: string }> =>
    fetch(`/api/numbers/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(json),
  remove: (id: number): Promise<unknown> => fetch(`/api/numbers/${id}`, { method: "DELETE" }).then(json),
};
