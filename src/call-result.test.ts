import { describe, expect, test } from "bun:test";

const { hooks } = await import("./hooks");
const { setCoreKey, setInboundKey } = await import("./webhook");

const CORE = "call-result-core-key-0123456789";
const INBOUND = "call-result-inbound-key-0123456789";
setCoreKey(CORE);
setInboundKey(INBOUND);

const send = (path: string, key: string, body: unknown) =>
  hooks.handle(
    new Request(`http://cabinet${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify(body),
    }),
  );

const answer = async (phone: string) => {
  const res = await send("/hook/call-result", CORE, { phone, outcome: "no_answer" });
  return { status: res.status, body: await res.json() };
};

describe("call result does not reveal which real numbers the cabinet holds", () => {
  test("a stored real number gets exactly the answer of a number the cabinet never saw", async () => {
    const stored = "+31612340001";
    const accepted = await send("/hook/players", INBOUND, [{ phone: stored, segment: "s", cohort: "c" }]);
    expect(accepted.status).toBe(202);

    const forStored = await answer(stored);
    const forUnknown = await answer("+31612349999");

    expect(forStored).toEqual(forUnknown);
  });
});
