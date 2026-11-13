import {
  Activity,
  ChartColumn,
  CircleUserRound,
  Clapperboard,
  Compass,
  Database,
  Heart,
  Info,
  Languages,
  Library,
  MicVocal,
  ServerCog,
  Settings,
  Tags,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { SYSTEM_SETTINGS_PATH } from "../pages/settingsPaths";

type NavItem = {
  id: string;
  label: string;
  labelKey: string;
  path: string;
  icon: LucideIcon;
  audience: "public" | "authenticated" | "admin";
  permission?: string;
  /**
   * Where the shell offers the destination: `browse` pages are the sidebar's
   * listening destinations, and `personal` and `manage` pages sit in its
   * collapsible groups. A page without a group is reached from the account
   * panel on every layout.
   */
  group: NavigationGroup | undefined;
};

export type NavigationGroup = "browse" | "personal" | "manage";
export type CollapsibleNavigationGroup = Exclude<NavigationGroup, "browse">;

/**
 * The sidebar's collapsible groups, in the order it shows them. A layout
 * without the sidebar offers the same pages from the account panel: `inline`
 * groups in its list, `nested` ones behind one entry.
 */
export const navigationGroups: ReadonlyArray<{
  id: CollapsibleNavigationGroup;
  label: string;
  labelKey: string;
  icon: LucideIcon;
  accountPanel: "inline" | "nested";
}> = [
  { id: "personal", label: "Personal", labelKey: "nav.personal", icon: CircleUserRound, accountPanel: "inline" },
  { id: "manage", label: "Manage", labelKey: "nav.manage", icon: Wrench, accountPanel: "nested" },
];

export const INSIGHTS_PATH = "/insights";
export const TAGS_PATH = "/tags";

export const navItems = [
  {
    id: "library",
    label: "Library",
    labelKey: "nav.library",
    path: "/",
    icon: Library,
    audience: "public",
    permission: undefined,
    group: "browse",
  },
  {
    id: "favorites",
    label: "Favorites",
    labelKey: "nav.favorites",
    path: "/favorites",
    icon: Heart,
    audience: "authenticated",
    permission: undefined,
    group: "browse",
  },
  {
    id: "records",
    label: "Record",
    labelKey: "nav.record",
    path: "/records",
    icon: Clapperboard,
    audience: "authenticated",
    permission: "library:read",
    group: "browse",
  },
  {
    id: "circles",
    label: "Circles",
    labelKey: "nav.circles",
    path: "/circles",
    icon: Users,
    audience: "public",
    permission: undefined,
    group: "browse",
  },
  {
    id: "voice-actors",
    label: "Voice Actors",
    labelKey: "nav.voiceActors",
    path: "/voices",
    icon: MicVocal,
    audience: "public",
    permission: undefined,
    group: "browse",
  },
  {
    id: "subscriptions",
    label: "Discover",
    labelKey: "nav.subscriptions",
    path: "/discover",
    icon: Compass,
    audience: "authenticated",
    permission: "library:read",
    group: "browse",
  },
  {
    id: "insights",
    label: "Insights",
    labelKey: "nav.insights",
    path: INSIGHTS_PATH,
    icon: ChartColumn,
    audience: "authenticated",
    permission: "library:read",
    group: "personal",
  },
  {
    id: "tags",
    label: "Tags",
    labelKey: "nav.tags",
    path: TAGS_PATH,
    icon: Tags,
    audience: "authenticated",
    permission: "library:read",
    group: "personal",
  },
  {
    id: "settings",
    label: "Settings",
    labelKey: "nav.settings",
    path: "/settings",
    icon: Settings,
    audience: "authenticated",
    permission: undefined,
    group: "personal",
  },
  {
    id: "workflows",
    label: "Workflows",
    labelKey: "nav.workflows",
    path: "/workflows",
    icon: Workflow,
    audience: "admin",
    permission: "workflows:run",
    group: "manage",
  },
  {
    id: "activity",
    label: "Activity",
    labelKey: "nav.activity",
    path: "/activity",
    icon: Activity,
    audience: "admin",
    permission: "workflows:run",
    group: "manage",
  },
  {
    id: "metadata",
    label: "Metadata",
    labelKey: "nav.workManagement",
    path: "/metadata",
    icon: Database,
    audience: "admin",
    permission: "metadata:sync",
    group: "manage",
  },
  {
    id: "translation",
    label: "Translation",
    labelKey: "nav.translation",
    path: "/translation",
    icon: Languages,
    audience: "admin",
    permission: "library:write",
    group: "manage",
  },
  {
    // Instance settings follow the viewer's role, not one permission.
    id: "system",
    label: "System",
    labelKey: "nav.system",
    path: SYSTEM_SETTINGS_PATH,
    icon: ServerCog,
    audience: "admin",
    permission: undefined,
    group: "manage",
  },
  {
    id: "about",
    label: "About",
    labelKey: "nav.about",
    path: "/about",
    icon: Info,
    audience: "public",
    permission: undefined,
    group: undefined,
  },
] as const satisfies readonly NavItem[];

export type PageID = (typeof navItems)[number]["id"];

/**
 * The destinations the account panel repeats as shortcut tiles where the
 * sidebar is shown, in the order the tiles appear. The sidebar keeps them in
 * their own groups.
 */
export const accountShortcutIds = ["subscriptions", "insights", "tags"] as const satisfies readonly PageID[];
export type NavigationItem = (typeof navItems)[number];
export type AuthViewState = "anonymous" | "authenticated";

export function navigationLabel(item: NavigationItem, translate: (key: string) => string) {
  const translated = translate(item.labelKey);
  return !translated || translated === item.labelKey ? item.label : translated;
}

export function navigationGroupLabel(group: (typeof navigationGroups)[number], translate: (key: string) => string) {
  const translated = translate(group.labelKey);
  return !translated || translated === group.labelKey ? group.label : translated;
}

/**
 * `administrator` says whether the viewer may open instance settings: an
 * administrator role, or Demo, which sees them read-only.
 */
export function visibleNavigationItems({
  state,
  hasPermission,
  administrator = false,
}: {
  state: AuthViewState;
  hasPermission: (permission: string) => boolean;
  administrator?: boolean;
}) {
  return navItems.filter((item) => canAccessNavigationItem(item, state, hasPermission, administrator));
}

export function canAccessPage(
  page: PageID,
  state: AuthViewState,
  hasPermission: (permission: string) => boolean,
  administrator = false,
) {
  const item = navItems.find((navItem) => navItem.id === page);
  return item ? canAccessNavigationItem(item, state, hasPermission, administrator) : true;
}

function canAccessNavigationItem(
  item: NavigationItem,
  state: AuthViewState,
  hasPermission: (permission: string) => boolean,
  administrator: boolean,
) {
  if (item.audience === "authenticated" && state === "anonymous") return false;
  if (item.audience === "admin" && state === "anonymous") return false;
  if (item.id === "system") return administrator;
  if (item.id === "metadata")
    return hasPermission("library:write") || hasPermission("sources:write") || hasPermission("metadata:sync");
  if (item.permission && !hasPermission(item.permission)) return false;
  return true;
}
