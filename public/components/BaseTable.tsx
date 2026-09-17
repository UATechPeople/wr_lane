import { CloudArrowUpIcon, DocumentTextIcon, PaperAirplaneIcon, PencilSquareIcon, TrashIcon } from "@heroicons/react/24/outline";
import type { Row } from "../lib/api";
import { StatusBadge } from "./StatusBadge";

function Action({
  title,
  onClick,
  tone = "neutral",
  children,
}: {
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
        : "text-neutral-400 hover:bg-neutral-100 hover:text-neutral-800";
  return (
    <button onClick={onClick} title={title} aria-label={title} className={`rounded-lg p-1.5 transition ${color}`}>
      {children}
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
                    <Action title="Transcript" onClick={() => onTranscript(r)}>
                      <DocumentTextIcon className="h-4 w-4" />
                    </Action>
                  )}
                  <Action title={`Resend to CRM${r.delivery_error ? ` — last error: ${r.delivery_error}` : ""}`} onClick={() => onResend(r)} tone="brand">
                    <PaperAirplaneIcon className="h-4 w-4" />
                  </Action>
                  <Action title="Push to Platform" onClick={() => onPushAgain(r)} tone="brand">
                    <CloudArrowUpIcon className="h-4 w-4" />
                  </Action>
                  <Action title="Edit" onClick={() => onEdit(r)}>
                    <PencilSquareIcon className="h-4 w-4" />
                  </Action>
                  <Action title="Delete" onClick={() => onDelete(r)} tone="danger">
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
