import type { LucideIcon } from "lucide-react";
import { Fragment, useEffect, useId, useRef } from "react";

import { Button } from "@/components/ui/button";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";

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
  /** Accessible description, such as the elevated scope that a separated group shares. */
  description?: string;
};

/**
 * A page-level tab rail of icons. Wide layouts show a sticky vertical rail
 * beside the page content; the mobile navigation layout shows a row of icons
 * above it with only the active item labelled. Every item keeps its label as
 * the accessible name and tooltip. Arrow keys move and select, as in the
 * other tab strips, and a scrolled compact row keeps the active item in view.
 */
export function IconRail<T extends string>({
  label,
  items,
  selected,
  onSelect,
}: {
  label: string;
  items: IconRailItem<T>[];
  selected: T | null;
  onSelect: (value: T) => void;
}) {
  const mobile = useMobileNavigationLayout();
  const listRef = useRef<HTMLDivElement>(null);
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
  }, [selected, mobile]);

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      aria-orientation={mobile ? "horizontal" : "vertical"}
      // relative contains the visually hidden descriptions, which would otherwise widen a scrolled mobile page.
      className="app-scrollbar relative flex min-w-0 shrink-0 gap-1 overflow-x-auto lg:sticky lg:top-20 lg:flex-col lg:self-start lg:overflow-visible lg:border-r lg:pr-2"
    >
      {descriptions.map((description) => (
        <span key={description} id={descriptionId(description)} className="sr-only">
          {description}
        </span>
      ))}
      {items.map((item, index) => {
        const Icon = item.icon;
        const active = selected === item.value;
        return (
          <Fragment key={item.value}>
            {item.separated && (
              <span
                aria-hidden="true"
                className="mx-1 my-2 w-px shrink-0 bg-border lg:mx-2 lg:my-1 lg:h-px lg:w-auto"
              />
            )}
            <Button
              id={item.id}
              role="tab"
              aria-selected={active}
              aria-controls={item.controls}
              aria-describedby={item.description ? descriptionId(item.description) : undefined}
              tabIndex={active ? 0 : -1}
              title={item.label}
              variant="ghost"
              className={`relative h-10 min-w-11 shrink-0 justify-center gap-2 px-3 lg:h-11 lg:w-11 lg:px-0 ${
                active ? "bg-primary/10 text-foreground [&>svg]:text-primary" : "text-muted-foreground"
              }`}
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
                  className="absolute inset-x-2 bottom-0 h-[3px] rounded-full bg-primary lg:inset-x-auto lg:inset-y-2 lg:left-0 lg:h-auto lg:w-[3px]"
                />
              )}
              <Icon className="h-5 w-5" />
              {/* Compact layouts name only the active item; the rest keep an accessible name and tooltip. */}
              <span className={`whitespace-nowrap text-sm lg:sr-only ${active ? "" : "sr-only"}`}>{item.label}</span>
            </Button>
          </Fragment>
        );
      })}
    </div>
  );
}
