import { useState } from "react";
import type { Preview } from "../lib/api";
import { Modal } from "./Modal";
import { UploadZone } from "./UploadZone";
import { ColumnMapper } from "./ColumnMapper";
import { PasteBox } from "./PasteBox";
import { cn } from "../lib/cn";

export function AddDialog({
  open,
  onClose,
  file,
  preview,
  map,
  busy,
  onFile,
  onRemap,
  onImport,
  onCancelFile,
  onPaste,
}: {
  open: boolean;
  onClose: () => void;
  file: File | null;
  preview: Preview | null;
  map: Record<string, string>;
  busy: boolean;
  onFile: (f: File) => void;
  onRemap: (field: string, header: string) => void;
  onImport: () => void;
  onCancelFile: () => void;
  onPaste: (text: string) => void;
}) {
  const [tab, setTab] = useState<"file" | "paste">("file");
  const tabClass = (active: boolean) =>
    cn("flex-1 rounded-md px-3 py-1.5 text-sm font-semibold transition", active ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-700");

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Add numbers"
      description="Numbers are encrypted into tokens here — only the tokens are sent to WinRiders."
    >
      {preview ? (
        <ColumnMapper preview={preview} map={map} busy={busy} onRemap={onRemap} onImport={onImport} onCancel={onCancelFile} />
      ) : (
        <div>
          <div className="mb-4 flex gap-1 rounded-lg bg-neutral-100 p-1">
            <button className={tabClass(tab === "file")} onClick={() => setTab("file")}>
              Upload file
            </button>
            <button className={tabClass(tab === "paste")} onClick={() => setTab("paste")}>
              Paste
            </button>
          </div>
          {tab === "file" ? (
            <UploadZone fileName={file?.name} onFile={onFile} />
          ) : (
            <PasteBox busy={busy} onSubmit={onPaste} />
          )}
        </div>
      )}
    </Modal>
  );
}
