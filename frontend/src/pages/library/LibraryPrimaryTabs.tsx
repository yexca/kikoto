import { Cloud, GitBranchPlus, HardDrive } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SourceVisibilityPicker } from "@/components/source-visibility/SourceVisibilityPicker";
import { remoteSourceVisibilityKey } from "@/components/source-visibility/sourceVisibility";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import type { LibrarySource } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import type { useLibrarySourceVisibility } from "./useLibrarySourceVisibility";

export function LibraryPrimaryTabs({
  variant = "segmented",
  active,
  activeSourceId,
  sources,
  sourceVisibility,
  onChange,
  onSourceChange,
}: {
  variant?: "segmented" | "chips";
  active: "local" | "tracked" | null;
  activeSourceId: number | null;
  sources: LibrarySource[];
  sourceVisibility: ReturnType<typeof useLibrarySourceVisibility>;
  onChange: (tab: "local" | "tracked") => void;
  onSourceChange: (source: LibrarySource) => void;
}) {
  const { t } = useTranslation();
  const { rows, visibleKeys, changeMode } = sourceVisibility;
  // The selected entry stays visible so the bar never hides where the viewer is.
  const shown = (key: Parameters<typeof visibleKeys.has>[0], selected: boolean) => selected || visibleKeys.has(key);
  const chips = variant === "chips";
  const visibilityPicker = (
    <SourceVisibilityPicker
      title={t("library.sourceVisibility.title")}
      rows={rows}
      triggerClassName={(open) => segmentedItemClassName(open, "px-2")}
      onChange={changeMode}
    />
  );
  return (
    <div className={chips ? "flex w-max items-center gap-1.5" : segmentedListClassName()}>
      {!chips && visibilityPicker}
      {shown("local", active === "local") && (
        <TabButton
          chips={chips}
          active={active === "local"}
          onClick={() => onChange("local")}
          icon={<HardDrive className="h-4 w-4" />}
        >
          {t("library.local")}
        </TabButton>
      )}
      {shown("tracked", active === "tracked") && (
        <TabButton
          chips={chips}
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
            chips={chips}
            active={activeSourceId === source.id}
            onClick={() => onSourceChange(source)}
            icon={<Cloud className="h-4 w-4" />}
          >
            {source.displayName}
          </TabButton>
        ))}
      {chips && <div className="rounded-full bg-muted p-0.5">{visibilityPicker}</div>}
    </div>
  );
}

function TabButton({
  chips = false,
  active,
  disabled,
  icon,
  children,
  onClick,
}: {
  chips?: boolean;
  active: boolean;
  disabled?: boolean;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={
        chips
          ? cn(
              "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&>svg]:h-3.5 [&>svg]:w-3.5",
              active
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-card text-muted-foreground hover:text-foreground",
            )
          : segmentedItemClassName(active)
      }
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span className="max-w-40 truncate">{children}</span>
    </button>
  );
}
