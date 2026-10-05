import { BookmarkCheck, Heart, Mic2, Pencil, Plus, UsersRound, type LucideIcon } from "lucide-react";
import { Fragment, useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { favoriteListIcon } from "@/components/favorite-list/favoriteListIcons";
import { Button } from "@/components/ui/button";
import { RailLabelsToggle, useRailLabelsShown } from "@/components/ui/rail-labels";
import type { FavoriteList } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import type { FavoriteEntity } from "./favoritesBrowseState";

const LABELS_SHOWN_KEY = "kikoto:favorites-rail-labels-shown";

export type FavoriteShelfNavigation = {
  entity: FavoriteEntity;
  activeList: "all" | number;
  markedList: FavoriteList | null;
  userLists: FavoriteList[];
  favoriteTotal: number;
  listCounts: Record<string, number>;
  /** Counts stay hidden until the works counts arrive for this account. */
  worksCountsKnown: boolean;
  circleCount: number | null;
  voiceCount: number | null;
  listsLoading: boolean;
  onWorksShelf: (list: "all" | number) => void;
  onCreatorShelf: (entity: Exclude<FavoriteEntity, "works">) => void;
  onEditLists: () => void;
  onAddList: () => void;
};

type ShelfItem = {
  key: string;
  label: string;
  title: string;
  icon: LucideIcon;
  count: number | null;
  active: boolean;
  onSelect: () => void;
};

function useShelfItems(navigation: FavoriteShelfNavigation) {
  const { t } = useTranslation();
  const worksCount = (value: number) => (navigation.worksCountsKnown ? value : null);
  const onWorks = navigation.entity === "works";
  const works: ShelfItem[] = [
    {
      key: "all",
      label: t("favorites.all"),
      title: t("favorites.shelfAllDescription"),
      icon: Heart,
      count: worksCount(navigation.favoriteTotal),
      active: onWorks && navigation.activeList === "all",
      onSelect: () => navigation.onWorksShelf("all"),
    },
  ];
  if (navigation.markedList) {
    const markedID = navigation.markedList.id;
    works.push({
      key: `list-${markedID}`,
      label: t("favorites.marked"),
      title: t("favorites.quickMarkWorks"),
      icon: BookmarkCheck,
      count: worksCount(navigation.listCounts[String(markedID)] ?? 0),
      active: onWorks && navigation.activeList === markedID,
      onSelect: () => navigation.onWorksShelf(markedID),
    });
  }
  const lists: ShelfItem[] = navigation.userLists.map((list) => ({
    key: `list-${list.id}`,
    label: list.name,
    title: list.description || list.name,
    icon: favoriteListIcon(list),
    count: worksCount(navigation.listCounts[String(list.id)] ?? 0),
    active: onWorks && navigation.activeList === list.id,
    onSelect: () => navigation.onWorksShelf(list.id),
  }));
  const creators: ShelfItem[] = [
    {
      key: "circles",
      label: t("creatorBrowse.circles"),
      title: t("favorites.circleShelfDescription"),
      icon: UsersRound,
      count: navigation.circleCount,
      active: navigation.entity === "circles",
      onSelect: () => navigation.onCreatorShelf("circles"),
    },
    {
      key: "voices",
      label: t("creatorBrowse.voiceActors"),
      title: t("favorites.voiceShelfDescription"),
      icon: Mic2,
      count: navigation.voiceCount,
      active: navigation.entity === "voices",
      onSelect: () => navigation.onCreatorShelf("voices"),
    },
  ];
  return { works, lists, creators };
}

/**
 * The wide-layout shelf rail: works shelves, the user's lists, then followed
 * creators. Like the Workflows navigator it can collapse to icons, which is
 * where a list's chosen icon tells the lists apart; every item keeps its name
 * as the accessible name and tooltip.
 */
export function FavoriteShelfSidebar({ navigation }: { navigation: FavoriteShelfNavigation }) {
  const { t } = useTranslation();
  const [labelsShown, toggleLabels] = useRailLabelsShown(LABELS_SHOWN_KEY, true);
  const collapsed = !labelsShown;
  const { works, lists, creators } = useShelfItems(navigation);
  const sections: { key: string; heading: string; content: ReactNode; actions?: ReactNode }[] = [
    {
      key: "works",
      heading: t("detailActions.works"),
      content: works.map((item) => <ShelfSidebarItem key={item.key} item={item} collapsed={collapsed} />),
    },
    {
      key: "lists",
      heading: t("favorites.myLists"),
      actions: collapsed ? undefined : (
        <>
          <ShelfSectionAction
            label={t("favorites.addList")}
            disabled={navigation.listsLoading}
            onClick={navigation.onAddList}
          >
            <Plus className="h-3.5 w-3.5" />
          </ShelfSectionAction>
          <ShelfSectionAction
            label={t("favorites.editLists")}
            disabled={navigation.listsLoading}
            onClick={navigation.onEditLists}
          >
            <Pencil className="h-3.5 w-3.5" />
          </ShelfSectionAction>
        </>
      ),
      content: navigation.listsLoading ? (
        <ShelfSkeletonRows collapsed={collapsed} />
      ) : (
        <>
          {lists.map((item) => (
            <ShelfSidebarItem key={item.key} item={item} collapsed={collapsed} />
          ))}
          {collapsed ? (
            <>
              <ShelfRailAction label={t("favorites.addList")} dashed onClick={navigation.onAddList}>
                <Plus className="h-4 w-4" />
              </ShelfRailAction>
              <ShelfRailAction label={t("favorites.editLists")} onClick={navigation.onEditLists}>
                <Pencil className="h-4 w-4" />
              </ShelfRailAction>
            </>
          ) : (
            lists.length === 0 && (
              <button
                type="button"
                className="flex min-h-10 w-full items-center gap-3 rounded-md border border-dashed px-2 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                onClick={navigation.onAddList}
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center">
                  <Plus className="h-4 w-4" />
                </span>
                {t("favorites.createFirstList")}
              </button>
            )
          )}
        </>
      ),
    },
    {
      key: "creators",
      heading: t("favorites.creators"),
      content: creators.map((item) => <ShelfSidebarItem key={item.key} item={item} collapsed={collapsed} />),
    },
  ];

  return (
    // A sticky rail taller than the space above the page's bottom padding and player
    // clearance would be pushed up at the end of the page, so it scrolls its list instead.
    <div
      className={cn(
        "sticky top-20 flex max-h-[calc(100dvh-5rem-var(--page-padding-y)-var(--app-content-bottom-clearance))] shrink-0 flex-col gap-1 self-start border-r",
        collapsed ? "pr-2" : "w-56 pr-3 xl:w-60",
      )}
    >
      <nav aria-label={t("favorites.shelves")} className="app-scrollbar min-h-0 overflow-y-auto text-sm">
        <div className={cn("grid", collapsed ? "gap-1" : "gap-4")}>
          {sections.map((section, index) => (
            <Fragment key={section.key}>
              {collapsed && index > 0 && <span aria-hidden="true" className="mx-2 my-1 h-px bg-border" />}
              <ShelfSection heading={section.heading} actions={section.actions} collapsed={collapsed}>
                {section.content}
              </ShelfSection>
            </Fragment>
          ))}
        </div>
      </nav>
      <span aria-hidden="true" className="mx-2 my-1 h-px shrink-0 bg-border" />
      <RailLabelsToggle expanded={!collapsed} onToggle={toggleLabels} />
    </div>
  );
}

function ShelfSection({
  heading,
  actions,
  collapsed,
  children,
}: {
  heading: string;
  actions?: ReactNode;
  collapsed: boolean;
  children: ReactNode;
}) {
  const headingID = useId();
  return (
    <section aria-labelledby={headingID} className="min-w-0">
      {/* An icon rail separates sections with dividers; the heading still names each one. */}
      <div className={cn("flex h-7 items-center justify-between gap-2 pl-2", collapsed && "sr-only")}>
        <h3 id={headingID} className="truncate text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {heading}
        </h3>
        {actions && <div className="flex shrink-0 items-center">{actions}</div>}
      </div>
      <div className="grid gap-0.5">{children}</div>
    </section>
  );
}

function ShelfSectionAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function ShelfRailAction({
  label,
  dashed = false,
  onClick,
  children,
}: {
  label: string;
  dashed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="group/action grid h-11 w-11 place-items-center rounded-md transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted/70"
      onClick={onClick}
    >
      <span
        className={cn(
          "grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors group-hover/action:text-foreground",
          dashed && "border border-dashed",
        )}
      >
        {children}
      </span>
    </button>
  );
}

function ShelfSidebarItem({ item, collapsed }: { item: ShelfItem; collapsed: boolean }) {
  const tooltip = collapsed && item.count !== null ? `${item.label} · ${item.count}` : item.title;
  return (
    <button
      type="button"
      aria-pressed={item.active}
      title={tooltip}
      className={cn(
        "group/item relative flex min-w-0 items-center text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        collapsed ? "h-11 w-11 justify-center rounded-md" : "min-h-10 w-full gap-3 rounded-md px-2 py-1",
        item.active ? "bg-primary/10" : "hover:bg-muted/50 active:bg-muted/70",
      )}
      onClick={item.onSelect}
    >
      {item.active && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-primary" />}
      <span
        className={cn(
          "grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors",
          item.active
            ? "bg-primary/15 text-primary"
            : "bg-muted text-muted-foreground group-hover/item:text-foreground",
        )}
      >
        <item.icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          collapsed && "sr-only",
          item.active ? "font-medium" : "text-foreground/85",
        )}
      >
        {item.label}
      </span>
      {item.count !== null && (
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            collapsed && "sr-only",
            item.active ? "text-primary" : "text-muted-foreground",
          )}
        >
          {item.count}
        </span>
      )}
    </button>
  );
}

