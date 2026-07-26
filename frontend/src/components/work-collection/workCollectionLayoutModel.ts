import type { CSSProperties } from "react";

export const workCollectionColumnOptions = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type WorkCollectionColumnCount = (typeof workCollectionColumnOptions)[number];
export type WorkCollectionColumnSetting = "auto" | WorkCollectionColumnCount;
export type WorkCollectionViewMode = "grid" | "masonry";

const autoColumnMinWidth = "16rem";
const autoColumnMaxCount = 5;

export function workCollectionClassName(viewMode: WorkCollectionViewMode) {
  return viewMode === "masonry"
    ? "[column-count:var(--mobile-column-count)] [column-width:var(--mobile-column-width)] [column-gap:1rem] lg:[column-count:var(--desktop-column-count)] lg:[column-width:var(--desktop-column-width)]"
    : "grid gap-4 [grid-template-columns:var(--mobile-grid-template)] lg:[grid-template-columns:var(--desktop-grid-template)]";
}

export function workCollectionStyle(
  mobileColumns: WorkCollectionColumnSetting,
  desktopColumns: WorkCollectionColumnSetting,
) {
  return {
    "--mobile-grid-template": gridTemplate(mobileColumns),
    "--desktop-grid-template": gridTemplate(desktopColumns),
    "--mobile-column-count": columnCount(mobileColumns),
    "--desktop-column-count": columnCount(desktopColumns),
    "--mobile-column-width": columnWidth(mobileColumns),
    "--desktop-column-width": columnWidth(desktopColumns),
  } as CSSProperties;
}

export function workCollectionItemClassName(viewMode: WorkCollectionViewMode) {
  return viewMode === "masonry" ? "mb-4 [break-inside:avoid]" : "";
}

export function isWorkCollectionColumnCount(value: unknown): value is WorkCollectionColumnCount {
  return workCollectionColumnOptions.includes(value as WorkCollectionColumnCount);
}

function gridTemplate(setting: WorkCollectionColumnSetting) {
  if (setting === "auto") {
    // The percentage term caps wide layouts at five tracks while the fixed
    // minimum lets narrower containers step down naturally.
    return `repeat(auto-fill, minmax(min(100%, max(${autoColumnMinWidth}, calc(20% - 0.8rem))), 1fr))`;
  }
  return `repeat(${setting}, minmax(0, 1fr))`;
}

function columnCount(setting: WorkCollectionColumnSetting) {
  return setting === "auto" ? String(autoColumnMaxCount) : String(setting);
}

function columnWidth(setting: WorkCollectionColumnSetting) {
  return setting === "auto" ? autoColumnMinWidth : "auto";
}
