import type { Row } from "../lib/api";
import { StatusBadge } from "./StatusBadge";

export function BaseTable({
  rows,
  searching,
  onEdit,
  onDelete,
}: {
  rows: Row[];
  searching: boolean;
  onEdit: (r: Row) => void;
  onDelete: (r: Row) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-neutral-200 bg-neutral-50">
          <tr>
            {["Real", "Token", "External ID", "Segment", "Pushed"].map((h) => (
              <th key={h} className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                {h}
              </th>
            ))}
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.map((r) => (
            <tr key={r.id} className="transition-colors hover:bg-neutral-50/60">
              <td className="px-4 py-3 font-mono text-neutral-800">{r.real}</td>
              <td className="px-4 py-3 font-mono text-neutral-500">{r.token}</td>
              <td className="px-4 py-3 text-neutral-600">{r.external_id ?? <span className="text-neutral-300">—</span>}</td>
              <td className="px-4 py-3">
                {r.segment ? <StatusBadge label={r.segment} tone="info" dot={false} /> : <span className="text-neutral-300">—</span>}
              </td>
              <td className="px-4 py-3">
                {r.pushed_at ? <StatusBadge label="sent" tone="success" /> : <span className="text-neutral-300">—</span>}
              </td>
              <td className="px-4 py-3 text-right whitespace-nowrap">
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
              <td colSpan={6} className="px-4 py-14 text-center text-neutral-400">
                {searching ? "No matches." : "No numbers yet — add some with the button above."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
