import { useEffect, useState } from "react";
import type { Row } from "../lib/api";
import { Modal } from "./Modal";
import { Input } from "./Input";
import { Button } from "./Button";

export function EditDialog({
  row,
  busy,
  onClose,
  onSave,
}: {
  row: Row | null;
  busy: boolean;
  onClose: () => void;
  onSave: (id: number, patch: Record<string, string>) => void;
}) {
  const [real, setReal] = useState("");
  const [firstName, setFirstName] = useState("");
  const [segment, setSegment] = useState("");

  useEffect(() => {
    if (row) {
      setReal(row.real);
      setFirstName(row.first_name ?? "");
      setSegment(row.segment ?? "");
    }
  }, [row]);

  function save() {
    if (!row) return;
    const patch: Record<string, string> = {};
    if (real.trim() && real.trim() !== row.real) patch.real = real.trim();
    if (firstName.trim() !== (row.first_name ?? "")) patch.first_name = firstName.trim();
    if (segment.trim() !== (row.segment ?? "")) patch.segment = segment.trim();
    onSave(row.id, patch);
  }

  return (
    <Modal
      open={!!row}
      onClose={onClose}
      title="Edit contact"
      description={row ? `Token ${row.token}` : undefined}
      footer={
        <>
          <Button mode="function" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Phone number"
          value={real}
          onChange={(e) => setReal(e.target.value)}
          placeholder="+447700900456"
          hint="Changing the number re-issues its token."
        />
        <Input label="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="—" />
        <Input label="Segment" value={segment} onChange={(e) => setSegment(e.target.value)} placeholder="—" />
      </div>
    </Modal>
  );
}
