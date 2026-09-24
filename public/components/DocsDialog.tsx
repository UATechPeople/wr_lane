import { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import type { Settings } from "../lib/api";

type Field = { name: string; type: string; required?: boolean; note: string };

const INBOUND_FIELDS: Field[] = [
  { name: "phone", type: "string", required: true, note: "The real number in E.164, e.g. +31612345678. Never send a token here." },
  { name: "segment", type: "string", note: "Together with cohort selects the Platform campaign." },
  { name: "cohort", type: "string", note: "Together with segment selects the Platform campaign, e.g. deau1." },
  { name: "webhook_url", type: "string", note: "Where the result of this call must be posted." },
  { name: "payload", type: "object", note: "Anything you want back with the result — returned untouched. Put user_id here." },
];

const RESULTS: { result: string; meaning: string }[] = [
  { result: "send_sms", meaning: "Agreed or showed interest — the person is worth an SMS." },
  { result: "no_answer", meaning: "Nobody picked up." },
  { result: "voicemail", meaning: "Answering machine." },
  { result: "busy", meaning: "Busy or the call was declined." },
  { result: "hang_up", meaning: "Picked up and hung up almost immediately." },
  { result: "not_interested", meaning: "Spoke to the agent and refused." },
  { result: "failed_call", meaning: "Telephony failure — never reached the person." },
  { result: "blacklist", meaning: "Asked not to be called again." },
];

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(children).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  };
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-neutral-900 p-3 pr-16 text-xs leading-relaxed text-neutral-100">{children}</pre>
      <button
        onClick={copy}
        className="absolute right-2 top-2 rounded-md bg-neutral-700/70 px-2 py-1 text-[11px] font-semibold text-neutral-100 transition hover:bg-neutral-600"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

