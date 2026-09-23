import { Cloud, Eye, EyeOff, GitBranchPlus, HardDrive, SlidersHorizontal, WandSparkles } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { segmentedItemClassName } from "@/components/ui/segmented";
import { cn } from "@/lib/tailwindClassNames";

import {
  librarySourceVisibilityModes,
  type LibrarySourceVisibilityKey,
  type LibrarySourceVisibilityMode,
} from "./librarySourceVisibility";

export type LibrarySourceVisibilityRow = {
  key: LibrarySourceVisibilityKey;
  label: string;
  icon: ReactNode;
  mode: LibrarySourceVisibilityMode;
  visible: boolean;
  note?: string;
};

const modeIcons: Record<LibrarySourceVisibilityMode, typeof Eye> = {
  auto: WandSparkles,
  always: Eye,
  never: EyeOff,
};

export function librarySourceVisibilityIcon(key: LibrarySourceVisibilityKey) {
  if (key === "local") return <HardDrive className="h-4 w-4" />;
  if (key === "tracked") return <GitBranchPlus className="h-4 w-4" />;
  return <Cloud className="h-4 w-4" />;
}

export function LibrarySourceVisibilityPicker({
  rows,
  onChange,
}: {
  rows: LibrarySourceVisibilityRow[];
  onChange: (key: LibrarySourceVisibilityKey, mode: LibrarySourceVisibilityMode) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const modeLabel = (mode: LibrarySourceVisibilityMode) => t(`library.sourceVisibility.modes.${mode}`);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={segmentedItemClassName(open, "px-2")}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("library.sourceVisibility.title")}
        title={t("library.sourceVisibility.title")}
        onClick={() => setOpen((current) => !current)}
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align="start"
        ariaLabel={t("library.sourceVisibility.title")}
        className="w-[min(20rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-foreground">
          <SlidersHorizontal className="h-4 w-4" />
          <span>{t("library.sourceVisibility.title")}</span>
        </div>
        <ul className="space-y-0.5">
          {rows.map((row) => (
            <li key={row.key} className="flex min-h-10 items-center gap-2 rounded-md px-3 py-1.5">
              <span className={cn("shrink-0", row.visible ? "text-foreground" : "text-muted-foreground")}>
                {row.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate",
                    row.visible ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {row.label}
                </span>
                {row.note && <span className="block truncate text-xs text-muted-foreground">{row.note}</span>}
              </span>
              <div
                role="radiogroup"
                aria-label={t("library.sourceVisibility.sourceLabel", { source: row.label })}
                className="flex shrink-0 gap-0.5 rounded-md bg-muted p-0.5"
              >
                {librarySourceVisibilityModes.map((mode) => {
                  const Icon = modeIcons[mode];
                  const selected = row.mode === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={modeLabel(mode)}
                      title={modeLabel(mode)}
                      className={cn(
                        "inline-flex h-7 w-7 items-center justify-center rounded transition-[color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected
                          ? "bg-card text-primary shadow-sm ring-1 ring-foreground/5"
                          : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                      )}
                      onClick={() => onChange(row.key, mode)}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
        <p className="border-t px-3 pb-1.5 pt-2 text-xs text-muted-foreground">
          {t("library.sourceVisibility.storedLocally")}
        </p>
      </AnchoredPopover>
    </>
  );
}
