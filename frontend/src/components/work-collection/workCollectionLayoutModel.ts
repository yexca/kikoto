import type { CSSProperties } from "react";

import type { SourceVisibilityMode } from "@/components/source-visibility/sourceVisibility";
import type { CompactWorkCardLayout } from "@/components/work-card/CompactWorkCard";

export const workCollectionColumnOptions = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type WorkCollectionColumnCount = (typeof workCollectionColumnOptions)[number];
export type WorkCollectionColumnSetting = "auto" | WorkCollectionColumnCount;

/** Narrow screens only fit one or two cards per row. */
export const workCollectionMobileColumnOptions = [1, 2] as const satisfies readonly WorkCollectionColumnCount[];
/** One or two cards leave most of a desktop row empty, so desktop starts at three. */
export const workCollectionDesktopColumnOptions = [
  3, 4, 5, 6, 7, 8,
] as const satisfies readonly WorkCollectionColumnCount[];

/** How much of a work each card shows, from the regular card down to the cover with its title. */
export const workCardModes = ["full", "compact", "mini"] as const;
export type WorkCardMode = (typeof workCardModes)[number];

/**
 * The display settings a card mode starts from besides automatic wide-screen
 * columns: a mini cover fits more works per page and leaves out its source marks.
 */
export const workCardModePresets: Record<WorkCardMode, { pageSize: number; coverSources: SourceVisibilityMode }> = {
  full: { pageSize: 24, coverSources: "auto" },
  compact: { pageSize: 24, coverSources: "auto" },
  mini: { pageSize: 48, coverSources: "never" },
};

/**
 * Chooses a card mode and, when it changes, applies that mode's preset to the
 * settings the caller offers. Wide-screen columns return to automatic, which
 * fits as many cards as the mode allows; they are offered only on a wide
 * screen, and a page size applies only when it is one of the page's options.
 */
export function chooseWorkCardMode(
  current: WorkCardMode | undefined,
  next: WorkCardMode,
  targets: {
    setMode: (mode: WorkCardMode) => void;
    setDesktopColumns?: (value: WorkCollectionColumnSetting) => void;
    pageSizeOptions?: readonly number[];
    setPageSize?: (value: number) => void;
    setCoverSources?: (mode: SourceVisibilityMode) => void;
  },
) {
  targets.setMode(next);
  if (current === next) return;
  const preset = workCardModePresets[next];
  targets.setDesktopColumns?.("auto");
  if (targets.pageSizeOptions?.includes(preset.pageSize)) targets.setPageSize?.(preset.pageSize);
  targets.setCoverSources?.(preset.coverSources);
}

export type StoredWorkCollectionLayout = {
  mobileColumns: WorkCollectionColumnSetting;
  desktopColumns: WorkCollectionColumnSetting;
  /** Card modes apply to the collections that offer the choice, one per screen width. */
  mobileCardMode: WorkCardMode;
  desktopCardMode: WorkCardMode;
};

export type WorkCollectionColumnDefaults = Pick<StoredWorkCollectionLayout, "mobileColumns" | "desktopColumns">;

type AutoColumns = { maximum: number; minWidth: string };

/**
 * Automatic wide-screen columns per card size. Smaller cards allow more tracks
 * and a narrower minimum, sized so every mode reaches its maximum at about the
 * same container width and steps down together below it.
 */
const autoColumns = {
  regular: { maximum: 5, minWidth: "16rem" },
  tile: { maximum: 6, minWidth: "13rem" },
  cover: { maximum: 7, minWidth: "11rem" },
} satisfies Record<string, AutoColumns>;

export function workCollectionClassName() {
  return "grid gap-3 sm:gap-4 [grid-template-columns:var(--mobile-grid-template)] lg:[grid-template-columns:var(--desktop-grid-template)]";
}

