import { useEffect } from "react";
import { CheckCircleIcon, ExclamationTriangleIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { cn } from "../lib/cn";

export type ToastTone = "success" | "error" | "info";
export type ToastData = { text: string; tone: ToastTone };

export function Toast({ toast, onClose }: { toast: ToastData | null; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(onClose, 4500);
    return () => clearTimeout(id);
  }, [toast, onClose]);

  if (!toast) return null;

  const tone = {
    success: "text-emerald-700",
    error: "text-red-700",
    info: "text-neutral-700",
  }[toast.tone];

  return (
    <div className="fixed bottom-5 right-5 z-50 motion-safe:animate-[toast_180ms_ease-out]">
      <div className="flex max-w-sm items-start gap-3 rounded-xl border border-neutral-100 bg-white px-4 py-3 shadow-xl">
        {toast.tone === "error" ? (
          <ExclamationTriangleIcon className={cn("mt-0.5 h-5 w-5 shrink-0", tone)} />
        ) : (
          <CheckCircleIcon className={cn("mt-0.5 h-5 w-5 shrink-0", tone)} />
        )}
        <span className="text-sm font-medium text-neutral-800">{toast.text}</span>
        <button onClick={onClose} className="ml-1 shrink-0 text-neutral-400 transition hover:text-neutral-700">
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
