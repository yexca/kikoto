import { Activity, Heart, Info, Library, MicVocal, Settings, ShieldCheck, Users, Workflow } from "lucide-react";
import type { LucideIcon } from "lucide-react";

type NavItem = {
  id: string;
  label: string;
  labelKey: string;
  description: string;
  descriptionKey: string;
  path: string;
  icon: LucideIcon;
  audience: "public" | "authenticated" | "admin";
  permission?: string;
};

export const navItems = [
  {
    id: "library",
    label: "Library",
    labelKey: "nav.library",
    description: "Browse, filter, and play works from every configured source",
    descriptionKey: "nav.libraryDescription",
    path: "/",
    icon: Library,
    audience: "public",
    permission: undefined,
  },
  {
    id: "favorites",
    label: "Favorites",
    labelKey: "nav.favorites",
    description: "Browse your favorite works, circles, voices, and lists",
    descriptionKey: "nav.favoritesDescription",
    path: "/favorites",
    icon: Heart,
    audience: "authenticated",
    permission: undefined,
  },
  {
    id: "circles",
    label: "Circles",
    labelKey: "nav.circles",
    description: "Browse circles and their known catalogs",
    descriptionKey: "nav.circlesDescription",
    path: "/circles",
    icon: Users,
    audience: "public",
    permission: undefined,
  },
  {
    id: "voice-actors",
    label: "Voice Actors",
    labelKey: "nav.voiceActors",
    description: "Browse voices and their credited works",
    descriptionKey: "nav.voiceActorsDescription",
    path: "/voices",
    icon: MicVocal,
    audience: "public",
    permission: undefined,
  },
  {
    id: "workflows",
    label: "Workflows",
    labelKey: "nav.workflows",
    description: "Run built-in operations and manage custom automations",
    descriptionKey: "nav.workflowsDescription",
    path: "/workflows",
    icon: Workflow,
    audience: "admin",
    permission: "workflows:run",
  },
  {
    id: "activity",
    label: "Activity",
    labelKey: "nav.activity",
    description: "Inspect workflow runs, failures, and review items",
    descriptionKey: "nav.activityDescription",
    path: "/activity",
    icon: Activity,
    audience: "admin",
    permission: "workflows:run",
  },
  {
    id: "settings",
    label: "Settings",
    labelKey: "nav.settings",
    description: "Manage your account and appearance preferences",
    descriptionKey: "nav.settingsDescription",
    path: "/settings",
    icon: Settings,
    audience: "authenticated",
    permission: undefined,
  },
  {
    id: "maintenance",
    label: "Maintenance",
    labelKey: "nav.maintenance",
    description: "Configure sources, routing, caching, metadata, and users",
    descriptionKey: "nav.maintenanceDescription",
    path: "/maintenance",
    icon: ShieldCheck,
    audience: "admin",
    permission: "sources:write",
  },
  {
    id: "about",
    label: "About",
    labelKey: "nav.about",
    description: "Version, licensing, and application information",
    descriptionKey: "nav.aboutDescription",
    path: "/about",
    icon: Info,
    audience: "public",
    permission: undefined,
  },
] as const satisfies readonly NavItem[];

export type PageID = (typeof navItems)[number]["id"];
export type NavigationItem = (typeof navItems)[number];
export type AuthViewState = "anonymous" | "authenticated";

export function navigationLabel(item: NavigationItem, translate: (key: string) => string) {
  const translated = translate(item.labelKey);
  return !translated || translated === item.labelKey ? item.label : translated;
}

export function navigationDescription(item: NavigationItem, translate: (key: string) => string) {
  const translated = translate(item.descriptionKey);
  return !translated || translated === item.descriptionKey ? item.description : translated;
}

export function visibleNavigationItems({
  state,
  hasPermission,
}: {
  state: AuthViewState;
  hasPermission: (permission: string) => boolean;
}) {
  return navItems.filter((item) => canAccessNavigationItem(item, state, hasPermission));
}

export function canAccessPage(page: PageID, state: AuthViewState, hasPermission: (permission: string) => boolean) {
  const item = navItems.find((navItem) => navItem.id === page);
  return item ? canAccessNavigationItem(item, state, hasPermission) : true;
}

function canAccessNavigationItem(
  item: NavigationItem,
  state: AuthViewState,
  hasPermission: (permission: string) => boolean,
) {
  if (item.audience === "authenticated" && state === "anonymous") return false;
  if (item.audience === "admin" && state === "anonymous") return false;
  if (item.permission && !hasPermission(item.permission)) return false;
  return true;
}
