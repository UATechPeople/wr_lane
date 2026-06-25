import { useCallback, useEffect, useState } from "react";
import { api, invertMap, type Preview, type Row } from "./api";
import type { ToastData, ToastTone } from "../components/Toast";

const PAGE_SIZE = 25;

export function useCabinet() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);

  const [adding, setAdding] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});

  const [editing, setEditing] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const notify = (text: string, tone: ToastTone = "success") => setToast({ text, tone });

  const refresh = useCallback(async () => {
    const r = await api.list(page, PAGE_SIZE, search);
    setTotal(r.total);
    setRows(r.numbers);
  }, [page, search]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function changeSearch(v: string) {
    setSearch(v);
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
      setPage(0);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function push() {
    setBusy(true);
    try {
      const res = await api.push();
      if (res.error) notify(`Push failed: ${res.error}`, "error");
      else notify(`Pushed ${res.sent} of ${res.total}` + (res.failed ? ` · ${res.failed} failed` : ""), res.failed ? "info" : "success");
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

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.remove(deleting.id);
      notify("Contact deleted");
      setDeleting(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return {
    rows, total, page, pages, pageSize: PAGE_SIZE, search, busy, toast,
    adding, file, preview, map,
    editing, deleting,
    setPage, changeSearch,
    openAdd: () => setAdding(true), closeAdd, pickFile, remap, importFile, pasteNumbers, cancelFile: resetFile,
    push,
    openEdit: setEditing, closeEdit: () => setEditing(null), saveEdit,
    openDelete: setDeleting, closeDelete: () => setDeleting(null), confirmDelete,
    dismissToast: () => setToast(null),
  };
}
