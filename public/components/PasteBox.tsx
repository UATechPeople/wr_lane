import { useState } from "react";
import { Button } from "./Button";

export function PasteBox({ busy, onSubmit }: { busy: boolean; onSubmit: (text: string) => void }) {
  const [raw, setRaw] = useState("");
  return (
    <div>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder="+380501112233, one per line"
        className="block h-36 w-full rounded-xl border border-neutral-300 p-3 font-mono text-sm transition placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-100"
      />
      <div className="mt-3 flex justify-end">
        <Button
          disabled={busy || !raw.trim()}
          onClick={() => {
            onSubmit(raw);
            setRaw("");
          }}
        >
          Encrypt &amp; store
        </Button>
      </div>
    </div>
  );
}
