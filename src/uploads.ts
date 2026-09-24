import { batchesForUpload, createBatch, getUpload, inTransaction, insertNumbers, insertRequests, uploadMembers, type FieldChange, type NewNumber, type NewRequest, createUpload } from "./db";
import { encryptPhone } from "./fpe";
import { validWebhookUrl } from "./hooks";
import type { UploadRecord } from "./upload";
import { BULK_PRIORITY } from "./winriders";

export type IngestRow = {
  real: string;
  token: string | null;
  ok: boolean;
  status: "new" | "known" | "rejected";
  changed?: FieldChange[];
  error?: string;
};

export type IngestSummary = { total: number; added: number; known: number; changed: number; rejected: number };

export function ingestRecords(records: UploadRecord[], label: string) {
  const accepted: { record: NewNumber; row: IngestRow }[] = [];
  const rows: IngestRow[] = records.map((rec) => {
    const webhook = rec.webhook_url?.trim() || null;
    if (webhook !== null && validWebhookUrl(webhook) === null) {
      return { real: rec.phone, token: null, ok: false, status: "rejected", error: "webhook_url must be an http(s) url" };
    }
    try {
      const token = encryptPhone(rec.phone);
      const row: IngestRow = { real: rec.phone, token, ok: true, status: "new" };
      accepted.push({
        record: {
          real: rec.phone,
          token,
          user_id: rec.user_id,
          first_name: rec.first_name,
          last_name: rec.last_name,
          country: rec.country,
          language: rec.language,
          segment: rec.segment,
          cohort: rec.cohort,
          webhook_url: webhook ?? undefined,
        },
        row,
      });
      return row;
    } catch (e) {
      return { real: rec.phone, token: null, ok: false, status: "rejected", error: String((e as Error).message) };
    }
  });
  const uploadId = inTransaction(() => {
    const id = createUpload(label);
    const inserted = insertNumbers(
      id,
      accepted.map((a) => a.record),
    );
    inserted.forEach((result, i) => {
      const row = accepted[i].row;
      if (result.existed) row.status = "known";
      if (result.changed.length > 0) row.changed = result.changed;
    });
    return id;
  });
  const summary: IngestSummary = {
    total: rows.length,
    added: rows.filter((r) => r.status === "new").length,
    known: rows.filter((r) => r.status === "known").length,
    changed: rows.filter((r) => (r.changed?.length ?? 0) > 0).length,
    rejected: rows.filter((r) => r.status === "rejected").length,
  };
  return { uploadId, accepted: summary.added + summary.known, total: rows.length, summary, rows };
}

export type SendResult = { batchId: number } | { conflict: number[] } | { error: string; status: number };

export function sendUpload(uploadId: number, force = false): SendResult {
  const upload = getUpload(uploadId);
  if (!upload) return { error: "not found", status: 404 };
  return inTransaction(() => {
    const members = uploadMembers(uploadId);
    if (members.length === 0) return { error: "this upload has no numbers", status: 422 };
    const earlier = batchesForUpload(uploadId);
    if (earlier.length > 0 && !force) return { conflict: earlier };
    const batchId = createBatch({ source: "upload", label: upload.label, uploadId });
    const requests: NewRequest[] = members.map((m) => ({
      call_id: crypto.randomUUID(),
      number_id: m.number_id,
      webhook_url: m.webhook_url,
      segment: m.segment,
      cohort: m.cohort,
      batch_id: batchId,
      priority: BULK_PRIORITY,
    }));
    insertRequests(requests);
    return { batchId };
  });
}
