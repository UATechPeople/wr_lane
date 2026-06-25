import type { InputHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export function Input({
  label,
  hint,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</span>
      <input
        {...props}
        className={cn(
          "rounded-xl border border-neutral-300 px-3 py-2 text-sm text-neutral-800 transition placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-100",
          className,
        )}
      />
      {hint && <span className="text-xs text-neutral-400">{hint}</span>}
    </label>
  );
}
