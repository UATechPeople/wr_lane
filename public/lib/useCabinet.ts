import { useCallback, useEffect, useState } from "react";
import { api, invertMap, type Batch, type CrmConfig, type Preview, type RequestRow, type Row, type EncryptionInput, type Settings, type TrunkChange, type UploadResult, type Transcript, type Upload, type WrConfig } from "./api";
import type { ToastData, ToastTone } from "../components/Toast";

const PAGE_SIZE = 25;

export type ConfirmState = { title: string; description: string; confirmLabel: string; run: () => Promise<void> };

function importMessage(res: UploadResult): string {
  const { total, added, known, changed, rejected } = res.summary;
  const parts = [`${added} new`];
  if (known > 0) parts.push(`${known} already in the cabinet`);
  if (changed > 0) {
    const details = res.rows
      .flatMap((r) => (r.changed ?? []).map((c) => `${r.real} ${c.field} ${c.from ?? "—"} → ${c.to}`))
      .slice(0, 3)
      .join("; ");
    parts.push(`${changed} changed (${details}${changed > 3 ? "; …" : ""})`);
  }
  if (rejected > 0) {
    const reasons = res.rows
      .filter((r) => r.status === "rejected")
      .slice(0, 3)
      .map((r) => `${r.real}: ${r.error}`)
      .join("; ");
    parts.push(`${rejected} rejected (${reasons}${rejected > 3 ? "; …" : ""})`);
  }
  return `Imported ${added + known} of ${total}: ${parts.join(" · ")}`;
}

