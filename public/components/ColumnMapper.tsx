import { FIELDS, type Preview } from "../lib/api";
import { Button } from "./Button";

export function ColumnMapper({
  preview,
  map,
  busy,
  onRemap,
  onImport,
  onCancel,
}: {
  preview: Preview;
  map: Record<string, string>;
  busy: boolean;
  onRemap: (field: string, header: string) => void;
  onImport: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5">
      <p className="text-sm text-neutral-500">
        <b className="text-neutral-800">{preview.rowCount}</b> rows · map columns → fields (auto-detected; adjust below)
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {f.label}
              {f.required && <span className="text-brand-600"> *</span>}
            </span>
            <select
              value={map[f.key] ?? ""}
              onChange={(e) => onRemap(f.key, e.target.value)}
              className="rounded-lg border border-neutral-300 px-3 py-2 font-mono text-sm text-neutral-700 transition focus:border-brand-500 focus:outline-none"
            >
              <option value="">(none)</option>
              {preview.headers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {preview.sample.length > 0 && (
        <p className="mt-3 font-mono text-xs text-neutral-400">sample: {preview.sample.map((s) => s.phone).join(", ")}</p>
      )}
      <div className="mt-4 flex items-center gap-2">
        <Button disabled={busy || !map.phone} onClick={onImport}>
          {busy ? "Working…" : `Import ${preview.rowCount} rows`}
        </Button>
        <Button mode="function" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
