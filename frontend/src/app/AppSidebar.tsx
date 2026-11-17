import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, PanelLeftClose, PanelLeftOpen } from "lucide-react";

import {
  navigationGroupLabel,
  navigationGroups,
  navigationLabel,
  type CollapsibleNavigationGroup,
  type NavigationItem,
  type PageID,
} from "@/app/navigation";
import { Button } from "@/components/ui/button";
import { cx } from "@/lib/classNames";

function groupExpandedKey(group: CollapsibleNavigationGroup) {
  return `kikoto:sidebar-${group}-expanded`;
}

function readGroupExpanded(group: CollapsibleNavigationGroup) {
  try {
    return localStorage.getItem(groupExpandedKey(group)) === "true";
  } catch {
    return false;
  }
}

function storeGroupExpanded(group: CollapsibleNavigationGroup, expanded: boolean) {
  try {
    localStorage.setItem(groupExpandedKey(group), String(expanded));
  } catch {
    // The choice only lasts for this page load.
  }
}

/**
 * The desktop sidebar. Listening destinations stay in view, the collections
 * apart from the pages beyond them by a divider; personal and
 * administration pages sit in groups that are collapsed until the user opens
 * them, and open on their own while one of their pages is current. About
 * closes the list after a divider.
 */
export function AppSidebar({
  items,
  page,
  collapsed,
  releaseFeedUnread,
  onOpenPage,
  onToggleCollapsed,
}: {
  /** Destinations the viewer can open, in navigation order. */
  items: readonly NavigationItem[];
  page: string;
  collapsed: boolean;
  releaseFeedUnread: number;
  onOpenPage: (id: PageID) => void;
  onToggleCollapsed: () => void;
}) {
  const { t } = useTranslation();
  const browseItems = items.filter((item) => item.group === "browse");
  const exploreItems = items.filter((item) => item.group === "explore");
  const appItems = items.filter((item) => item.group === "app");
  const groups = navigationGroups
    .map((group) => ({ group, items: items.filter((item) => item.group === group.id) }))
    .filter((entry) => entry.items.length > 0);

  const renderItem = (item: NavigationItem) => {
    const active = page === item.id;
    const label = navigationLabel(item, t);
    return (
      <Button
        key={item.id}
        className={cx(
          "relative mb-0.5 w-full font-normal text-muted-foreground",
          collapsed ? "justify-center px-0" : "justify-start gap-3",
          active && "bg-primary/10 font-medium text-foreground hover:bg-primary/15",
        )}
        variant="ghost"
        size={collapsed ? "icon" : "default"}
        title={collapsed ? label : undefined}
        aria-label={collapsed ? label : undefined}
        aria-current={active ? "page" : undefined}
        onClick={() => onOpenPage(item.id)}
      >
        {active && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-primary" />}
        <item.icon className={cx("h-4 w-4", active && "text-primary")} />
        {!collapsed && label}
        {item.id === "subscriptions" && releaseFeedUnread > 0 && (
          <span
            className={cx(
              "rounded-full bg-primary text-2xs font-medium leading-none text-primary-foreground",
              collapsed ? "absolute right-1.5 top-1.5 h-2 w-2" : "ml-auto px-1.5 py-1",
            )}
            aria-label={t("subscriptions.unreadBadge", { count: releaseFeedUnread })}
          >
            {!collapsed && (releaseFeedUnread > 99 ? "99+" : releaseFeedUnread)}
          </span>
        )}
      </Button>
    );
  };

  return (
    <aside className="theme-shell-surface sticky top-0 hidden h-screen border-r bg-card lg:flex lg:flex-col">
      <div
        className={cx(
          "flex h-[var(--header-height)] items-center border-b",
          collapsed ? "justify-center px-3" : "px-5",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[var(--control-radius)] bg-primary/10 ring-1 ring-primary/15">
            <img src="/kikoto-icon-64.png" alt="" className="h-7 w-7" />
          </span>
          {!collapsed && (
            <div className="truncate font-[family-name:var(--font-heading)] text-xl font-semibold tracking-tight">
              Kikoto
            </div>
          )}
        </div>
      </div>
      <nav className={cx("app-scroll min-h-0 flex-1 overflow-y-auto", collapsed ? "p-2" : "p-3")}>
        {browseItems.map(renderItem)}
        {browseItems.length > 0 && exploreItems.length > 0 && (
          <div aria-hidden="true" className={cx("my-2 border-t", collapsed ? "mx-2" : "mx-3")} />
        )}
        {exploreItems.map(renderItem)}
        {groups.length > 0 && <div aria-hidden="true" className={cx("my-2 border-t", collapsed ? "mx-2" : "mx-3")} />}
        {groups.map(({ group, items: groupItems }) => (
          <SidebarGroup
            key={group.id}
            group={group.id}
            label={navigationGroupLabel(group, t)}
            icon={<group.icon className="h-4 w-4" />}
            active={groupItems.some((item) => item.id === page)}
            collapsed={collapsed}
          >
            {groupItems.map(renderItem)}
          </SidebarGroup>
        ))}
        {appItems.length > 0 && <div aria-hidden="true" className={cx("my-2 border-t", collapsed ? "mx-2" : "mx-3")} />}
        {appItems.map(renderItem)}
      </nav>
      <div className={cx("border-t", collapsed ? "p-2" : "p-3")}>
        <Button
          variant="ghost"
          size={collapsed ? "icon" : "default"}
          className={cx(
            "w-full font-normal text-muted-foreground",
            collapsed ? "justify-center px-0" : "justify-start gap-3",
          )}
          aria-label={collapsed ? t("app.expandSidebar") : t("app.collapseSidebar")}
          title={collapsed ? t("app.expandSidebar") : undefined}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          {!collapsed && t("app.collapse")}
        </Button>
      </div>
    </aside>
  );
}

/**
 * One collapsible group of destinations. It starts collapsed, remembers the
 * user's choice on this device, and opens while one of its pages is current.
 */
function SidebarGroup({
  group,
  label,
  icon,
  active,
  collapsed,
  children,
}: {
  group: CollapsibleNavigationGroup;
  label: string;
  icon: ReactNode;
  /** Whether the current page belongs to the group. */
  active: boolean;
  /** Whether the sidebar is an icon rail. */
  collapsed: boolean;
  children: ReactNode;
}) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(() => readGroupExpanded(group));

  // Arriving on one of the group's pages shows where it is without changing the stored choice.
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);

  const toggle = () => {
    setExpanded((current) => {
      storeGroupExpanded(group, !current);
      return !current;
    });
  };

  // A collapsed group that holds the current page still marks it.
  const marksCurrent = active && !expanded;

  return (
    <>
      <Button
        variant="ghost"
        size={collapsed ? "icon" : "default"}
        className={cx(
          "relative mb-0.5 w-full font-normal text-muted-foreground",
          collapsed ? "justify-center px-0" : "justify-start gap-3",
          marksCurrent && "bg-primary/10 font-medium text-foreground hover:bg-primary/15",
        )}
        title={collapsed ? label : undefined}
        aria-label={collapsed ? label : undefined}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={toggle}
      >
        {marksCurrent && (
          <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-primary" />
        )}
        <span className={cx("grid place-items-center", marksCurrent && "text-primary")}>{icon}</span>
        {!collapsed && label}
        <ChevronRight
          aria-hidden="true"
          className={cx(
            "shrink-0 transition-transform motion-reduce:transition-none",
            expanded && "rotate-90",
            collapsed ? "absolute bottom-1 right-1 h-3 w-3" : "ml-auto h-4 w-4",
          )}
        />
      </Button>
      <div id={contentId} role="group" aria-label={label} hidden={!expanded}>
        {/* The hairline sets the group's pages apart from its neighbours, also in the icon rail. */}
        {expanded && (
          <div className={cx("border-l", collapsed ? "mb-1 ml-1 pl-1" : "ml-[1.0625rem] pl-2")}>{children}</div>
        )}
      </div>
    </>
  );
}
