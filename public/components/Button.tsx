import type { ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

// Mirrors ui Button: primary is near-black (neutral-950), brand indigo is accent only.
export type ButtonMode = "primary" | "secondary" | "tertiary" | "remove" | "function";

const base =
  "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold tracking-tight transition-all duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed";

const modeStyles: Record<ButtonMode, string> = {
  primary: "bg-neutral-950 text-white hover:bg-neutral-800 active:bg-neutral-900 disabled:bg-neutral-300 disabled:text-neutral-500",
  secondary: "bg-white text-neutral-700 border border-neutral-300 hover:bg-neutral-50 active:bg-neutral-100 disabled:bg-neutral-100 disabled:text-neutral-400",
  tertiary: "bg-white text-neutral-700 border border-neutral-300 hover:border-neutral-400 active:bg-neutral-50 disabled:bg-neutral-50 disabled:text-neutral-400",
  remove: "bg-red-600 text-white hover:bg-red-500 active:bg-red-700 disabled:bg-red-300",
  function: "bg-transparent text-neutral-700 hover:bg-neutral-100 active:bg-neutral-200 disabled:text-neutral-400 disabled:hover:bg-transparent",
};

export function Button({
  mode = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { mode?: ButtonMode }) {
  return <button className={cn(base, modeStyles[mode], className)} {...props} />;
}
