import { Cron } from "croner";
import { outboxClaim, outboxMarkDelivered, outboxMarkFailed, setDeliveryState } from "./db";
import { sendToCrm } from "./crm";
import { getCrmConfig } from "./webhook";

const FIRST_DELAY_S = 30;
const MAX_DELAY_S = 3600;
const MAX_ATTEMPTS = 12;

export function backoffSeconds(attempts: number): number {
  return Math.min(FIRST_DELAY_S * 2 ** Math.max(0, attempts), MAX_DELAY_S);
}

export async function drainOutbox(limit = 25): Promise<{ delivered: number; failed: number; skipped: number }> {
  const config = getCrmConfig();
  if (!config.url) return { delivered: 0, failed: 0, skipped: 0 };

  const rows = outboxClaim(limit);
  let delivered = 0;
  let failed = 0;

  for (const row of rows) {
    const outcome = await sendToCrm(config, JSON.parse(row.payload));
    if (outcome.ok) {
      outboxMarkDelivered(row.id);
      setDeliveryState(row.number_id, "delivered");
      delivered += 1;
      continue;
    }
    const attempts = row.attempts + 1;
    outboxMarkFailed(row.id, outcome.error ?? "unknown error", backoffSeconds(attempts));
    if (attempts >= MAX_ATTEMPTS) {
      setDeliveryState(row.number_id, "exhausted", outcome.error ?? null);
    } else {
      setDeliveryState(row.number_id, "retrying", outcome.error ?? null);
    }
    failed += 1;
  }

  return { delivered, failed, skipped: 0 };
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
