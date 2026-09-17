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
};

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

export type UploadResult = {
  accepted: number;
  total: number;
  rows: { real: string; ok: boolean; error?: string }[];
};


export const FIELDS: { key: string; label: string; required?: boolean }[] = [
  { key: "phone", label: "Phone → token", required: true },
  { key: "external_id", label: "External ID" },
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "country", label: "Country (ISO-2)" },
  { key: "language", label: "Language" },
  { key: "segment", label: "Segment" },
  { key: "cohort", label: "Cohort" },
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
  testCrm: (): Promise<TestResult> => fetch("/api/settings/test", { method: "POST" }).then(json),
  resend: (id: number): Promise<{ queued?: boolean; error?: string }> =>
    fetch(`/api/numbers/${id}/resend`, { method: "POST" }).then(json),
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
