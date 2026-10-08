import { describe, expect, test } from "bun:test";
import { countNumbers, deleteUpload, getByToken, getRequest, getUpload, listBatches, listNumbers, requestsForNumber, rowsForUpload } from "./db";
import { pushRequest, PUSH_MAX_ATTEMPTS } from "./platform";
import { savePlatformConfig, DEFAULT_PLATFORM_FIELDS } from "./webhook";
import { encryptPhone } from "./fpe";
import { ingestRecords, sendUpload } from "./uploads";

describe("uploads", () => {
  test("a file owns every number in it, including numbers the cabinet already knew", () => {
    const first = ingestRecords([{ phone: "+31600007001", user_id: "u-1", segment: "old" }], "first.csv");
    expect(first.summary).toEqual({ total: 1, added: 1, known: 0, changed: 0, rejected: 0 });

    const second = ingestRecords(
      [
        { phone: "+31600007002", user_id: "u-2", segment: "s2", cohort: "c2", webhook_url: "https://crm.example.com/a" },
        { phone: "+31600007001", user_id: "u-1b", segment: "new", cohort: "c1" },
        { phone: "123" },
        { phone: "+31600007003", webhook_url: "ftp://nope" },
      ],
      "second.csv",
    );
    expect(second.summary).toEqual({ total: 4, added: 1, known: 1, changed: 1, rejected: 2 });
    expect(second.rows.map((r) => r.status)).toEqual(["new", "known", "rejected", "rejected"]);
    expect(second.rows[1].changed).toEqual([{ field: "user_id", from: "u-1", to: "u-1b" }]);
    expect(second.rows[3].error).toMatch(/webhook/);

    expect(getUpload(second.uploadId)?.count).toBe(2);
    expect(getUpload(first.uploadId)?.count).toBe(1);
    expect(rowsForUpload(second.uploadId).map((r) => r.real).sort()).toEqual(["+31600007001", "+31600007002"]);
    expect(countNumbers(undefined, second.uploadId)).toBe(2);
    expect(listNumbers(50, 0, undefined, second.uploadId)).toHaveLength(2);
  });

  test("sending a file creates one call per row with the row's own segment, cohort and result webhook", () => {
    const file = ingestRecords(
      [
        { phone: "+31600007101", segment: "seg-a", cohort: "coh-a", webhook_url: "https://crm.example.com/hook-a" },
        { phone: "+31600007102" },
      ],
      "send.csv",
    );
    const sent = sendUpload(file.uploadId);
    if (!("batchId" in sent)) throw new Error(JSON.stringify(sent));
    const a = requestsForNumber(getByToken(encryptPhone("+31600007101"))!.id)[0];
    const b = requestsForNumber(getByToken(encryptPhone("+31600007102"))!.id)[0];
    expect(a).toMatchObject({ batch_id: sent.batchId, segment: "seg-a", cohort: "coh-a", webhook_url: "https://crm.example.com/hook-a" });
    expect(b).toMatchObject({ batch_id: sent.batchId, segment: null, cohort: null, webhook_url: null });

    expect(sendUpload(file.uploadId)).toEqual({ conflict: [sent.batchId] });
    const again = sendUpload(file.uploadId, true);
    expect("batchId" in again && again.batchId).not.toBe(sent.batchId);
  });

  test("a file made only of numbers the cabinet already knew can still be sent", () => {
    ingestRecords([{ phone: "+31600007201" }], "earlier.csv");
    const repeat = ingestRecords([{ phone: "+31600007201", segment: "again" }], "repeat.csv");
    expect(repeat.summary).toMatchObject({ added: 0, known: 1 });
    const sent = sendUpload(repeat.uploadId);
    expect("batchId" in sent).toBe(true);
    expect(requestsForNumber(getByToken(encryptPhone("+31600007201"))!.id)[0].segment).toBe("again");
  });

  test("deleting a file keeps the numbers other files still hold", () => {
    const keep = ingestRecords([{ phone: "+31600007301" }], "keep.csv");
    const drop = ingestRecords([{ phone: "+31600007301" }, { phone: "+31600007302" }], "drop.csv");
    expect(deleteUpload(drop.uploadId)).toBe(true);
    expect(getByToken(encryptPhone("+31600007301"))).not.toBeNull();
    expect(getByToken(encryptPhone("+31600007302"))).toBeNull();
    expect(getUpload(keep.uploadId)?.count).toBe(1);
  });

  test("the batch list pages from the newest batch", () => {
    for (const phone of ["+31600007401", "+31600007402", "+31600007403"]) {
      const f = ingestRecords([{ phone }], `page-${phone}.csv`);
      sendUpload(f.uploadId);
    }
    const firstPage = listBatches(12, 2, 0);
    const secondPage = listBatches(12, 2, 2);
    expect(firstPage.batches).toHaveLength(2);
    expect(firstPage.batches[0].id).toBeGreaterThan(firstPage.batches[1].id);
    expect(secondPage.batches[0].id).toBeLessThan(firstPage.batches[1].id);
    expect(firstPage.total).toBe(secondPage.total);
    expect(firstPage.batches[0]).toMatchObject({ total: 1, queued: 1, pushed: 0 });
  });

  test("a queued call whose number was deleted gives up at once instead of blocking the queue", async () => {
    savePlatformConfig({ baseUrl: "http://127.0.0.1:9", slug: "acme", apiKey: "k", playerSegment: "seg", fields: DEFAULT_PLATFORM_FIELDS });
    const file = ingestRecords([{ phone: "+31600007501" }], "gone.csv");
    const sent = sendUpload(file.uploadId);
    if (!("batchId" in sent)) throw new Error("not sent");
    const numberId = getByToken(encryptPhone("+31600007501"))!.id;
    const callId = requestsForNumber(numberId)[0].call_id;
    deleteUpload(file.uploadId);
    const result = await pushRequest(getRequest(callId)!);
    expect(result.ok).toBe(false);
    expect(getRequest(callId)).toMatchObject({ push_attempts: PUSH_MAX_ATTEMPTS, push_error: `number ${numberId} is gone` });
  });
});