function ShelfSkeletonRows({ collapsed }: { collapsed: boolean }) {
  return (
    <>
      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className={cn("flex items-center", collapsed ? "h-11 w-11 justify-center" : "min-h-10 gap-3 px-2")}
        >
          <div className="h-8 w-8 shrink-0 animate-pulse rounded-md bg-muted" />
          {!collapsed && <div className="h-3 flex-1 animate-pulse rounded bg-muted" />}
        </div>
      ))}
    </>
  );
}

/** The compact shelf row: one scrollable strip of every shelf, ending with list editing. */
export function FavoriteShelfStrip({ navigation }: { navigation: FavoriteShelfNavigation }) {
  const { t } = useTranslation();
  const { works, lists, creators } = useShelfItems(navigation);
  const stripRef = useRef<HTMLDivElement>(null);
  const activeKey = [...works, ...lists, ...creators].find((item) => item.active)?.key ?? "";

  // Only the strip scrolls, e.g. after a deep link to a later list; the page keeps its position.
  useEffect(() => {
    const strip = stripRef.current;
    const chip = strip?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!strip || !chip || strip.scrollWidth <= strip.clientWidth) return;
    const row = strip.getBoundingClientRect();
    const box = chip.getBoundingClientRect();
    // A sub-pixel overlap is not worth moving the row the user just tapped in.
    if (box.left < row.left - 1) strip.scrollLeft -= Math.ceil(row.left - box.left);
    else if (box.right > row.right + 1) strip.scrollLeft += Math.ceil(box.right - row.right);
  }, [activeKey, navigation.listsLoading]);

  return (
    <div className="flex items-center gap-2">
      <div
        ref={stripRef}
        className="app-scrollbar -mx-1 min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain px-1"
        role="region"
        aria-label={t("favorites.listTabs")}
      >
        <div className="flex w-max min-w-full items-center gap-1.5 py-1" role="group" aria-label={t("favorites.lists")}>
          {navigation.listsLoading ? (
            Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="h-9 w-24 shrink-0 animate-pulse rounded-full bg-muted" />
            ))
          ) : (
            <>
              {[...works, ...lists].map((item) => (
                <ShelfChip key={item.key} item={item} />
              ))}
              <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />
              {creators.map((item) => (
                <ShelfChip key={item.key} item={item} />
              ))}
            </>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="group -m-1 h-11 w-11 shrink-0 hover:bg-transparent"
        disabled={navigation.listsLoading}
        onClick={navigation.onEditLists}
        aria-label={t("favorites.editLists")}
        title={t("favorites.editLists")}
      >
        <span className="grid h-9 w-9 place-items-center rounded-full border border-input bg-card transition-colors group-hover:bg-muted">
          <Pencil className="h-4 w-4" />
        </span>
      </Button>
    </div>
  );
}

function ShelfChip({ item }: { item: ShelfItem }) {
  return (
    <button
      type="button"
      className="group -my-1 inline-flex h-11 shrink-0 items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100"
      aria-pressed={item.active}
      title={item.title}
      onClick={item.onSelect}
    >
      <span
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors",
          item.active
            ? "border-primary bg-primary text-primary-foreground"
            : "bg-card text-foreground/80 group-hover:bg-muted group-hover:text-foreground",
        )}
      >
        <item.icon className="h-4 w-4 shrink-0" />
        <span className="max-w-40 truncate">{item.label}</span>
        {item.count !== null && <span className="text-xs tabular-nums opacity-75">{item.count}</span>}
      </span>
    </button>
  );
}