export function useCabinet() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [selectedUpload, setSelectedUpload] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);

  const [adding, setAdding] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});

  const [editing, setEditing] = useState<Row | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [sendingUpload, setSendingUpload] = useState<Upload | null>(null);
  const [batchesOpen, setBatchesOpen] = useState(false);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [requestsRow, setRequestsRow] = useState<Row | null>(null);
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [transcriptRow, setTranscriptRow] = useState<Row | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [transcriptBusy, setTranscriptBusy] = useState(false);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const grandTotal = uploads.reduce((a, u) => a + u.count, 0);
  const notify = (text: string, tone: ToastTone = "success") => setToast({ text, tone });

  const refresh = useCallback(async () => {
    const [n, u] = await Promise.all([api.list(page, PAGE_SIZE, search, selectedUpload), api.uploads()]);
    setTotal(n.total);
    setRows(n.numbers);
    setUploads(u.uploads);
  }, [page, search, selectedUpload]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function changeSearch(v: string) {
    setSearch(v);
    setPage(0);
  }
  function selectUpload(id: number | null) {
    setSelectedUpload(id);
    setPage(0);
  }

  function resetFile() {
    setFile(null);
    setPreview(null);
    setMap({});
  }
  function closeAdd() {
    setAdding(false);
    resetFile();
  }

  async function pickFile(f: File) {
    setFile(f);
    setBusy(true);
    try {
      const p = await api.preview(f);
      setPreview(p);
      setMap({ ...p.mapping });
    } finally {
      setBusy(false);
    }
  }

  async function remap(field: string, header: string) {
    const next = { ...map, [field]: header };
    setMap(next);
    if (file) setPreview(await api.preview(file, invertMap(next)));
  }

  async function importFile() {
    if (!file) return;
    setBusy(true);
    try {
      const res = await api.upload(file, invertMap(map));
      if (res.error) notify(`Upload failed: ${res.error}`, "error");
      else notify(importMessage(res), res.summary.rejected > 0 ? "info" : "success");
      closeAdd();
      setSelectedUpload(null);
      setPage(0);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function pasteNumbers(text: string) {
    const numbers = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!numbers.length) return;
    setBusy(true);
    try {
      const res = await api.paste(numbers);
      notify(importMessage(res), res.summary.rejected > 0 ? "info" : "success");
      closeAdd();
      setSelectedUpload(null);
      setPage(0);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: number, patch: Record<string, string>) {
    if (Object.keys(patch).length === 0) {
      setEditing(null);
      return;
    }
    setBusy(true);
    try {
      const res = await api.patch(id, patch);
      if (res.error) {
        notify(`Update failed: ${res.error}`, "error");
        return;
      }
      notify("Contact updated");
      setEditing(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function runConfirm() {
    if (!confirm) return;
    setBusy(true);
    try {
      await confirm.run();
      setConfirm(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function askDeleteContact(row: Row) {
    setConfirm({
      title: "Delete contact",
      description: `${row.real} and its token are removed from this cabinet. Tokens already pushed stay in Platform.`,
      confirmLabel: "Delete",
      run: async () => {
        await api.remove(row.id);
        notify("Contact deleted");
      },
    });
  }

  function askDeleteUpload(u: Upload) {
    setConfirm({
      title: "Delete upload",
      description: `“${u.label}” and its ${u.count} number(s) are removed from this cabinet.`,
      confirmLabel: "Delete upload",
      run: async () => {
        await api.deleteUpload(u.id);
        if (selectedUpload === u.id) setSelectedUpload(null);
        notify("Upload deleted");
      },
    });
  }

  async function openRequests(row: Row) {
    setRequestsRow(row);
    setRequests(null);
    const res = await api.requests(row.id);
    setRequests(res.requests ?? []);
  }

  async function resendRequest(callId: string) {
    setBusy(true);
    const res = await api.resendRequest(callId);
    setBusy(false);
    if (res.error) {
      notify(res.error, "error");
      return;
    }
    notify("Queued for delivery");
    if (requestsRow) {
      const fresh = await api.requests(requestsRow.id);
      setRequests(fresh.requests ?? []);
    }
    await refresh();
  }

  async function openTranscript(row: Row) {
    setTranscriptRow(row);
    setTranscript(null);
    setTranscriptBusy(true);
    setTranscript(await api.transcript(row.id));
    setTranscriptBusy(false);
  }

  async function openSettings() {
    setSettingsOpen(true);
    setSettings(await api.settings());
  }

  async function openDocs() {
    if (!settings) setSettings(await api.settings());
    setDocsOpen(true);
  }

  async function saveCrm(crm: CrmConfig) {
    setBusy(true);
    const res = await api.saveCrm(crm);
    setBusy(false);
    if (res.error) {
      notify(res.error, "error");
      return;
    }
    setSettings(await api.settings());
    notify("Settings saved");
    setSettingsOpen(false);
  }

  async function saveWr(wr: WrConfig) {
    setBusy(true);
    const res = await api.saveWr(wr);
    setBusy(false);
    if (res.error) {
      notify(res.error, "error");
      return;
    }
    setSettings(await api.settings());
    notify("Platform connection saved");
  }

  async function savePushRate(rate: number) {
    const res = await api.savePushRate(rate);
    if (res.error) {
      notify(res.error, "error");
      return;
    }
    setSettings(await api.settings());
  }

  function uploadSent(batch: Batch) {
    setSendingUpload(null);
    notify(`${batch.total} calls queued for Platform`);
    setBatchesOpen(true);
  }

  async function rotateKey(which: "inbound" | "core") {
    setBusy(true);
    await api.rotateKey(which);
    setSettings(await api.settings());
    setBusy(false);
    notify("New key generated");
  }

  async function changeEncryption(input: EncryptionInput) {
    setBusy(true);
    const res = await api.changeEncryption(input);
    setSettings(await api.settings());
    setBusy(false);
    if (res.error && res.reregistered === undefined) notify(res.error, "error");
    else if (res.error) notify(`Encryption keys saved; Platform refused the new ones: ${res.error}`, "error");
    else notify("Encryption keys saved");
  }

  async function changeLogin(user: string, password: string) {
    setBusy(true);
    const res = await api.changeLogin(user, password);
    setSettings(await api.settings());
    setBusy(false);
    if (res.error) notify(res.error, "error");
    else notify("Login saved");
  }

  async function changeDecryptKey(key?: string) {
    setBusy(true);
    const res = await api.changeDecryptKey(key);
    setSettings(await api.settings());
    setBusy(false);
    if (res.error) notify(res.error, "error");
    else notify("SIP proxy key saved; the SIP proxy takes it at its next restart, the previous key works until then");
  }

  async function trunkAction(run: () => Promise<TrunkChange>, done: string, pending: string) {
    setBusy(true);
    const res = await run();
    setSettings(await api.settings());
    setBusy(false);
    if (res.error && res.synced === undefined) notify(res.error, "error");
    else if (res.synced === false) notify(`${pending}: ${res.error}`, "error");
    else notify(done);
  }

  const trunkName = (mode: string, route: string) => (route === "default" ? mode : `${mode}.${route}`);

  const routeActions = {
    onChangeKey: (mode: string, route: string, key?: string) =>
      trunkAction(
        () => api.changeTrunkKey(mode, route, key),
        `${trunkName(mode, route)} key changed; Platform uses it now`,
        `${trunkName(mode, route)} key changed here, Platform not updated yet; both keys work until it is, press Change key again to retry`,
      ),
    onAddRoute: (mode: string, route: string, prefix: string) =>
      trunkAction(
        () => api.addRoute(mode, route, prefix),
        `route ${trunkName(mode, route.toLowerCase())} added; Platform created its number and voice service`,
        `route added here, Platform has not created its number yet; run update.sh --trunks or add the route again later`,
      ),
    onSetPrefix: (mode: string, route: string, prefix: string) =>
      trunkAction(() => api.setRoutePrefix(mode, route, prefix), `${trunkName(mode, route)} now dials ${prefix || "without a prefix"}`, "prefix not saved"),
    onRemoveRoute: (mode: string, route: string) =>
      trunkAction(() => api.removeRoute(mode, route), `route ${trunkName(mode, route)} removed`, "route removed here, Platform has not dropped its number yet"),
  };

  async function pushAgain(row: Row) {
    setBusy(true);
    const res = await api.pushAgain(row.id);
    setBusy(false);
    if (res.error && !res.sent) {
      notify(res.error, "error");
      return;
    }
    await refresh();
    notify(res.failed ? `Sent ${res.sent}, failed ${res.failed}: ${res.error}` : `Sent to Platform`, res.failed ? "info" : "success");
  }

  async function resend(row: Row) {
    setBusy(true);
    const res = await api.resend(row.id);
    setBusy(false);
    if (res.error) {
      notify(res.error, "error");
      return;
    }
    await refresh();
    notify("Queued for delivery");
  }

  return {
    rows, total, grandTotal, pages, pageSize: PAGE_SIZE, page, search, busy, toast,
    uploads, selectedUpload,
    adding, file, preview, map, editing, confirm,
    setPage, changeSearch, selectUpload,
    openAdd: () => setAdding(true), closeAdd, pickFile, remap, importFile, pasteNumbers, cancelFile: resetFile,
    openEdit: setEditing, closeEdit: () => setEditing(null), saveEdit,
    askDeleteContact, askDeleteUpload, closeConfirm: () => setConfirm(null), runConfirm,
    dismissToast: () => setToast(null),
    settings, settingsOpen, openSettings, docsOpen, openDocs, closeDocs: () => setDocsOpen(false), closeSettings: () => setSettingsOpen(false),
    saveCrm, saveWr, savePushRate, rotateKey, routeActions, changeEncryption, changeLogin, changeDecryptKey,
    sendingUpload, openSendUpload: setSendingUpload, closeSendUpload: () => setSendingUpload(null), uploadSent,
    batchesOpen, openBatches: () => setBatchesOpen(true), closeBatches: () => setBatchesOpen(false), testCrm: api.testCrm, resend, pushAgain,
    transcriptRow, transcript, transcriptBusy, openTranscript, closeTranscript: () => setTranscriptRow(null),
    requestsRow, requests, openRequests, closeRequests: () => setRequestsRow(null), resendRequest,
  };
}
