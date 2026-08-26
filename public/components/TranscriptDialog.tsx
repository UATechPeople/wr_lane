import { Modal } from "./Modal";
import { Button } from "./Button";
import { StatusBadge } from "./StatusBadge";
import type { Row, Transcript } from "../lib/api";

function duration(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function when(value: string | null): string {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

export function TranscriptDialog({
  row,
  data,
  busy,
  onClose,
}: {
  row: Row | null;
  data: Transcript | null;
  busy: boolean;
  onClose: () => void;
}) {
  if (!row) return null;

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Call transcript"
      description={`${row.real} · ${row.user_id ?? "no user id"}`}
      size="lg"
      footer={
        <Button mode="function" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="-mr-2 flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-2">
        {busy && <p className="text-sm text-neutral-500">Loading…</p>}

        {!busy && data?.error && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{data.error}</div>
        )}

        {!busy && data && !data.error && data.calls.length === 0 && (
          <p className="text-sm text-neutral-500">WinRiders has no calls recorded for this lead yet.</p>
        )}

        {!busy &&
          data?.calls.map((call) => (
            <section key={call.id} className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                {call.status && <StatusBadge label={call.status} tone={call.status === "success" ? "success" : "neutral"} />}
                {call.provider && <span className="text-xs text-neutral-500">{call.provider}</span>}
                <span className="text-xs text-neutral-500">{duration(call.durationSeconds)}</span>
                <span className="ml-auto text-xs text-neutral-400">{when(call.startedAt)}</span>
              </div>

              {call.summary && <p className="text-sm text-neutral-700">{call.summary}</p>}

              {call.transcript ? (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-3 text-xs text-neutral-800">
                  {call.transcript}
                </pre>
              ) : (
                <p className="text-xs text-neutral-400">No transcript text returned for this call.</p>
              )}

              {call.recordingUrl && (
                <a
                  href={call.recordingUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-semibold text-brand-700 hover:underline"
                >
                  Open recording
                </a>
              )}
            </section>
          ))}
      </div>
    </Modal>
  );
}
