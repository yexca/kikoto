import type { LucideIcon } from "lucide-react";
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "@/lib/tailwindClassNames";

/**
 * Secondary navigation takes one of two forms across the app.
 *
 * - `SubNavTabs`: tabs along the top of the page for its views.
 * - `SubNavColumn`: a list beside the page for an open-ended set of
 *   destinations with their own item content (Favorites shelves, the workflow
 *   list), built from `subNavItemClassName` so it looks and behaves the same
 *   everywhere.
 *
 * Both name every destination, keep it as the accessible name, and move with
 * the arrow keys. They have no display options: the form never changes with a
 * stored preference. A page may let the user hide its whole column (Favorites).
 */
export type SubNavItem<T extends string> = {
  value: T;
  label: string;
  /** Tab element id, so the controlled panel can reference it. */
  id: string;
  /** Id of the panel this tab controls. */
  controls: string;
  icon?: LucideIcon;
  /** Draws a divider before this item to set a different kind of view apart. */
  separated?: boolean;
  /** Accessible description, read after the item's name, which stays the label alone. */
  description?: string;
  /** Visual detail beside the label, such as a count. Hidden from the accessible name. */
  suffix?: ReactNode;
};

const hairlineClassName = "pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border";

/** A top tab or, in a folded row, an icon that names itself only while selected. */
function tabClassName(active: boolean) {
  return cn(
    "touch-target relative inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-t-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    active
      ? "font-medium text-foreground [&>svg]:text-primary"
      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground active:bg-muted/70",
  );
}

/** Moves and selects with the arrow keys, Home, and End, as in the app's other tab strips. */
function selectWithKeys<T extends string>(
  event: KeyboardEvent<HTMLElement>,
  index: number,
  items: SubNavItem<T>[],
  list: HTMLElement | null,
  onSelect: (value: T) => void,
) {
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
  list?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus({ preventScroll: true });
}

/**
 * Keeps the selected tab in view when the row scrolls; only the row moves,
 * never the page. Folding or unfolding the row moves the tab, so it checks again.
 */
function useSelectedTabInView(listRef: RefObject<HTMLDivElement | null>, selected: string | null, folded: boolean) {
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!list || !tab || list.scrollWidth <= list.clientWidth) return;
    const row = list.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    // Round away from the edge so a fractional layout still reveals the whole tab.
    if (box.left < row.left) list.scrollLeft -= Math.ceil(row.left - box.left);
    else if (box.right > row.right) list.scrollLeft += Math.ceil(box.right - row.right);
  }, [folded, listRef, selected]);
}

// The selected tab's label is heavier than the measured one, so leave it room.
const FOLD_MARGIN = 8;

/**
 * Whether a row of icon tabs is too narrow to name every tab. The named row is
 * measured once for each set of labels, before the first paint, and compared
 * with the row's width as that changes.
 */
function useFoldedTabs(enabled: boolean, listRef: RefObject<HTMLDivElement | null>, labels: string) {
  const [named, setNamed] = useState<{ labels: string; width: number } | null>(null);
  const [available, setAvailable] = useState(Number.POSITIVE_INFINITY);
  const namedWidth = named?.labels === labels ? named.width : null;
  const measured = namedWidth !== null;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!enabled || !list) return;
    if (!measured) {
      // This render names every tab, so the span of its tabs is the width the named row needs.
      const tabs = list.querySelectorAll<HTMLElement>('[role="tab"]');
      const first = tabs[0]?.getBoundingClientRect();
      const last = tabs[tabs.length - 1]?.getBoundingClientRect();
      setNamed({ labels, width: first && last ? last.right - first.left + FOLD_MARGIN : 0 });
    }
    setAvailable(list.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setAvailable(list.clientWidth));
    observer.observe(list);
    return () => observer.disconnect();
  }, [enabled, labels, listRef, measured]);

  return enabled && namedWidth !== null && namedWidth > available;
}

function useDescriptions<T extends string>(items: SubNavItem<T>[]) {
  const base = useId();
  const descriptions = [...new Set(items.flatMap((item) => (item.description ? [item.description] : [])))];
  return {
    descriptions,
    idOf: (description: string) => `${base}-${descriptions.indexOf(description)}`,
  };
}

/**
 * Tabs along the top of a page, with a hairline under the row and a line under
 * the selected tab. Tabs that all carry an icon show it beside their name; a
 * row too narrow for every name folds to icons that name only the selected
 * tab. A row that still does not fit scrolls sideways and keeps the selected
 * tab in view. `trailing` puts the page's own controls at the end of the same
 * row.
 */
