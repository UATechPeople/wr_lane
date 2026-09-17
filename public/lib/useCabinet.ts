import { useCallback, useEffect, useState } from "react";
import { api, invertMap, type CrmConfig, type Preview, type Row, type Settings, type Transcript, type Upload, type WrConfig } from "./api";
import type { ToastData, ToastTone } from "../components/Toast";

const PAGE_SIZE = 25;

export type ConfirmState = { title: string; description: string; confirmLabel: string; run: () => Promise<void> };

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

  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
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
      else {
        const bad = (res.rows ?? []).filter((r) => !r.ok).length;
        notify(`Imported ${res.accepted} of ${res.total}` + (bad ? ` · ${bad} rejected` : ""), bad ? "info" : "success");
      }
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
      notify(`Imported ${res.accepted} of ${res.total}`);
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

  async function rotateKey(which: "inbound" | "core") {
    setBusy(true);
    await api.rotateKey(which);
    setSettings(await api.settings());
    setBusy(false);
    notify("New key generated");
  }

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
    saveCrm, saveWr, rotateKey, testCrm: api.testCrm, resend, pushAgain,
    transcriptRow, transcript, transcriptBusy, openTranscript, closeTranscript: () => setTranscriptRow(null),
  };
}
