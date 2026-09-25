import { useEffect, useState } from "react";
import { TrashIcon, PlusIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Input } from "./Input";
import { StatusBadge } from "./StatusBadge";
import { TelephonyRoutes, type RouteActions } from "./TelephonyRoutes";
import type { CrmConfig, EncryptionInput, Settings, TestResult, WrConfig } from "../lib/api";

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
  onSavePushRate,
  onRotate,
  routeActions,
  onChangeEncryption,
  onChangeLogin,
  onChangeDecryptKey,
  onTest,
}: {
  open: boolean;
  settings: Settings | null;
  busy: boolean;
  onClose: () => void;
  onSave: (crm: CrmConfig) => void;
  onSaveWr: (wr: WrConfig) => void;
  onSavePushRate: (rate: number) => void;
  onRotate: (which: "inbound" | "core") => void;
  routeActions: RouteActions;
  onChangeEncryption: (input: EncryptionInput) => void;
  onChangeLogin: (user: string, password: string) => void;
  onChangeDecryptKey: (key?: string) => void;
  onTest: () => Promise<TestResult>;
}) {
  const [draft, setDraft] = useState<CrmConfig | null>(null);
  const [wr, setWr] = useState<WrConfig | null>(null);
  const [pairs, setPairs] = useState<HeaderPair[]>([]);
  const [test, setTest] = useState<TestResult | null>(null);
  const [rate, setRate] = useState("");
  const [ff3, setFf3] = useState({ ff3Key: "", ff3Tweak: "", routeDigit: "" });
  const [login, setLogin] = useState({ user: "", password: "" });
  const [decryptDraft, setDecryptDraft] = useState("");

  useEffect(() => {
    if (!settings) return;
    setDraft(settings.crm);
    setWr(settings.wr);
    setPairs(toPairs(settings.crm.headers));
    setRate(String(settings.pushRatePerMin));
    setFf3({ ff3Key: settings.keys.ff3Key, ff3Tweak: settings.keys.ff3Tweak, routeDigit: settings.keys.routeDigit });
    setLogin({ user: settings.keys.cabinetUser, password: settings.keys.cabinetPassword });
    setDecryptDraft("");
    setTest(null);
  }, [settings, open]);

  if (!draft || !wr || !settings) return null;

  const patch = (next: Partial<CrmConfig>) => setDraft({ ...draft, ...next });

  const save = () => {
    onSaveWr(wr);
    if (rate.trim() !== String(settings.pushRatePerMin)) onSavePushRate(Number(rate.trim()));
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
      description="Where call results go and how they are authorised."
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
          <Input
            id="settings-push-rate"
            label="Send rate, calls per minute"
            type="number"
            min={1}
            value={rate}
            hint="How fast queued players leave for WinRiders. Small requests go first, big batches keep at least a fifth of the rate."
            onChange={(e) => setRate(e.target.value)}
          />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-neutral-900">What WinRiders receives</h3>
          <p className="text-xs text-neutral-500">
            Fixed shape. Only the token travels; the real number never does. <code>external_id</code> is the call_id of the request,{" "}
            <code>player_segment</code> and <code>cohort</code> come from the request and fall back to the values above.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-neutral-900 p-3 text-xs text-neutral-100">
            {JSON.stringify(
              {
                type: wr.eventType,
                event_id: "hn-5d8982cd-8220-4f97-ac7d-452dbd01f630",
                player: { external_id: "5d8982cd-8220-4f97-ac7d-452dbd01f630", phone_e164: "+913694993501880" },
                data: { player_segment: "hidden", cohort: "deau1" },
              },
              null,
              2,
            )}
          </pre>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-neutral-900">Your CRM endpoint</h3>
          <Input
            label="URL"
            value={draft.url}
            hint="Used when a request carries no webhook_url. Leave empty to stop sending — results keep queueing."
            placeholder="https://crm.example.com/hooks/call-result"
            onChange={(e) => patch({ url: e.target.value })}
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
          <h3 className="text-sm font-semibold text-neutral-900">Result body</h3>
          <p className="text-xs text-neutral-500">
            Fixed shape. <code>payload</code> is returned exactly as your CRM sent it with the player; a request that
            carried its own <code>webhook_url</code> is answered there instead of the address above.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-neutral-900 p-3 text-xs text-neutral-100">
            {JSON.stringify({ phone: "+31612345678", call_id: "uuid", result: "no_answer", payload: { a: "b", user_id: "12345" } }, null, 2)}
          </pre>
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

        <TelephonyRoutes trunks={settings.trunks} busy={busy} actions={routeActions} />

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-neutral-900">Encryption and access keys</h3>
            <a href="/api/settings/keys.env" className="text-xs font-semibold text-indigo-600 hover:text-indigo-700">
              Download all keys
            </a>
          </div>
          <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 px-3 py-2">
            <div className="text-sm font-semibold text-neutral-800">
              Token encryption (FF3){" "}
              <span className="font-mono text-xs font-normal text-neutral-500">fingerprint {settings.keys.fingerprint}</span>
            </div>
            <p className="text-xs text-neutral-500">
              {settings.keys.numbers > 0
                ? `${settings.keys.numbers} numbers are encrypted with these keys, so only the keys they were encrypted with are accepted — use this to restore the keys of a previous installation.`
                : "The cabinet holds no numbers yet: enter the keys of a previous installation, or generate new ones."}
            </p>
            <Input label="FF3 key" value={ff3.ff3Key} onChange={(e) => setFf3({ ...ff3, ff3Key: e.target.value })} />
            <div className="flex gap-2">
              <div className="flex-[3]">
                <Input label="FF3 tweak" value={ff3.ff3Tweak} onChange={(e) => setFf3({ ...ff3, ff3Tweak: e.target.value })} />
              </div>
              <div className="flex-1">
                <Input label="Route digit" value={ff3.routeDigit} onChange={(e) => setFf3({ ...ff3, routeDigit: e.target.value })} />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button mode="function" disabled={busy || settings.keys.numbers > 0} onClick={() => onChangeEncryption({ generate: true })}>
                <ArrowPathIcon className="h-4 w-4" />
                Generate new
              </Button>
              <Button mode="secondary" disabled={busy} onClick={() => onChangeEncryption(ff3)}>
                Save encryption keys
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 px-3 py-2">
            <div className="text-sm font-semibold text-neutral-800">Cabinet login</div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input label="Login" value={login.user} onChange={(e) => setLogin({ ...login, user: e.target.value })} />
              </div>
              <div className="flex-1">
                <Input label="Password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} />
              </div>
              <Button mode="secondary" disabled={busy} onClick={() => onChangeLogin(login.user, login.password)}>
                Save
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-neutral-800">SIP proxy → cabinet</div>
                <div className="truncate font-mono text-xs text-neutral-500">{settings.keys.decryptKey}</div>
              </div>
              {settings.keys.decryptKeyPending && <StatusBadge label="SIP proxy still on the previous key" tone="warning" />}
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  label="New key"
                  value={decryptDraft}
                  placeholder="empty = generate one"
                  hint="The SIP proxy takes it at its next restart (update.sh); the previous key keeps working until then."
                  onChange={(e) => setDecryptDraft(e.target.value)}
                />
              </div>
              <Button
                mode="function"
                disabled={busy}
                onClick={() => {
                  onChangeDecryptKey(decryptDraft.trim() || undefined);
                  setDecryptDraft("");
                }}
              >
                <ArrowPathIcon className="h-4 w-4" />
                Change
              </Button>
            </div>
          </div>
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
