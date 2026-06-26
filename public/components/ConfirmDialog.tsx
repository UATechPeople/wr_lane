import type { ConfirmState } from "../lib/useCabinet";
import { Modal } from "./Modal";
import { Button } from "./Button";

export function ConfirmDialog({
  confirm,
  busy,
  onClose,
  onConfirm,
}: {
  confirm: ConfirmState | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={!!confirm} onClose={onClose} title={confirm?.title ?? ""} description={confirm?.description}
      footer={
        <>
          <Button mode="function" onClick={onClose}>
            Cancel
          </Button>
          <Button mode="remove" disabled={busy} onClick={onConfirm}>
            {busy ? "Working…" : confirm?.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    />
  );
}
