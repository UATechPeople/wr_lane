import { Modal } from "./Modal";
import { Button } from "./Button";
import { StatusBadge } from "./StatusBadge";
import type { RequestRow, Row } from "../lib/api";

const DELIVERY_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  delivered: "success",
  pending: "neutral",
  retrying: "warning",
  exhausted: "danger",
};

function when(value: string | null): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 19);
}

function payloadText(raw: string | null): string {
  if (!raw) return "—";
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return raw;
  }
}

export function RequestsDialog({
  row,
  requests,
  busy,
  onClose,
  onResend,
}: {
  row: Row | null;
  requests: RequestRow[] | null;
  busy: boolean;
  onClose: () => void;
  onResend: (callId: string) => void;
}) {
  if (!row) return null;

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Calls for this number"
      description={`${row.real} · token ${row.token} · newest first, times in UTC`}
      size="lg"
      footer={
        <Button mode="function" onClick={onClose}>
          Close
        </Button>
      }
    >
      {requests === null ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="text-sm text-neutral-500">No calls were requested for this number yet.</p>
      ) : (
        <div className="-mr-2 flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-2">
          {requests.map((r) => (
            <div key={r.call_id} className="rounded-xl border border-neutral-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-neutral-500">{when(r.created_at)}</span>
                {r.cohort && <StatusBadge label={`${r.segment ?? ""}${r.segment ? " / " : ""}${r.cohort}`} tone="neutral" dot={false} />}
                {r.result ? (
                  <StatusBadge label={r.result} tone="info" dot={false} />
                ) : r.outcome ? (
                  <span className="font-mono text-xs text-neutral-400">{r.outcome}</span>
                ) : (
                  <span className="text-xs text-neutral-400">no result yet</span>
                )}
                {r.delivery_status && (
                  <span title={r.delivery_error ?? undefined}>
                    <StatusBadge label={`CRM: ${r.delivery_status}`} tone={DELIVERY_TONE[r.delivery_status] ?? "neutral"} />
                  </span>
                )}
                <span title={r.push_error ?? undefined}>
                  <StatusBadge
                    label={r.pushed_at ? "WinRiders: sent" : r.push_attempts ? `WinRiders: retrying (${r.push_attempts})` : "WinRiders: queued"}
                    tone={r.pushed_at ? "success" : r.push_error ? "warning" : "neutral"}
                  />
                </span>
                {r.result && (
                  <Button mode="function" disabled={busy} onClick={() => onResend(r.call_id)}>
                    resend to CRM
                  </Button>
                )}
              </div>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs text-neutral-600">
                <dt className="text-neutral-400">call_id</dt>
                <dd className="break-all">{r.call_id}</dd>
                <dt className="text-neutral-400">webhook_url</dt>
                <dd className="break-all">{r.webhook_url ?? "address from Settings"}</dd>
                <dt className="text-neutral-400">payload</dt>
                <dd className="break-all">{payloadText(r.payload)}</dd>
                <dt className="text-neutral-400">result at</dt>
                <dd>{when(r.result_at)}</dd>
                <dt className="text-neutral-400">delivered at</dt>
                <dd>{when(r.delivered_at)}</dd>
                {r.lead_id && (
                  <>
                    <dt className="text-neutral-400">lead</dt>
                    <dd className="break-all">{r.lead_id}</dd>
                  </>
                )}
              </dl>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
