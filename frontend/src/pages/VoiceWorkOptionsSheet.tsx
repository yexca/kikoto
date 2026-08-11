import { Check, Columns3, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { WorkCollectionColumnSetting } from "@/components/work-collection/WorkCollectionLayout";

export type VoiceWorkFilter = "all" | "available" | "local" | "remote" | "missing";

const filterOptions: { value: VoiceWorkFilter; label: string }[] = [
  { value: "all", label: "All works" },
  { value: "available", label: "Available" },
  { value: "local", label: "Local" },
  { value: "remote", label: "Remote" },
  { value: "missing", label: "Missing" },
];

const columnOptions: { value: WorkCollectionColumnSetting; label: string; ariaLabel: string }[] = [
  { value: "auto", label: "Auto", ariaLabel: "Automatic columns" },
  { value: 1, label: "1", ariaLabel: "1 column" },
  { value: 2, label: "2", ariaLabel: "2 columns" },
];

export function VoiceWorkOptionsSheet({
  open,
  onClose,
  filter,
  onFilterChange,
  mobileColumns,
  onMobileColumnsChange,
  selectionMode,
  onSelectWorks,
}: {
  open: boolean;
  onClose: () => void;
  filter: VoiceWorkFilter;
  onFilterChange: (value: VoiceWorkFilter) => void;
  mobileColumns: WorkCollectionColumnSetting;
  onMobileColumnsChange: (value: WorkCollectionColumnSetting) => void;
  selectionMode: boolean;
  onSelectWorks: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeWithEscape);
    return () => document.removeEventListener("keydown", closeWithEscape);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="visual-viewport-layer z-50 flex items-end bg-background/55 p-2 backdrop-blur-sm lg:hidden sm:p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-work-options-title"
        data-android-back-close
        className="app-scroll min-h-0 max-h-full w-full overflow-y-auto rounded-t-lg border bg-card p-4 shadow-xl"
        style={{ paddingBottom: "max(1rem, calc(1rem + var(--safe-area-bottom)))" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="voice-work-options-title" className="text-base font-semibold">
              Voice work options
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Filter and choose how works are arranged.</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close voice work options" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <fieldset className="mt-4 space-y-2">
          <legend className="text-sm font-medium">Availability</legend>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Voice work availability">
            {filterOptions.map((option) => (
              <OptionButton
                key={option.value}
                active={filter === option.value}
                label={option.label}
                onClick={() => onFilterChange(option.value)}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-4 space-y-2">
          <legend className="text-sm font-medium">Columns</legend>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="Mobile voice work columns">
            {columnOptions.map((option) => (
              <OptionButton
                key={String(option.value)}
                active={mobileColumns === option.value}
                label={option.label}
                ariaLabel={option.ariaLabel}
                icon={<Columns3 className="h-4 w-4" />}
                onClick={() => onMobileColumnsChange(option.value)}
              />
            ))}
          </div>
        </fieldset>

        <Button className="mt-4 w-full" variant={selectionMode ? "default" : "outline"} onClick={onSelectWorks}>
          <Check className="h-4 w-4" />
          {selectionMode ? "Exit selection mode" : "Select works"}
        </Button>
      </div>
    </div>
  );
}

function OptionButton({
  active,
  label,
  ariaLabel,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  ariaLabel?: string;
  icon?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex min-h-11 items-center justify-between gap-2 rounded-md border px-3 text-sm transition-colors hover:bg-muted ${
        active ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground"
      }`}
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {active && <Check className="h-4 w-4 shrink-0" />}
    </button>
  );
}
