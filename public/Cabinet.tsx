import { PlusIcon } from "@heroicons/react/24/outline";
import { useCabinet } from "./lib/useCabinet";
import { Button } from "./components/Button";
import { SearchInput } from "./components/SearchInput";
import { UploadsSidebar } from "./components/UploadsSidebar";
import { BaseTable } from "./components/BaseTable";
import { Pager } from "./components/Pager";
import { AddDialog } from "./components/AddDialog";
import { EditDialog } from "./components/EditDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Toast } from "./components/Toast";

export function Cabinet({ onLogout, pushEnabled }: { onLogout: () => void; pushEnabled: boolean }) {
  const c = useCabinet();

  return (
    <div className="min-h-screen bg-neutral-25 text-neutral-800">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Hidden Numbers</h1>
              <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-sm font-semibold text-neutral-700">{c.grandTotal}</span>
            </div>
            <p className="mt-1 text-sm text-neutral-500">Real numbers stay here. WinRiders only ever sees tokens.</p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/api/export.csv"
              className="inline-flex items-center rounded-xl border border-neutral-300 bg-white px-4 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
            >
              Export CSV
            </a>
            {pushEnabled && (
              <Button mode="secondary" disabled={c.busy || c.total === 0} onClick={c.push}>
                Push to WinRiders →
              </Button>
            )}
            <Button onClick={c.openAdd}>
              <PlusIcon className="h-4 w-4" />
              Add numbers
            </Button>
            <Button mode="function" onClick={onLogout}>
              Sign out
            </Button>
          </div>
        </header>

        <div className="mt-8 flex gap-8">
          <UploadsSidebar
            uploads={c.uploads}
            total={c.grandTotal}
            selected={c.selectedUpload}
            onSelect={c.selectUpload}
            onDelete={c.askDeleteUpload}
          />

          <div className="min-w-0 flex-1">
            <div className="mb-3">
              <SearchInput value={c.search} onChange={c.changeSearch} />
            </div>
            <BaseTable rows={c.rows} searching={!!c.search} onEdit={c.openEdit} onDelete={c.askDeleteContact} />
            <Pager page={c.page} pages={c.pages} total={c.total} pageSize={c.pageSize} onPage={c.setPage} />
          </div>
        </div>
      </div>

      <AddDialog
        open={c.adding}
        onClose={c.closeAdd}
        file={c.file}
        preview={c.preview}
        map={c.map}
        busy={c.busy}
        onFile={c.pickFile}
        onRemap={c.remap}
        onImport={c.importFile}
        onCancelFile={c.cancelFile}
        onPaste={c.pasteNumbers}
      />
      <EditDialog row={c.editing} busy={c.busy} onClose={c.closeEdit} onSave={c.saveEdit} />
      <ConfirmDialog confirm={c.confirm} busy={c.busy} onClose={c.closeConfirm} onConfirm={c.runConfirm} />
      <Toast toast={c.toast} onClose={c.dismissToast} />
    </div>
  );
}
