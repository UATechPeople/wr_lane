import type { Row } from "../lib/api";
import { StatusBadge } from "./StatusBadge";

const DELIVERY_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  delivered: "success",
  pending: "neutral",
  retrying: "warning",
  exhausted: "danger",
};

export function BaseTable({
  rows,
  searching,
  onEdit,
  onDelete,
  onResend,
  onTranscript,
}: {
  rows: Row[];
  searching: boolean;
  onEdit: (r: Row) => void;
  onDelete: (r: Row) => void;
  onResend: (r: Row) => void;
  onTranscript: (r: Row) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <table className="w-full table-auto text-left text-sm">
        <thead className="border-b border-neutral-200 bg-neutral-50">
          <tr>
            {["Real", "Token", "User ID", "Result", "Delivery", "Pushed"].map((h) => (
              <th key={h} className="whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                {h}
              </th>
            ))}
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.map((r) => (
            <tr key={r.id} className="transition-colors hover:bg-neutral-50/60">
              <td className="whitespace-nowrap px-4 py-3 font-mono text-neutral-800">{r.real}</td>
              <td className="whitespace-nowrap px-4 py-3 font-mono text-neutral-500">{r.token}</td>
              <td className="whitespace-nowrap px-4 py-3 text-neutral-600">{r.user_id ?? <span className="text-neutral-300">—</span>}</td>
              <td className="whitespace-nowrap px-4 py-3">
                {r.result ? (
                  <StatusBadge label={r.result} tone="info" dot={false} />
                ) : r.outcome ? (
                  <span title="outcome has no mapping" className="font-mono text-xs text-neutral-400">
                    {r.outcome}
                  </span>
                ) : (
                  <span className="text-neutral-300">—</span>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                {r.delivery_status ? (
                  <span title={r.delivery_error ?? undefined}>
                    <StatusBadge label={r.delivery_status} tone={DELIVERY_TONE[r.delivery_status] ?? "neutral"} />
                  </span>
                ) : (
                  <span className="text-neutral-300">—</span>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                {r.pushed_at ? <StatusBadge label="sent" tone="success" /> : <span className="text-neutral-300">—</span>}
              </td>
              <td className="px-4 py-3 text-right whitespace-nowrap">
                {r.external_id && (
                  <button
                    onClick={() => onTranscript(r)}
                    title="Show the conversation from Platform"
                    className="mr-1 rounded-lg px-2.5 py-1 text-xs font-semibold text-neutral-700 transition hover:bg-neutral-100"
                  >
                    transcript
                  </button>
                )}
                {r.delivery_status && (
                  <button
                    onClick={() => onResend(r)}
                    title={r.delivery_error ?? "Send this result to your CRM again"}
                    className="mr-1 rounded-lg px-2.5 py-1 text-xs font-semibold text-brand-700 transition hover:bg-brand-50"
                  >
                    resend
                  </button>
                )}
                <button
                  onClick={() => onEdit(r)}
                  className="mr-1 rounded-lg px-2.5 py-1 text-xs font-semibold text-neutral-700 transition hover:bg-neutral-100"
                >
                  edit
                </button>
                <button
                  onClick={() => onDelete(r)}
                  className="rounded-lg px-2.5 py-1 text-xs font-semibold text-red-600 transition hover:bg-red-50"
                >
                  delete
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-14 text-center text-neutral-400">
                {searching ? "No matches." : "No numbers yet — add some with the button above."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
