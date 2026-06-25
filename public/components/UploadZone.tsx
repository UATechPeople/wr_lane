import { useRef, useState } from "react";
import { cn } from "../lib/cn";

export function UploadZone({ fileName, onFile }: { fileName?: string | null; onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  return (
    <section
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      className={cn(
        "cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition",
        drag ? "border-brand-500 bg-brand-50" : "border-neutral-250 bg-neutral-25 hover:bg-neutral-50",
      )}
    >
      <input
        ref={input}
        type="file"
        accept=".csv,.xlsx,.xls"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
      {fileName ? (
        <span className="font-semibold text-neutral-900">{fileName}</span>
      ) : (
        <span className="text-neutral-500">
          <span className="font-semibold text-neutral-900">Drop a CSV / XLSX</span> here, or click to choose
        </span>
      )}
    </section>
  );
}
