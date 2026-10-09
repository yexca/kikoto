import type { LucideIcon } from "lucide-react";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  RailLabelsToggle,
  RailOrientationToggle,
  type RailOrientation,
  useRailLabelsShown,
} from "@/components/ui/rail-labels";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { cx } from "@/lib/classNames";

export type IconRailItem<T extends string> = {
  value: T;
  label: string;
  icon: LucideIcon;
  /** Tab element id, so the controlled panel can reference it. */
  id: string;
  /** Id of the panel this tab controls. */
  controls: string;
  /** Draws a divider before this item to separate a different kind of view. */
  separated?: boolean;
  /** Optional group heading, shown when the wide rail is expanded. */
  groupLabel?: string;
  /** Accessible description, such as the elevated scope that a separated group shares. */
  description?: string;
};

/**
 * A page-level tab rail of icons. Wide layouts show a sticky vertical rail
 * beside the page content; the mobile navigation layout shows a row of icons
 * above it with only the active item labelled. Every item keeps its label as
 * the accessible name and tooltip. Arrow keys move and select, as in the
 * other tab strips, and a scrolled compact row keeps the active item in view.
 * A toggle below the wide rail shows or hides the labels beside the icons; the
 * labels show by default and the choice is remembered separately for each
 * rail. A page that passes an orientation toggle also lets wide layouts run
 * the rail as a row above the content. That row names as much as fits on one
 * line: every item, then only the selected item's group (the items between
 * dividers) beside the other groups' icons, then only the selected item. It
 * wraps instead of scrolling when even that does not fit.
 */
