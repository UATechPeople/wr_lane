import { Fragment, useCallback, useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Pager } from "./Pager";
import { api, type Batch, type BatchError, type QueueHealth } from "../lib/api";
import { cn } from "../lib/cn";

const POLL_MS = 3000;
const PAGE_SIZE = 20;

function age(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function Progress({ batch }: { batch: Batch }) {
  const pct = (n: number) => (batch.total > 0 ? `${(n / batch.total) * 100}%` : "0%");
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-neutral-100">
      <div className="bg-emerald-500" style={{ width: pct(batch.pushed) }} />
      <div className="bg-red-400" style={{ width: pct(batch.abandoned) }} />
    </div>
  );
}

function QueueLine({ queue }: { queue: QueueHealth | null }) {
  if (!queue) return null;
  return (
    <div className="flex flex-col gap-2">
      {!queue.platform_configured && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
          Nothing is sent until the platform connection is set in Settings. Queued calls wait without losing attempts.
        </p>
      )}
      {queue.blocked && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">Sending is paused: {queue.blocked}</p>}
      {queue.worker_last_error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">Last send pass failed: {queue.worker_last_error}</p>}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-600">
        <span>
          In queue <b className="text-neutral-900">{queue.pending}</b>
        </span>
        <span>
          Gave up <b className={queue.abandoned > 0 ? "text-red-600" : "text-neutral-900"}>{queue.abandoned}</b>
        </span>
        <span>
          Oldest waiting <b className="text-neutral-900">{age(queue.oldest_pending_age_seconds)}</b>
        </span>
        <span>
          Rate <b className="text-neutral-900">{queue.rate_per_min}</b>/min, sent this minute {queue.attempts_last_minute}
        </span>
      </div>
    </div>
  );
}

export function BatchesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [queue, setQueue] = useState<QueueHealth | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [errors, setErrors] = useState<BatchError[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, h] = await Promise.all([api.batches(page * PAGE_SIZE, PAGE_SIZE), api.health()]);
      setBatches(b.batches);
      setTotal(b.total);
      setQueue(h.queue);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [page]);

  useEffect(() => {
    if (!open) setPage(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, load]);

  useEffect(() => {
    if (expanded === null) return;
    let cancelled = false;
    void api.batch(expanded).then((res) => {
      if (!cancelled) setErrors(res.errors ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, batches]);

  const retry = async (id: number) => {
    setBusy(id);
    await api.retryBatch(id);
    setBusy(null);
    await load();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Batches"
      description="Every request to /hook/players and every sent upload is a batch. Calls leave for the platform in the background."
      size="lg"
      footer={
        <Button mode="function" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <QueueLine queue={queue} />
        {loadError && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{loadError}</p>}
        <div className="-mr-2 max-h-[55vh] overflow-y-auto pr-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-neutral-500">
                <th className="py-2 pr-3">#</th>
                <th className="py-2 pr-3">Source</th>
                <th className="py-2 pr-3">Created</th>
                <th className="py-2 pr-3 text-right">Total</th>
                <th className="py-2 pr-3 text-right">Sent</th>
                <th className="py-2 pr-3 text-right">Queued</th>
                <th className="py-2 pr-3 text-right">Gave up</th>
                <th className="py-2 pr-3 text-right">Results</th>
                <th className="w-40 py-2 pr-3" />
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <Fragment key={b.id}>
                  <tr
                    onClick={() => setExpanded(expanded === b.id ? null : b.id)}
                    className={cn("cursor-pointer border-t border-neutral-100 hover:bg-neutral-50", expanded === b.id && "bg-neutral-50")}
                  >
                    <td className="py-2 pr-3 font-mono text-neutral-500">{b.id}</td>
                    <td className="py-2 pr-3">{b.source === "upload" ? b.label ?? "upload" : "CRM"}</td>
                    <td className="py-2 pr-3 text-neutral-500">{b.created_at.slice(0, 16)}</td>
                    <td className="py-2 pr-3 text-right">{b.total}</td>
                    <td className="py-2 pr-3 text-right text-emerald-700">{b.pushed}</td>
                    <td className="py-2 pr-3 text-right">{b.queued}</td>
                    <td className={cn("py-2 pr-3 text-right", b.abandoned > 0 && "font-semibold text-red-600")}>{b.abandoned}</td>
                    <td className="py-2 pr-3 text-right">{b.results}</td>
                    <td className="py-2 pr-3">
                      <Progress batch={b} />
                    </td>
                    <td className="py-2 text-right">
                      {b.abandoned > 0 && (
                        <Button
                          mode="secondary"
                          className="px-3 py-1.5"
                          disabled={busy === b.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            void retry(b.id);
                          }}
                        >
                          Retry
                        </Button>
                      )}
                    </td>
                  </tr>
                  {expanded === b.id && (
                    <tr>
                      <td colSpan={10} className="pb-3">
                        {errors.length === 0 ? (
                          <p className="px-2 text-xs text-neutral-400">No send errors in this batch.</p>
                        ) : (
                          <ul className="space-y-1 rounded-xl bg-neutral-50 p-3 font-mono text-xs text-neutral-600">
                            {errors.map((e) => (
                              <li key={e.call_id}>
                                {e.call_id} · {e.push_attempts} attempts · {e.push_error ?? "no error text"}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {batches.length === 0 && <p className="py-6 text-center text-sm text-neutral-400">No batches yet.</p>}
        </div>
        {total > PAGE_SIZE && <Pager page={page} pages={Math.ceil(total / PAGE_SIZE)} total={total} pageSize={PAGE_SIZE} onPage={setPage} />}
      </div>
    </Modal>
  );
}
