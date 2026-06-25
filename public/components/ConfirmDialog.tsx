import type { Row } from "../lib/api";
import { Modal } from "./Modal";
import { Button } from "./Button";

export function ConfirmDialog({
  row,
  busy,
  onClose,
  onConfirm,
}: {
  row: Row | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={!!row}
      onClose={onClose}
      title="Delete contact"
      description={
        row
          ? `${row.real} and its token are removed from this cabinet. Any token already pushed stays in WinRiders.`
          : undefined
      }
      footer={
        <>
          <Button mode="function" onClick={onClose}>
            Keep
          </Button>
          <Button mode="remove" disabled={busy} onClick={onConfirm}>
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </>
      }
    />
  );
}