export function SubNavTabs<T extends string>({
  label,
  items,
  selected,
  onSelect,
  trailing,
  className,
}: {
  label: string;
  items: SubNavItem<T>[];
  selected: T | null;
  onSelect: (value: T) => void;
  trailing?: ReactNode;
  className?: string;
}) {
  const foldable = items.length > 1 && items.every((item) => item.icon);
  const listRef = useRef<HTMLDivElement>(null);
  const folded = useFoldedTabs(foldable, listRef, items.map((item) => item.label).join("\n"));
  useSelectedTabInView(listRef, selected, folded);
  const { descriptions, idOf } = useDescriptions(items);
  return (
    // The page's own controls share the row from the sm breakpoint; a phone gives the tabs the whole width and
    // puts the controls on their own line below the hairline.
    <div
      className={cn("relative flex min-w-0 flex-col sm:flex-row sm:items-center sm:gap-3", className)}
      data-sub-nav="tabs"
    >
      <span aria-hidden="true" className={cn(hairlineClassName, "max-sm:hidden")} />
      <div className="relative min-w-0 sm:flex-1">
        <span aria-hidden="true" className={cn(hairlineClassName, "sm:hidden")} />
        <div
          ref={listRef}
          role="tablist"
          aria-label={label}
          aria-orientation="horizontal"
          // The row scrolls only sideways: a tab's touch target reaches past its box and would otherwise scroll it vertically too.
          // relative contains the visually hidden descriptions, which would otherwise widen a scrolled mobile page.
          className="app-scrollbar relative flex min-w-0 gap-1 overflow-x-auto overflow-y-hidden"
        >
          {descriptions.map((description) => (
            <span key={description} id={idOf(description)} className="sr-only">
              {description}
            </span>
          ))}
          {items.map((item, index) => {
            const active = selected === item.value;
            const Icon = item.icon;
            const named = !folded || active;
            return (
              <Fragment key={item.value}>
                {item.separated && <span aria-hidden="true" className="mx-1 my-3 w-px shrink-0 bg-border" />}
                <button
                  type="button"
                  id={item.id}
                  role="tab"
                  aria-selected={active}
                  aria-controls={item.controls}
                  aria-describedby={item.description ? idOf(item.description) : undefined}
                  tabIndex={active ? 0 : -1}
                  title={named ? undefined : item.label}
                  className={tabClassName(active)}
                  onClick={() => onSelect(item.value)}
                  onKeyDown={(event) => selectWithKeys(event, index, items, listRef.current, onSelect)}
                >
                  {Icon && <Icon className="h-5 w-5 shrink-0" />}
                  <span className={cn(!named && "sr-only")}>{item.label}</span>
                  {item.suffix}
                  {active && (
                    <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary" />
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
      </div>
      {trailing && (
        <div className="relative flex shrink-0 items-center gap-2 max-sm:justify-end max-sm:pt-3">{trailing}</div>
      )}
    </div>
  );
}

/**
 * The shelf beside a page that holds a list of destinations: sticky on wide
 * screens, with a hairline between it and the page.
 */
export function SubNavColumn({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  return (
    <div
      data-sub-nav="list"
      {...rest}
      // A sticky column taller than the space above the page's bottom padding and player clearance would be
      // pushed up at the end of the page, so its list scrolls instead.
      className={cn(
        "sticky top-20 flex max-h-[calc(100dvh-5rem-var(--page-padding-y)-var(--app-content-bottom-clearance))] w-56 shrink-0 flex-col gap-1 self-start border-r pr-3 xl:w-60",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** One destination in a `SubNavColumn`: an icon, its name, and optional trailing detail. */
export function subNavItemClassName(active: boolean, className?: string) {
  return cn(
    "touch-target group/item relative flex min-h-11 w-full min-w-0 items-center gap-3 rounded-md px-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    active
      ? "bg-primary/10 font-medium text-foreground [&_[data-sub-nav-icon]]:text-primary"
      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground active:bg-muted/70",
    className,
  );
}

/** The bar at the leading edge of the selected destination in a column. */
export function SubNavActiveMark() {
  return <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-primary" />;
}

/** A small group heading in a column. */
export function SubNavHeading({ id, children, actions }: { id?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between gap-2 pl-3">
      <h3 id={id} className="truncate text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {children}
      </h3>
      {actions && <div className="flex shrink-0 items-center">{actions}</div>}
    </div>
  );
}
