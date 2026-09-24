import { ArrowDownTrayIcon, PaperAirplaneIcon, TrashIcon } from "@heroicons/react/24/outline";
import type { Upload } from "../lib/api";
import { cn } from "../lib/cn";

export function UploadsSidebar({
  uploads,
  total,
  selected,
  onSelect,
  onDelete,
  onSend,
  streamLabel,
}: {
  uploads: Upload[];
  total: number;
  selected: number | null;
  onSelect: (id: number | null) => void;
  onDelete: (u: Upload) => void;
  onSend: (u: Upload) => void;
  streamLabel: string;
}) {
  const rowBase = "group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition";
  return (
    <aside className="w-60 shrink-0">
      <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">Uploads</div>
      <nav className="space-y-0.5">
        <button
          onClick={() => onSelect(null)}
          className={cn(rowBase, selected === null ? "bg-neutral-950 text-white" : "text-neutral-700 hover:bg-neutral-100")}
        >
          <span className="flex-1 font-medium">All numbers</span>
          <span className={cn("text-xs", selected === null ? "text-neutral-300" : "text-neutral-400")}>{total}</span>
        </button>

        {uploads.map((u) => {
          const active = selected === u.id;
          return (
            <div
              key={u.id}
              className={cn(rowBase, active ? "bg-neutral-950 text-white" : "text-neutral-700 hover:bg-neutral-100")}
            >
              <button onClick={() => onSelect(u.id)} className="flex min-w-0 flex-1 flex-col items-start">
                <span className="w-full truncate font-medium">{u.label}</span>
                <span className={cn("text-xs", active ? "text-neutral-400" : "text-neutral-400")}>
                  {u.count} · {u.created_at.slice(0, 10)}
                </span>
              </button>
              {u.label !== streamLabel && (
                <button
                  title="Send to Platform"
                  onClick={() => onSend(u)}
                  className={cn("rounded p-1 opacity-0 transition group-hover:opacity-100", active ? "text-neutral-300 hover:text-white" : "text-neutral-400 hover:text-neutral-700")}
                >
                  <PaperAirplaneIcon className="h-4 w-4" />
                </button>
              )}
              <a
                href={`/api/uploads/${u.id}/export.csv`}
                title="Export CSV"
                onClick={(e) => e.stopPropagation()}
                className={cn("rounded p-1 opacity-0 transition group-hover:opacity-100", active ? "text-neutral-300 hover:text-white" : "text-neutral-400 hover:text-neutral-700")}
              >
                <ArrowDownTrayIcon className="h-4 w-4" />
              </a>
              <button
                title="Delete upload"
                onClick={() => onDelete(u)}
                className={cn("rounded p-1 opacity-0 transition group-hover:opacity-100", active ? "text-neutral-300 hover:text-white" : "text-neutral-400 hover:text-red-600")}
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          );
        })}

        {uploads.length === 0 && <p className="px-3 py-2 text-sm text-neutral-400">No uploads yet.</p>}
      </nav>
    </aside>
  );
}
