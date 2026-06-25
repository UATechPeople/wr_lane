import { cn } from "../lib/cn";

// Mirrors ui StatusBadge: pill + colored dot, semantic palette.
export type Tone = "neutral" | "success" | "info" | "warning" | "danger";

const tones: Record<Tone, { bg: string; text: string; dot: string }> = {
  neutral: { bg: "bg-neutral-100", text: "text-neutral-600", dot: "bg-neutral-400" },
  success: { bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500" },
  info: { bg: "bg-sky-50", text: "text-sky-700", dot: "bg-sky-500" },
  warning: { bg: "bg-amber-50", text: "text-amber-700", dot: "bg-amber-500" },
  danger: { bg: "bg-red-50", text: "text-red-700", dot: "bg-red-500" },
};

export function StatusBadge({
  label,
  tone = "neutral",
  dot = true,
  className,
}: {
  label: string;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}) {
  const s = tones[tone];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold", s.bg, s.text, className)}
    >
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />}
      {label}
    </span>
  );
}
