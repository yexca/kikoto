import type { ReactNode } from "react";

import { DialogBody } from "@/components/ui/dialog";
import { cn } from "@/lib/tailwindClassNames";

/** A fixed height, so switching presets or locations scrolls the form instead of resizing the dialog. */
export const presetDialogClassName = "h-[var(--dialog-max-height)] sm:h-[min(42rem,var(--dialog-max-height))]";

export type PresetPicker = {
  label: string;
  items: Array<{ id: string; label: string }>;
  selectedId: string;
  /** A saved service keeps its preset: the choice stays visible and the others are disabled. */
  locked: boolean;
  onSelect: (id: string) => void;
};

/**
 * The body of a service dialog. With a picker, the presets to choose from sit
 * on the left and the chosen preset's form on the right; a phone stacks the
 * presets above the form as one scrolling row. Without one, it is the form alone.
 */
export function PresetDialogBody({
  picker,
  disabled = false,
  children,
}: {
  picker: PresetPicker | null;
  disabled?: boolean;
  children: ReactNode;
}) {
  if (!picker) return <DialogBody>{children}</DialogBody>;
  return (
    <div className="flex min-h-0 flex-1 flex-col sm:grid sm:grid-cols-[12rem_minmax(0,1fr)] sm:grid-rows-[minmax(0,1fr)]">
      <div
        role="radiogroup"
        aria-label={picker.label}
        className="app-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b bg-muted/30 p-2 sm:min-h-0 sm:flex-col sm:overflow-y-auto sm:overflow-x-hidden sm:border-b-0 sm:border-r"
      >
        {picker.items.map((item) => {
          const selected = item.id === picker.selectedId;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled || (picker.locked && !selected)}
              className={cn(
                "touch-target relative flex min-h-9 shrink-0 items-center rounded-[var(--control-radius)] px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none sm:w-full",
                selected
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-foreground hover:bg-muted disabled:opacity-50",
              )}
              onClick={() => picker.onSelect(item.id)}
            >
              <span className="whitespace-nowrap sm:whitespace-normal">{item.label}</span>
            </button>
          );
        })}
      </div>
      <DialogBody>{children}</DialogBody>
    </div>
  );
}
