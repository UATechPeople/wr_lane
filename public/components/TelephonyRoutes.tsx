import { useState } from "react";
import { ArrowPathIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { Button } from "./Button";
import { Input } from "./Input";
import { StatusBadge } from "./StatusBadge";
import type { TrunkMode } from "../lib/api";

export type RouteActions = {
  onChangeKey: (mode: string, route: string, key?: string) => void;
  onAddRoute: (mode: string, route: string, prefix: string) => void;
  onSetPrefix: (mode: string, route: string, prefix: string) => void;
  onRemoveRoute: (mode: string, route: string) => void;
};

export function TelephonyRoutes({ trunks, busy, actions }: { trunks: TrunkMode[]; busy: boolean; actions: RouteActions }) {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [prefixes, setPrefixes] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, { route: string; prefix: string }>>({});

  if (trunks.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-neutral-900">Telephony routes</h3>
      <p className="text-xs text-neutral-500">
        Every route to a carrier gets its own number in Platform; a campaign picks the route by the voice service it calls
        through. The prefix is dialled in front of the number and takes effect on the next call. The key is what the calling
        platform sends in <code>X-API-Key</code>; a new key reaches Platform at once and the previous one keeps working until it
        does.
      </p>
      {trunks.map((trunk) => {
        const draft = drafts[trunk.mode] ?? { route: "", prefix: "" };
        return (
          <div key={trunk.mode} className="flex flex-col gap-3 rounded-xl border border-neutral-200 px-3 py-3">
            <div className="text-sm font-semibold text-neutral-800">
              {trunk.mode} <span className="font-normal text-neutral-500">→ {trunk.host}:{trunk.port}</span>
            </div>
            {trunk.routes.map((route) => {
              const id = route.name;
              const prefix = prefixes[id] ?? route.prefix;
              return (
                <div key={id} className="flex flex-col gap-2 rounded-lg bg-neutral-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-neutral-800">
                        {route.id === "default" ? "main route" : route.id}{" "}
                        <span className="font-mono text-xs font-normal text-neutral-500">{route.name}</span>
                      </div>
                      <div className="truncate font-mono text-xs text-neutral-500">{route.key}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {route.previousKeyAccepted && <StatusBadge label="previous key still accepted" tone="warning" />}
                      {route.id !== "default" && (
                        <button
                          type="button"
                          disabled={busy}
                          title="Remove this route"
                          onClick={() => actions.onRemoveRoute(trunk.mode, route.id)}
                          className="rounded-lg p-2 text-neutral-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="w-40">
                      <Input label="Prefix" value={prefix} placeholder="none" onChange={(e) => setPrefixes({ ...prefixes, [id]: e.target.value })} />
                    </div>
                    <Button
                      mode="function"
                      disabled={busy || prefix.trim() === route.prefix}
                      onClick={() => {
                        actions.onSetPrefix(trunk.mode, route.id, prefix.trim());
                        const next = { ...prefixes };
                        delete next[id];
                        setPrefixes(next);
                      }}
                    >
                      Save prefix
                    </Button>
                    <div className="flex-1">
                      <Input label="New key" value={keys[id] ?? ""} placeholder="empty = generate one" onChange={(e) => setKeys({ ...keys, [id]: e.target.value })} />
                    </div>
                    <Button
                      mode="function"
                      disabled={busy}
                      onClick={() => {
                        actions.onChangeKey(trunk.mode, route.id, keys[id]?.trim() || undefined);
                        setKeys({ ...keys, [id]: "" });
                      }}
                    >
                      <ArrowPathIcon className="h-4 w-4" />
                      Change key
                    </Button>
                  </div>
                </div>
              );
            })}
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  label="New route"
                  value={draft.route}
                  placeholder="e.g. tdm"
                  onChange={(e) => setDrafts({ ...drafts, [trunk.mode]: { ...draft, route: e.target.value } })}
                />
              </div>
              <div className="w-40">
                <Input
                  label="Prefix"
                  value={draft.prefix}
                  placeholder="none"
                  onChange={(e) => setDrafts({ ...drafts, [trunk.mode]: { ...draft, prefix: e.target.value } })}
                />
              </div>
              <Button
                mode="secondary"
                disabled={busy || !draft.route.trim()}
                onClick={() => {
                  actions.onAddRoute(trunk.mode, draft.route.trim(), draft.prefix.trim());
                  setDrafts({ ...drafts, [trunk.mode]: { route: "", prefix: "" } });
                }}
              >
                <PlusIcon className="h-4 w-4" />
                Add route
              </Button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
