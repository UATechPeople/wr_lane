import axios from "axios";
import type { CrmConfig } from "./webhook";

export type DeliveryOutcome = { ok: boolean; status: number; error?: string };

export async function sendToCrm(config: CrmConfig, body: unknown, url = config.url): Promise<DeliveryOutcome> {
  if (!url) return { ok: false, status: 0, error: "crm url is not configured" };
  try {
    const response = await axios.post(url, body, {
      headers: { "content-type": "application/json", ...config.headers },
      timeout: config.timeoutMs,
      validateStatus: () => true,
    });
    if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status };
    return { ok: false, status: response.status, error: `crm responded ${response.status}` };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, status: 0, error: err.code ?? err.message ?? "request failed" };
  }
}