function FieldTable({ fields }: { fields: Field[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <table className="w-full text-left text-xs">
        <thead className="bg-neutral-50 text-neutral-500">
          <tr>
            <th className="px-3 py-2 font-semibold">Field</th>
            <th className="px-3 py-2 font-semibold">Type</th>
            <th className="px-3 py-2 font-semibold">Notes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {fields.map((f, i) => (
            <tr key={`${f.name}-${i}`}>
              <td className="whitespace-nowrap px-3 py-2 font-mono text-neutral-800">
                {f.name}
                {f.required && <span className="ml-1 text-red-500">*</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-neutral-500">{f.type}</td>
              <td className="px-3 py-2 text-neutral-600">{f.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-bold text-neutral-900">{title}</h3>
      {children}
    </section>
  );
}

export function DocsDialog({ open, settings, onClose }: { open: boolean; settings: Settings | null; onClose: () => void }) {
  const origin = typeof window === "undefined" ? "https://your-cabinet" : window.location.origin;
  const inbound = settings?.inboundKey ?? "<generate the key in Settings>";
  const core = settings?.coreKey ?? "<generate the key in Settings>";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Integration guide"
      description="How numbers get in, how call results come back, and what your CRM receives."
      size="lg"
      footer={
        <Button mode="function" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="-mr-2 flex max-h-[62vh] flex-col gap-6 overflow-y-auto pr-2">
        <Section title="1. How it fits together">
          <p className="text-sm text-neutral-600">
            Your CRM sends a real phone number to this cabinet. The cabinet encrypts it into a 15-digit token and forwards only the
            token to Platform. Platform dials the token; the real number is restored inside your own SIP proxy at the moment of the
            call. When the call is over Platform posts the outcome back here, the cabinet decrypts the token, attaches the{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono text-xs">payload</code> you sent and posts the result to the{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono text-xs">webhook_url</code> of that request.
          </p>
          <p className="text-sm text-neutral-600">The real number never leaves your infrastructure.</p>
          <p className="text-sm text-neutral-600">
            Machine-readable OpenAPI spec with a try-it console:{" "}
            <a href={`${origin}/docs`} target="_blank" rel="noreferrer" className="font-mono text-xs text-indigo-600 underline">
              {origin}/docs
            </a>{" "}
            (JSON at <code className="rounded bg-neutral-100 px-1 font-mono text-xs">/docs/json</code>).
          </p>
        </Section>

        <Section title="2. Send us a player">
          <p className="text-sm text-neutral-600">
            One object or an array of them. Every request is a separate call with its own{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono text-xs">call_id</code> — send the same person twice and you get two
            calls and two results, nothing is merged. The number itself always encrypts to the same token.
          </p>
          <FieldTable fields={INBOUND_FIELDS} />
          <Code>{`curl -X POST ${origin}/hook/players \\
  -H "Authorization: Bearer ${inbound}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "phone": "+447700900123",
    "segment": "hidden",
    "cohort": "deau1",
    "webhook_url": "https://crm.example.com/hooks/call-results",
    "payload": { "a": "b", "user_id": "12345" }
  }'`}</Code>
          <p className="text-sm text-neutral-600">Or a batch:</p>
          <Code>{`curl -X POST ${origin}/hook/players \\
  -H "Authorization: Bearer ${inbound}" \\
  -H "Content-Type: application/json" \\
  -d '[
    { "phone": "+447700900123", "segment": "hidden", "cohort": "deau1", "payload": { "a": "b", "user_id": "12345" } },
    { "phone": "+447700900456", "segment": "hidden", "cohort": "nl1", "payload": { "a": "b", "user_id": "12346" } }
  ]'`}</Code>
          <p className="text-sm text-neutral-600">Answer — 202, with one row per record:</p>
          <Code>{`{
  "received": 2,
  "accepted": 2,
  "pushed": { "sent": 2, "failed": 0 },
  "rows": [
    { "phone": "+447700900123", "token": "+900979118411365", "call_id": "7c1e2f40-9a3b-4d6e-8f21-0b5c4d3e2a19", "ok": true },
    { "phone": "+447700900456", "token": "+934219595183482", "call_id": "2b6d4f81-3c5e-4a7b-9d0e-6f1a2b3c4d5e", "ok": true }
  ]
}`}</Code>

          <p className="text-sm text-neutral-600">
            A bad record fails on its own without spoiling the batch — you get{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono text-xs">ok: false</code> and a reason for that row only. A record
            without <code className="rounded bg-neutral-100 px-1 font-mono text-xs">webhook_url</code> is answered to the address from
            Settings.
          </p>
        </Section>

        <Section title="3. What your CRM receives">
          <p className="text-sm text-neutral-600">
            One POST per call, to the request's <code className="rounded bg-neutral-100 px-1 font-mono text-xs">webhook_url</code>, with
            the headers from Settings:
          </p>
          <Code>{`POST https://crm.example.com/hooks/call-results
Authorization: Bearer <your key>
Content-Type: application/json

{
  "phone": "+31612345678",
  "call_id": "7c1e2f40-9a3b-4d6e-8f21-0b5c4d3e2a19",
  "result": "no_answer",
  "payload": { "a": "b", "user_id": "12345" }
}`}</Code>
          <p className="text-sm text-neutral-600">
            <code className="rounded bg-neutral-100 px-1 font-mono text-xs">phone</code> is the decrypted real number,{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono text-xs">call_id</code> is the one you got when you sent the player,{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono text-xs">payload</code> is yours, returned as it came.
          </p>
        </Section>

        <Section title="4. Call results">
          <div className="overflow-hidden rounded-lg border border-neutral-200">
            <table className="w-full text-left text-xs">
              <thead className="bg-neutral-50 text-neutral-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">result</th>
                  <th className="px-3 py-2 font-semibold">Meaning</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {RESULTS.map((r) => (
                  <tr key={r.result}>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-neutral-800">{r.result}</td>
                    <td className="px-3 py-2 text-neutral-600">{r.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="5. Delivery guarantees">
          <p className="text-sm text-neutral-600">
            Answer with any 2xx and we consider it delivered. Anything else is retried automatically: after 30 seconds, then one
            minute, doubling up to an hour, twelve attempts in total. A result is never sent twice for the same call, and every row in
            the table shows its delivery state with a manual resend button.
          </p>
          <p className="text-sm text-neutral-600">If your CRM is down, nothing is lost — results queue up and go out when it returns.</p>
        </Section>

        <Section title="6. Importing and exporting by file">
          <p className="text-sm text-neutral-600">
            CSV or Excel through “Add numbers”, for a one-off base outside the CRM flow. A{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono text-xs">phone</code> column is required; optional columns are{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono text-xs">user_id</code>,{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono text-xs">segment</code>,{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono text-xs">cohort</code>,{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono text-xs">webhook_url</code>, first_name, last_name, country, language. If
            your headers differ you map them by hand during the upload. Each row keeps its own segment, cohort and result webhook; an empty
            cell falls back to Settings. A number the cabinet already holds joins the new file too, and the import says so.
          </p>
          <p className="text-sm text-neutral-600">
            The export contains tokens instead of phone numbers, so it is safe to hand to anyone — including us.
          </p>
        </Section>

        <Section title="7. Errors">
          <FieldTable
            fields={[
              { name: "401", type: "unauthorized", note: "Wrong key. Check the Authorization header against Settings." },
              { name: "503", type: "key not configured", note: "The cabinet has no key yet — generate one in Settings." },
              { name: "202 ok: false", type: "on send", note: "That row was refused — the reason is next to it: a token instead of a phone number, a bad webhook_url, an unencryptable number. Other rows are unaffected." },
              { name: "422 real_number_received", type: "on result", note: "Platform sent a real number instead of a token — tokenisation is bypassed upstream and results are refused until it is fixed." },
            ]}
          />
        </Section>

        <Section title="8. For the Platform side">
          <p className="text-sm text-neutral-600">Point the campaign webhook at this cabinet with the second key:</p>
          <Code>{`url:  ${origin}/hook/call-result
auth: Bearer ${core}`}</Code>
        </Section>
      </div>
    </Modal>
  );
}
