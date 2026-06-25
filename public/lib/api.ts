export type Row = {
  id: number;
  real: string;
  token: string;
  external_id: string | null;
  first_name: string | null;
  segment: string | null;
  pushed_at: string | null;
};

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

export type PushResult = { sent: number; total: number; deduped: number; failed: number; error?: string };

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

const json = (r: Response) => r.json();

export const api = {
  me: (): Promise<{ user: string }> =>
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
  list: (page: number, size: number, q?: string): Promise<{ total: number; numbers: Row[] }> =>
    fetch(`/api/numbers?limit=${size}&offset=${page * size}${q ? `&q=${encodeURIComponent(q)}` : ""}`).then(json),
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
  push: (): Promise<PushResult> => fetch("/api/push", { method: "POST" }).then(json),
  patch: (id: number, body: Record<string, string>): Promise<Row & { error?: string }> =>
    fetch(`/api/numbers/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(json),
  remove: (id: number): Promise<unknown> => fetch(`/api/numbers/${id}`, { method: "DELETE" }).then(json),
};
