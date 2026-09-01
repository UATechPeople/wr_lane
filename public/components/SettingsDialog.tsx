import { useEffect, useState } from "react";
import { TrashIcon, PlusIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Input } from "./Input";
import { StatusBadge } from "./StatusBadge";
import { Select } from "./Select";
import type { CrmConfig, Settings, TestResult, WrConfig } from "../lib/api";

type HeaderPair = { name: string; value: string };

function toPairs(headers: Record<string, string>): HeaderPair[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function toHeaders(pairs: HeaderPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) if (p.name.trim()) out[p.name.trim()] = p.value;
  return out;
}

export function SettingsDialog({
  open,
  settings,
  busy,
  onClose,
  onSave,
  onSaveWr,
  onRotate,
  onTest,
}: {
  open: boolean;
  settings: Settings | null;
  busy: boolean;
  onClose: () => void;
  onSave: (crm: CrmConfig) => void;
  onSaveWr: (wr: WrConfig) => void;
  onRotate: (which: "inbound" | "core") => void;
  onTest: () => Promise<TestResult>;
}) {
  const [draft, setDraft] = useState<CrmConfig | null>(null);
  const [wr, setWr] = useState<WrConfig | null>(null);
  const [pairs, setPairs] = useState<HeaderPair[]>([]);
  const [test, setTest] = useState<TestResult | null>(null);

  useEffect(() => {
    if (!settings) return;
    setDraft(settings.crm);
    setWr(settings.wr);
    setPairs(toPairs(settings.crm.headers));
    setTest(null);
  }, [settings, open]);

  if (!draft || !wr || !settings) return null;

  const patch = (next: Partial<CrmConfig>) => setDraft({ ...draft, ...next });

  const save = () => {
    onSaveWr(wr);
    onSave({ ...draft, headers: toHeaders(pairs) });
  };

  const patchWr = (next: Partial<WrConfig>) => setWr({ ...wr, ...next });

  const runTest = async () => {
    setTest(null);
    setTest(await onTest());
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Integration settings"
      description="Where call results go, how they are authorised, and what the body looks like."
      size="lg"
      footer={
        <>
          <Button mode="function" onClick={onClose}>
            Cancel
          </Button>
          <Button mode="secondary" disabled={busy || !draft.url} onClick={runTest}>
            Send test
          </Button>
          <Button disabled={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="-mr-2 flex max-h-[60vh] flex-col gap-6 overflow-y-auto pr-2">
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-neutral-900">WinRiders connection</h3>
          <Input
            label="WinRiders URL *"
            value={wr.baseUrl}
            placeholder="https://wr-core-production2.up.railway.app"
            onChange={(e) => patchWr({ baseUrl: e.target.value })}
          />
          <div className="flex gap-2">
            <div className="flex-1">
              <Input label="Client slug *" value={wr.slug} onChange={(e) => patchWr({ slug: e.target.value })} />
            </div>
            <div className="flex-1">
              <Input
                label="Segment *"
                value={wr.playerSegment}
                onChange={(e) => patchWr({ playerSegment: e.target.value })}
              />
            </div>
          </div>
          <Input
            label="API key *"
            value={wr.apiKey}
            hint="Issued by WinRiders together with the client slug"
            onChange={(e) => patchWr({ apiKey: e.target.value })}
          />
          <div className="flex gap-2">
            <div className="flex-1">
              <Input
                label="Event type *"
                value={wr.eventType}
                onChange={(e) => patchWr({ eventType: e.target.value })}
              />
            </div>
            <div className="flex-1">
              <Input
                label="Default cohort"
                value={wr.cohort ?? ""}
                hint="Optional — used only when a record has none"
                onChange={(e) => patchWr({ cohort: e.target.value || undefined })}
              />
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-neutral-900">Fields sent to WinRiders</h3>
          <p className="text-xs text-neutral-500">
            Identity fields are locked to the token — a real phone number can never be mapped into them.
          </p>
          {wr.fields.map((field, i) => {
            const locked = settings.tokenOnlyTargets.includes(field.as);
            return (
              <div key={i} className="flex items-end gap-2">
                <div className="flex-1">
                  <Select
                    label="WinRiders field"
                    value={field.as}
                    options={settings.wrTargetFields}
                    disabled={locked}
                    onChange={(v) => patchWr({ fields: wr.fields.map((f, j) => (j === i ? { ...f, as: v } : f)) })}
                  />
                </div>
                <div className="flex-1">
                  <Select
                    label="Our value"
                    value={field.from}
                    options={settings.wrSourceFields}
                    disabled={locked}
                    onChange={(v) => patchWr({ fields: wr.fields.map((f, j) => (j === i ? { ...f, from: v } : f)) })}
                  />
                </div>
                {locked ? (
                  <span className="mb-3 text-xs font-semibold text-neutral-400">locked</span>
                ) : (
                  <button
                    onClick={() => patchWr({ fields: wr.fields.filter((_, j) => j !== i) })}
                    className="mb-2 rounded-lg p-2 text-neutral-400 transition hover:bg-red-50 hover:text-red-600"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                )}
              </div>
            );
          })}
          <Button
            mode="function"
            onClick={() => patchWr({ fields: [...wr.fields, { as: "player_segment", from: "segment" }] })}
          >
            <PlusIcon className="h-4 w-4" />
            Add field
          </Button>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-neutral-900">Your CRM endpoint</h3>
          <Input
            label="URL"
            value={draft.url}
            hint="Used when a record carries no webhook id. Leave empty to stop sending — results keep queueing."
            placeholder="https://crm.example.com/hooks/call-result"
            onChange={(e) => patch({ url: e.target.value })}
          />
          <Input
            label="URL template"
            value={draft.urlTemplate}
            hint="Send players to /hook/players/<webhook id> and the result goes to this address with {id} replaced."
            placeholder="https://api-eu.customer.io/v1/webhook/{id}"
            onChange={(e) => patch({ urlTemplate: e.target.value })}
          />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-neutral-900">Authorisation headers</h3>
          {pairs.map((pair, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  label="Header"
                  value={pair.name}
                  placeholder="Authorization"
                  onChange={(e) => setPairs(pairs.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))}
                />
              </div>
              <div className="flex-[2]">
                <Input
                  label="Value"
                  value={pair.value}
                  placeholder="Bearer …"
                  onChange={(e) => setPairs(pairs.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)))}
                />
              </div>
              <button
                onClick={() => setPairs(pairs.filter((_, j) => j !== i))}
                className="mb-2 rounded-lg p-2 text-neutral-400 transition hover:bg-red-50 hover:text-red-600"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          ))}
          <Button mode="function" onClick={() => setPairs([...pairs, { name: "", value: "" }])}>
            <PlusIcon className="h-4 w-4" />
            Add header
          </Button>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-neutral-900">Body fields</h3>
          <p className="text-xs text-neutral-500">Left is the key your CRM receives, right is the value we put there.</p>
          {draft.fields.map((field, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  label="Your key"
                  value={field.as}
                  onChange={(e) =>
                    patch({ fields: draft.fields.map((f, j) => (j === i ? { ...f, as: e.target.value } : f)) })
                  }
                />
              </div>
              <div className="flex-1">
                <Select
                  label="Our value"
                  value={field.from}
                  options={settings.sourceFields}
                  onChange={(v) => patch({ fields: draft.fields.map((f, j) => (j === i ? { ...f, from: v } : f)) })}
                />
              </div>
              <button
                onClick={() => patch({ fields: draft.fields.filter((_, j) => j !== i) })}
                className="mb-2 rounded-lg p-2 text-neutral-400 transition hover:bg-red-50 hover:text-red-600"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          ))}
          <Button
            mode="function"
            onClick={() => patch({ fields: [...draft.fields, { as: "", from: settings.sourceFields[0] }] })}
          >
            <PlusIcon className="h-4 w-4" />
            Add field
          </Button>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-neutral-900">Inbound keys</h3>
          {(["inbound", "core"] as const).map((which) => (
            <div key={which} className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-neutral-800">
                  {which === "inbound" ? "For your CRM → cabinet" : "For WinRiders → cabinet"}
                </div>
                <div className="truncate font-mono text-xs text-neutral-500">
                  {(which === "inbound" ? settings.inboundKey : settings.coreKey) ?? "not generated yet"}
                </div>
              </div>
              <Button mode="function" disabled={busy} onClick={() => onRotate(which)}>
                <ArrowPathIcon className="h-4 w-4" />
                Generate
              </Button>
            </div>
          ))}
        </section>

        {test && (
          <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-neutral-900">Test delivery</span>
              {test.response?.ok ? (
                <StatusBadge label={`${test.response.status} ok`} tone="success" />
              ) : (
                <StatusBadge label={test.error ?? test.response?.error ?? "failed"} tone="danger" />
              )}
            </div>
            {test.sent && (
              <pre className="overflow-x-auto rounded-lg bg-neutral-900 p-3 text-xs text-neutral-100">
                {JSON.stringify(test.sent, null, 2)}
              </pre>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
