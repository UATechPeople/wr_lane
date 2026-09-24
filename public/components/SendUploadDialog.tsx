import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { api, type Batch, type Upload } from "../lib/api";

export function SendUploadDialog({
  upload,
  onClose,
  onSent,
}: {
  upload: Upload | null;
  onClose: () => void;
  onSent: (batch: Batch) => void;
}) {
  const [alreadySent, setAlreadySent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAlreadySent(false);
    setError(null);
  }, [upload]);

  if (!upload) return null;

  const send = async () => {
    setBusy(true);
    setError(null);
    const res = await api.sendUpload(upload.id, { force: alreadySent || undefined });
    setBusy(false);
    if (res.conflict) {
      setAlreadySent(true);
      setError(res.error ?? "this upload was already sent");
      return;
    }
    if (res.error || !res.batch) {
      setError(res.error ?? "sending failed");
      return;
    }
    onSent(res.batch);
  };

  return (
    <Modal
      open={!!upload}
      onClose={onClose}
      title={`Send “${upload.label}” to WinRiders`}
      description={`${upload.count} numbers become calls. They leave in the background at the send rate set in Settings.`}
      footer={
        <>
          <Button mode="function" onClick={onClose}>
            Cancel
          </Button>
          <Button mode={alreadySent ? "remove" : "primary"} disabled={busy} onClick={send}>
            {busy ? "Sending…" : alreadySent ? "Send again as new calls" : "Send"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-neutral-600">
          Segment, cohort and result webhook come from the file, row by row; an empty cell falls back to the defaults in Settings.
        </p>
        {error && (
          <p className={alreadySent ? "rounded-xl bg-amber-50 p-3 text-sm text-amber-800" : "rounded-xl bg-red-50 p-3 text-sm text-red-700"}>{error}</p>
        )}
      </div>
    </Modal>
  );
}
