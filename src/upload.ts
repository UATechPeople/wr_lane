import * as XLSX from "xlsx";

// Parses an uploaded CSV or XLSX file (SheetJS handles both) into full player
// records, matching the WinRiders client-integration list format (guide §2A / §2):
//   required: external_id, phone_e164
//   optional: first_name, last_name, country (ISO-3166-1), language (ISO-639-1)
//   targeting: segment (-> player_segment), cohort
// Only phone_e164 is secret — it gets tokenized later; everything else passes through.
//
// Auto-detection matches ONLY the canonical field names (plus obvious phone synonyms).
// Custom/localized headers are resolved via an explicit `headerMap` (your header ->
// our field), exactly like the guide's header map. We do NOT guess localized headers.

export type UploadRecord = {
  phone: string;
  user_id?: string;
  first_name?: string;
  last_name?: string;
  country?: string;
  language?: string;
  segment?: string;
  cohort?: string;
};

export type HeaderMap = Record<string, keyof UploadRecord>;

const FIELD_ALIASES: Record<keyof UploadRecord, string[]> = {
  phone: ["phone_e164", "phone", "number", "msisdn"],
  user_id: ["user_id", "external_id"],
  first_name: ["first_name"],
  last_name: ["last_name"],
  country: ["country"],
  language: ["language"],
  segment: ["segment", "player_segment"],
  cohort: ["cohort"],
};

export const FIELDS = Object.keys(FIELD_ALIASES) as (keyof UploadRecord)[];

function matchField(header: string): keyof UploadRecord | undefined {
  for (const field of FIELDS) {
    if (FIELD_ALIASES[field].includes(header)) return field;
  }
  return undefined;
}

// XLSX is a zip ("PK"); read raw. CSV is text — decode as UTF-8 ourselves, since
// SheetJS mis-reads UTF-8 CSV bytes as a legacy codepage and mangles Cyrillic.
function readRows(buf: ArrayBuffer): unknown[][] {
  const bytes = new Uint8Array(buf);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const wb = isZip
    ? XLSX.read(bytes, { type: "array" })
    : XLSX.read(new TextDecoder("utf-8").decode(bytes), { type: "string" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
    header: 1,
    blankrows: false,
    raw: false,
  });
}

type Resolved = { colOf: Partial<Record<keyof UploadRecord, number>>; start: number };

function resolveColumns(rows: unknown[][], headerMap?: HeaderMap): Resolved {
  const header = rows[0].map((c) => String(c ?? "").trim().toLowerCase());
  const explicit: HeaderMap = {};
  if (headerMap) {
    for (const [k, v] of Object.entries(headerMap)) explicit[k.trim().toLowerCase()] = v;
  }

  const colOf: Partial<Record<keyof UploadRecord, number>> = {};
  header.forEach((h, i) => {
    const field = explicit[h] ?? matchField(h);
    if (field && colOf[field] === undefined) colOf[field] = i;
  });

  let start = 1;
  if (colOf.phone === undefined) {
    colOf.phone = 0;
    const c0 = String(rows[0][0] ?? "");
    start = /\d{6,}/.test(c0) ? 0 : 1;
  }
  return { colOf, start };
}

function extract(rows: unknown[][], colOf: Resolved["colOf"], from: number, to: number): UploadRecord[] {
  const cell = (row: unknown[], f: keyof UploadRecord): string | undefined => {
    const i = colOf[f];
    if (i === undefined) return undefined;
    const v = String(row[i] ?? "").trim();
    return v === "" ? undefined : v;
  };
  const out: UploadRecord[] = [];
  for (let i = from; i < to; i += 1) {
    const phone = cell(rows[i], "phone");
    if (!phone) continue;
    out.push({
      phone,
      user_id: cell(rows[i], "user_id"),
      first_name: cell(rows[i], "first_name"),
      last_name: cell(rows[i], "last_name"),
      country: cell(rows[i], "country"),
      language: cell(rows[i], "language"),
      segment: cell(rows[i], "segment"),
      cohort: cell(rows[i], "cohort"),
    });
  }
  return out;
}

export function parseRecords(buf: ArrayBuffer, headerMap?: HeaderMap): UploadRecord[] {
  const rows = readRows(buf);
  if (rows.length === 0) return [];
  const { colOf, start } = resolveColumns(rows, headerMap);
  return extract(rows, colOf, start, rows.length);
}

export type Preview = {
  headers: string[];
  mapping: Partial<Record<keyof UploadRecord, string>>;
  unmappedHeaders: string[];
  sample: UploadRecord[];
  rowCount: number;
};

// Parses headers + a few sample rows WITHOUT storing — drives the UI column mapper.
export function previewFile(buf: ArrayBuffer, headerMap?: HeaderMap): Preview {
  const rows = readRows(buf);
  if (rows.length === 0) {
    return { headers: [], mapping: {}, unmappedHeaders: [], sample: [], rowCount: 0 };
  }
  const headers = rows[0].map((c) => String(c ?? "").trim());
  const { colOf, start } = resolveColumns(rows, headerMap);

  const mapping: Partial<Record<keyof UploadRecord, string>> = {};
  const usedCols = new Set<number>();
  for (const f of FIELDS) {
    const i = colOf[f];
    if (i !== undefined && i < headers.length) {
      mapping[f] = headers[i];
      usedCols.add(i);
    }
  }
  const unmappedHeaders = headers.filter((_, i) => !usedCols.has(i));

  return {
    headers,
    mapping,
    unmappedHeaders,
    sample: extract(rows, colOf, start, Math.min(start + 5, rows.length)),
    rowCount: Math.max(rows.length - start, 0),
  };
}
