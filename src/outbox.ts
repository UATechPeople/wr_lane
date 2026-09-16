import { Cron } from "croner";
import { outboxClaim, outboxMarkDelivered, outboxMarkFailed, setDeliveryState, setRequestDeliveryState, type OutboxRow } from "./db";
import { sendToCrm } from "./crm";
import { getCrmConfig } from "./webhook";

const FIRST_DELAY_S = 30;
const MAX_DELAY_S = 3600;
const MAX_ATTEMPTS = 12;

export function backoffSeconds(attempts: number): number {
  return Math.min(FIRST_DELAY_S * 2 ** Math.max(0, attempts), MAX_DELAY_S);
}

function setState(row: OutboxRow, status: string, error?: string | null): void {
  setDeliveryState(row.number_id, status, error);
  if (row.call_id) setRequestDeliveryState(row.call_id, status, error);
}

export async function drainOutbox(limit = 25): Promise<{ delivered: number; failed: number; skipped: number }> {
  const config = getCrmConfig();
  const rows = outboxClaim(limit);
  let delivered = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    const url = row.url ?? config.url;
    if (!url) {
      skipped += 1;
      continue;
    }
    const outcome = await sendToCrm(config, JSON.parse(row.payload), url);
    if (outcome.ok) {
      outboxMarkDelivered(row.id);
      setState(row, "delivered");
      delivered += 1;
      continue;
    }
    const attempts = row.attempts + 1;
    outboxMarkFailed(row.id, outcome.error ?? "unknown error", backoffSeconds(attempts));
    if (attempts >= MAX_ATTEMPTS) {
      setState(row, "exhausted", outcome.error ?? null);
    } else {
      setState(row, "retrying", outcome.error ?? null);
    }
    failed += 1;
  }

  return { delivered, failed, skipped };
}

export function startOutboxCron(pattern = "*/30 * * * * *"): Cron {
  return new Cron(pattern, { protect: true, name: "outbox-drain" }, async () => {
    try {
      await drainOutbox();
    } catch (e) {
      console.error("[hidden-numbers] outbox drain failed", e);
    }
  });
}
