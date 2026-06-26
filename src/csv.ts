import type { NumberRow } from "./db";

// Emits rows in the WinRiders client-integration "core" list shape, with the TOKEN in
// the phone_e164 column — re-importable anywhere as a tokenized segment, zero PII.
const HEADER = ["external_id", "phone_e164", "first_name", "last_name", "country", "language", "segment", "cohort"];

function esc(v: string | null): string {
  const s = v ?? "";
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCoreCsv(rows: NumberRow[]): string {
  const lines = [HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [esc(r.external_id), esc(r.token), esc(r.first_name), esc(r.last_name), esc(r.country), esc(r.language), esc(r.segment), esc(r.cohort)].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