export function IconRail<T extends string>({
  label,
  labelsStorageKey,
  items,
  selected,
  onSelect,
  orientation = "vertical",
  onToggleOrientation,
}: {
  label: string;
  /** Local storage key that remembers whether this rail names its items. */
  labelsStorageKey: string;
  items: IconRailItem<T>[];
  selected: T | null;
  onSelect: (value: T) => void;
  /** Wide-layout placement; the mobile navigation layout always uses a row. */
  orientation?: RailOrientation;
  /** Shows a wide-layout control that switches the orientation. */
  onToggleOrientation?: () => void;
}) {
  const mobile = useMobileNavigationLayout();
  const [labelsShown, toggleLabels] = useRailLabelsShown(labelsStorageKey, true);
  const row = mobile || orientation === "horizontal";
  const wideRow = row && !mobile;
  // Only the wide column expands; rows name items by how much fits.
  const expanded = !row && labelsShown;
  const listRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const iconProbeRef = useRef<HTMLSpanElement>(null);
  const [rowNaming, setRowNaming] = useState<RowNaming>("all");
  const groups = itemGroups(items);
  const groupsKey = groups.join();
  const selectedIndex = items.findIndex((item) => item.value === selected);
  const descriptionIdBase = useId();
  const descriptions = [...new Set(items.flatMap((item) => (item.description ? [item.description] : [])))];
  const descriptionId = (description: string) => `${descriptionIdBase}-${descriptions.indexOf(description)}`;

  // Only the row scrolls, e.g. after a deep link to a later item; the page keeps its position.
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!list || !tab || list.scrollWidth <= list.clientWidth) return;
    const row = list.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    // Round away from the edge so a fractional layout still reveals the whole item.
    if (box.left < row.left) list.scrollLeft -= Math.ceil(row.left - box.left);
    else if (box.right > row.right) list.scrollLeft += Math.ceil(box.right - row.right);
  }, [selected, mobile, orientation]);

  // A hidden copy of the row with every item named measures each label, so the
  // wide row chooses its naming before paint and again whenever it resizes.
  useLayoutEffect(() => {
    const list = listRef.current;
    const measure = measureRef.current;
    const iconProbe = iconProbeRef.current;
    if (!wideRow || !list || !measure || !iconProbe) return;
    const groupOf = groupsKey.split(",");
    const fit = () => {
      const named = [...measure.querySelectorAll<HTMLElement>("[data-measure-tab]")].map(
        (tab) => tab.getBoundingClientRect().width,
      );
      const icon = iconProbe.getBoundingClientRect().width;
      // Gaps and dividers stay the same whichever items are named.
      const fixed = measure.getBoundingClientRect().width - named.reduce((sum, width) => sum + width, 0);
      const fits = (isNamed: (index: number) => boolean) =>
        fixed + named.reduce((sum, width, index) => sum + (isNamed(index) ? width : icon), 0) <= list.clientWidth + 0.5;
      const selectedGroup = groupOf[selectedIndex];
      setRowNaming(fits(() => true) ? "all" : fits((index) => groupOf[index] === selectedGroup) ? "group" : "active");
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(list);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [wideRow, groupsKey, selectedIndex]);

  const isNamed = (index: number) => {
    if (!row) return expanded;
    if (mobile || rowNaming === "active") return index === selectedIndex;
    return rowNaming === "all" || groups[index] === groups[selectedIndex];
  };

  return (
    <div
      className={cx(
        "min-w-0 shrink-0",
        !row && "sticky top-20 flex flex-col gap-1 self-start border-r pr-2",
        wideRow && "relative flex items-end gap-2 border-b",
      )}
    >
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        aria-orientation={row ? "horizontal" : "vertical"}
        // relative contains the visually hidden descriptions, which would otherwise widen a scrolled mobile page.
        // The compact row scrolls only sideways: each item's touch target reaches past its box and would
        // otherwise let the row scroll vertically too.
        className={cx(
          "app-scrollbar relative flex min-w-0 gap-1",
          !row && "flex-col",
          wideRow && "flex-1 flex-wrap",
          mobile && "overflow-x-auto overflow-y-hidden",
        )}
      >
        {descriptions.map((description) => (
          <span key={description} id={descriptionId(description)} className="sr-only">
            {description}
          </span>
        ))}
        {items.map((item, index) => {
          const Icon = item.icon;
          const active = selected === item.value;
          const named = isNamed(index);
          return (
            <Fragment key={item.value}>
              {item.groupLabel && item.groupLabel !== items[index - 1]?.groupLabel && expanded && !row && (
                <span aria-hidden="true" className="px-3 pt-2 text-xs text-muted-foreground">
                  {item.groupLabel}
                </span>
              )}
              {item.separated && (
                <span
                  aria-hidden="true"
                  className={cx("shrink-0 bg-border", row ? rowDividerClassName : "mx-2 my-1 h-px")}
                />
              )}
              <Button
                id={item.id}
                role="tab"
                aria-selected={active}
                aria-controls={item.controls}
                aria-describedby={item.description ? descriptionId(item.description) : undefined}
                tabIndex={active ? 0 : -1}
                title={named ? undefined : item.label}
                variant="ghost"
                className={cx(
                  row ? rowTabClassName : "relative h-11 min-w-11 shrink-0 gap-2",
                  !row && (expanded ? "w-full px-3" : "w-11 px-0"),
                  named && !mobile ? "justify-start font-normal" : "justify-center",
                  active ? "bg-primary/10 text-foreground [&>svg]:text-primary" : "text-muted-foreground",
                )}
                onClick={() => onSelect(item.value)}
                onKeyDown={(event) => {
                  const previous = event.key === "ArrowUp" || event.key === "ArrowLeft";
                  const next = event.key === "ArrowDown" || event.key === "ArrowRight";
                  const target = next
                    ? (index + 1) % items.length
                    : previous
                      ? (index - 1 + items.length) % items.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? items.length - 1
                          : -1;
                  if (target < 0) return;
                  event.preventDefault();
                  onSelect(items[target].value);
                  const tabs = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                  tabs?.[target]?.focus({ preventScroll: true });
                }}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className={cx(
                      "absolute rounded-full bg-primary",
                      row ? "inset-x-2 bottom-0 h-[3px]" : "inset-y-2 left-0 w-[3px]",
                    )}
                  />
                )}
                <Icon className="h-5 w-5" />
                {/* An unnamed item keeps its label as the accessible name and tooltip. */}
                <span
                  className={cx("whitespace-nowrap text-sm", !named && "sr-only", named && active && "font-medium")}
                >
                  {item.label}
                </span>
              </Button>
            </Fragment>
          );
        })}
      </div>
      {!row && (
        <>
          <span aria-hidden="true" className="mx-2 my-1 h-px bg-border" />
          <RailLabelsToggle expanded={expanded} onToggle={toggleLabels} />
          {onToggleOrientation && (
            <RailOrientationToggle orientation="vertical" expanded={expanded} onToggle={onToggleOrientation} />
          )}
        </>
      )}
      {wideRow && onToggleOrientation && (
        <RailOrientationToggle orientation="horizontal" expanded={false} onToggle={onToggleOrientation} />
      )}
      {wideRow && (
        <div aria-hidden="true" className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden">
          <div ref={measureRef} className="flex w-max gap-1">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <Fragment key={item.value}>
                  {item.separated && <span className={cx("shrink-0", rowDividerClassName)} />}
                  {/* Every label measures at the selected weight, the widest it renders. */}
                  <Button asChild variant="ghost" className={rowTabClassName}>
                    <span data-measure-tab="">
                      <Icon className="h-5 w-5" />
                      <span className="whitespace-nowrap text-sm font-medium">{item.label}</span>
                    </span>
                  </Button>
                </Fragment>
              );
            })}
          </div>
          <Button asChild variant="ghost" className={cx(rowTabClassName, "w-max")}>
            <span ref={iconProbeRef}>
              <span className="h-5 w-5" />
            </span>
          </Button>
        </div>
      )}
    </div>
  );
}

type RowNaming = "all" | "group" | "active";

const rowTabClassName = "relative h-10 min-w-11 shrink-0 gap-2 px-3";
const rowDividerClassName = "mx-1 my-2 w-px";

/** Numbers each item's group; a divider before an item starts the next group. */
function itemGroups(items: IconRailItem<string>[]) {
  let group = 0;
  return items.map((item, index) => (index > 0 && item.separated ? ++group : group));
}