export function workCollectionStyle(
  mobileColumns: WorkCollectionColumnSetting,
  desktopColumns: WorkCollectionColumnSetting,
  cardLayout: CompactWorkCardLayout | null = null,
) {
  return {
    // One cover card fills a phone row, so automatic phone columns pair them up.
    "--mobile-grid-template": gridTemplate(cardLayout === "cover" && mobileColumns === "auto" ? 2 : mobileColumns),
    // Phone rows only occur below the wide breakpoint, so they keep the regular tracks.
    "--desktop-grid-template": gridTemplate(
      desktopColumns,
      cardLayout === "tile" || cardLayout === "cover" ? autoColumns[cardLayout] : autoColumns.regular,
    ),
  } as CSSProperties;
}

/**
 * The reduced card layout a mode uses at the current width, or null for the
 * regular card. Compact reads as rows in a single phone column and as short
 * tiles everywhere else.
 */
export function workCardLayout(
  mode: WorkCardMode,
  wide: boolean,
  mobileColumns: WorkCollectionColumnSetting,
): CompactWorkCardLayout | null {
  if (mode === "mini") return "cover";
  if (mode === "compact") return wide || mobileColumns === 2 ? "tile" : "row";
  return null;
}

export function isWorkCardMode(value: unknown): value is WorkCardMode {
  return (workCardModes as readonly unknown[]).includes(value);
}

/** Reads the stored layout, keeping each valid field and defaulting the rest. */
export function storedWorkCollectionLayout(
  raw: string | null,
  defaults: WorkCollectionColumnDefaults,
): StoredWorkCollectionLayout {
  const fallback: StoredWorkCollectionLayout = { ...defaults, mobileCardMode: "full", desktopCardMode: "full" };
  try {
    const value = JSON.parse(raw ?? "{}") as Partial<StoredWorkCollectionLayout> & { mobileCompact?: unknown };
    return {
      mobileColumns: isWorkCollectionMobileColumnSetting(value.mobileColumns)
        ? value.mobileColumns
        : fallback.mobileColumns,
      // A stored desktop column choice outside the supported options reverts to the default.
      desktopColumns: isWorkCollectionDesktopColumnSetting(value.desktopColumns)
        ? value.desktopColumns
        : isWorkCollectionDesktopColumnSetting(fallback.desktopColumns)
          ? fallback.desktopColumns
          : "auto",
      // A stored `mobileCompact` flag is the compact phone mode.
      mobileCardMode: isWorkCardMode(value.mobileCardMode)
        ? value.mobileCardMode
        : value.mobileCompact === true
          ? "compact"
          : fallback.mobileCardMode,
      desktopCardMode: isWorkCardMode(value.desktopCardMode) ? value.desktopCardMode : fallback.desktopCardMode,
    };
  } catch {
    return fallback;
  }
}

export function isWorkCollectionColumnCount(value: unknown): value is WorkCollectionColumnCount {
  return workCollectionColumnOptions.includes(value as WorkCollectionColumnCount);
}

export function isWorkCollectionMobileColumnSetting(value: unknown): value is WorkCollectionColumnSetting {
  return value === "auto" || (workCollectionMobileColumnOptions as readonly unknown[]).includes(value);
}

export function isWorkCollectionDesktopColumnSetting(value: unknown): value is WorkCollectionColumnSetting {
  return value === "auto" || (workCollectionDesktopColumnOptions as readonly unknown[]).includes(value);
}

function gridTemplate(setting: WorkCollectionColumnSetting, auto: AutoColumns = autoColumns.regular) {
  if (setting === "auto") {
    // The percentage term caps wide layouts at the maximum track count (with
    // the 1rem wide-screen gap) while the fixed minimum lets narrower
    // containers step down naturally.
    const cap = `calc((100% - ${auto.maximum - 1}rem) / ${auto.maximum})`;
    return `repeat(auto-fill, minmax(min(100%, max(${auto.minWidth}, ${cap})), 1fr))`;
  }
  return `repeat(${setting}, minmax(0, 1fr))`;
}
