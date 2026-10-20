import { Check, ChevronDown, Cloud, GitBranchPlus, HardDrive } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SourceVisibilityPicker } from "@/components/source-visibility/SourceVisibilityPicker";
import { remoteSourceVisibilityKey } from "@/components/source-visibility/sourceVisibility";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import type { LibrarySource } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import type { useLibrarySourceVisibility } from "./useLibrarySourceVisibility";

type LibrarySourceProps = {
  active: "local" | "tracked" | null;
  activeSourceId: number | null;
  sources: LibrarySource[];
  onChange: (tab: "local" | "tracked") => void;
  onSourceChange: (source: LibrarySource) => void;
};

/** The wide-layout source switcher: a segmented bar filtered by each source's visibility mode. */
export function LibraryPrimaryTabs({
  active,
  activeSourceId,
  sources,
  sourceVisibility,
  onChange,
  onSourceChange,
}: LibrarySourceProps & { sourceVisibility: ReturnType<typeof useLibrarySourceVisibility> }) {
  const { t } = useTranslation();
  const { rows, visibleKeys, changeMode } = sourceVisibility;
  // The selected entry stays visible so the bar never hides where the viewer is.
  const shown = (key: Parameters<typeof visibleKeys.has>[0], selected: boolean) => selected || visibleKeys.has(key);
  return (
    <div className={segmentedListClassName()}>
      <SourceVisibilityPicker
        title={t("library.sourceVisibility.title")}
        rows={rows}
        triggerClassName={(open) => segmentedItemClassName(open, "px-2")}
        onChange={changeMode}
      />
      {shown("local", active === "local") && (
        <TabButton
          active={active === "local"}
          onClick={() => onChange("local")}
          icon={<HardDrive className="h-4 w-4" />}
        >
          {t("library.local")}
        </TabButton>
      )}
      {shown("tracked", active === "tracked") && (
        <TabButton
          active={active === "tracked"}
          onClick={() => onChange("tracked")}
          icon={<GitBranchPlus className="h-4 w-4" />}
        >
          {t("library.tracked")}
        </TabButton>
      )}
      {sources
        .filter((source) => shown(remoteSourceVisibilityKey(source.id), activeSourceId === source.id))
        .map((source) => (
          <TabButton
            key={source.id}
            active={activeSourceId === source.id}
            onClick={() => onSourceChange(source)}
            icon={<Cloud className="h-4 w-4" />}
          >
            {source.displayName}
          </TabButton>
        ))}
    </div>
  );
}

/**
 * The phone source switcher: one button that names the current source and
 * opens every source in a menu, so switching takes no toolbar row and needs
 * no visibility settings.
 */
export function LibrarySourceMenu({ active, activeSourceId, sources, onChange, onSourceChange }: LibrarySourceProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const noteId = useId();
  const entries: {
    key: string;
    label: string;
    icon: ReactNode;
    selected: boolean;
    note?: string;
    select: () => void;
  }[] = [
    {
      key: "local",
      label: t("library.local"),
      icon: <HardDrive className="h-4 w-4" />,
      selected: active === "local",
      select: () => onChange("local"),
    },
    {
      key: "tracked",
      label: t("library.tracked"),
      icon: <GitBranchPlus className="h-4 w-4" />,
      selected: active === "tracked",
      select: () => onChange("tracked"),
    },
    ...sources.map((source) => ({
      key: `source-${source.id}`,
      label: source.displayName,
      icon: <Cloud className="h-4 w-4" />,
      selected: activeSourceId === source.id,
      note: source.enabled ? undefined : t("library.sourceVisibility.disabled"),
      select: () => onSourceChange(source),
    })),
  ];
  const current = entries.find((entry) => entry.selected) ?? entries[0];

  return (
    <div className="relative shrink-0" ref={anchorRef}>
      <button
        type="button"
        className={cn(
          "inline-flex h-11 max-w-[8.5rem] items-center gap-1.5 rounded-full border bg-card pl-3.5 pr-2.5 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&>svg]:shrink-0",
          open && "border-primary/50",
        )}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("library.sourceMenuLabel", { source: current.label })}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-muted-foreground" aria-hidden="true">
          {current.icon}
        </span>
        <span className="min-w-0 truncate">{current.label}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        bottomCollisionPadding={168}
        className="w-[min(16rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="menu" aria-label={t("library.sourceMenu")}>
          {entries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="menuitemradio"
              aria-checked={entry.selected}
              aria-label={entry.label}
              aria-describedby={entry.note ? `${noteId}-${entry.key}` : undefined}
              className={cn(
                "flex min-h-11 w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left transition-colors hover:bg-muted",
                entry.selected ? "bg-primary/10 font-medium text-primary" : "text-foreground",
              )}
              onClick={() => {
                setOpen(false);
                if (!entry.selected) entry.select();
              }}
            >
              <span className={cn("shrink-0", !entry.selected && "text-muted-foreground")} aria-hidden="true">
                {entry.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{entry.label}</span>
                {entry.note && (
                  <span id={`${noteId}-${entry.key}`} className="block truncate text-xs text-muted-foreground">
                    {entry.note}
                  </span>
                )}
              </span>
              {entry.selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function TabButton({
  active,
  icon,
  children,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={segmentedItemClassName(active)} aria-pressed={active} onClick={onClick}>
      {icon}
      <span className="max-w-40 truncate">{children}</span>
    </button>
  );
}
