import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import { CheckIcon, ChevronUpDownIcon } from "@heroicons/react/24/outline";
import { cn } from "../lib/cn";

export function Select({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Listbox value={value} onChange={onChange} disabled={disabled}>
      <div className="relative flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</span>
        <ListboxButton
          className={cn(
            "flex items-center justify-between gap-2 rounded-xl border border-neutral-300 px-3 py-2 text-left text-sm text-neutral-800 transition",
            "focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-100",
            disabled && "cursor-not-allowed bg-neutral-50 text-neutral-500",
          )}
        >
          <span className="truncate font-mono text-xs">{value}</span>
          {!disabled && <ChevronUpDownIcon className="h-4 w-4 shrink-0 text-neutral-400" />}
        </ListboxButton>
        <ListboxOptions
          anchor="bottom start"
          className="z-[60] w-[var(--button-width)] rounded-xl border border-neutral-200 bg-white p-1 shadow-xl [--anchor-gap:4px] focus:outline-none"
        >
          {options.map((option) => (
            <ListboxOption
              key={option}
              value={option}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 font-mono text-xs text-neutral-700 data-[focus]:bg-neutral-100 data-[selected]:font-semibold data-[selected]:text-neutral-900"
            >
              {option}
              <CheckIcon className="hidden h-4 w-4 text-brand-600 group-data-[selected]:block" />
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}
