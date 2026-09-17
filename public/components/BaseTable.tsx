import { CloudArrowUpIcon, DocumentTextIcon, PaperAirplaneIcon, PencilSquareIcon, TrashIcon } from "@heroicons/react/24/outline";
import type { Row } from "../lib/api";
import { StatusBadge } from "./StatusBadge";

function Action({
  label,
  title,
  onClick,
  tone = "neutral",
  children,
}: {
  label: string;
  title: string;
  onClick: () => void;
  tone?: "neutral" | "brand" | "danger";
  children: React.ReactNode;
}) {
  const color =
    tone === "danger"
      ? "text-red-500 hover:bg-red-50 hover:text-red-700"
      : tone === "brand"
        ? "text-brand-600 hover:bg-brand-50 hover:text-brand-800"
        : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900";
  return (
    <button onClick={onClick} title={title} className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold transition ${color}`}>
      {children}
      <span>{label}</span>
    </button>
  );
}

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
  onPushAgain,
  onTranscript,
}: {
  rows: Row[];
  searching: boolean;
  onEdit: (r: Row) => void;
  onDelete: (r: Row) => void;
  onResend: (r: Row) => void;
  onPushAgain: (r: Row) => void;
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
              <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex items-center justify-end gap-0.5">
                  {r.external_id && (
                    <Action label="transcript" title="Show the conversation from Platform" onClick={() => onTranscript(r)}>
                      <DocumentTextIcon className="h-4 w-4" />
                    </Action>
                  )}
                  <Action label="resend to CRM" title={`Post the call result to your CRM again${r.delivery_error ? ` — last error: ${r.delivery_error}` : ""}`} onClick={() => onResend(r)} tone="brand">
                    <PaperAirplaneIcon className="h-4 w-4" />
                  </Action>
                  <Action label="push to Platform" title="Send the requests for this number to Platform again" onClick={() => onPushAgain(r)} tone="brand">
                    <CloudArrowUpIcon className="h-4 w-4" />
                  </Action>
                  <Action label="edit" title="Edit this number" onClick={() => onEdit(r)}>
                    <PencilSquareIcon className="h-4 w-4" />
                  </Action>
                  <Action label="delete" title="Delete this number from the cabinet" onClick={() => onDelete(r)} tone="danger">
                    <TrashIcon className="h-4 w-4" />
                  </Action>
                </div>
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
