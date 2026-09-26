import {
  ArchiveRestore,
  Database,
  Heart,
  History,
  Info,
  Library,
  MicVocal,
  Settings,
  Tags,
  Users,
  Workflow,
} from "lucide-react";
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
  /** Visual grouping in the sidebar: listening, personal data, administration, and app-level pages. */
  group: "browse" | "personal" | "manage" | "app";
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
    group: "browse",
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
    group: "browse",
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
    group: "browse",
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
    group: "browse",
  },
  {
    id: "history",
    label: "History",
    labelKey: "nav.history",
    description: "Review your listening time, statistics, and recently played works",
    descriptionKey: "nav.historyDescription",
    path: "/history",
    icon: History,
    audience: "authenticated",
    permission: "library:read",
    group: "personal",
  },
  {
    id: "tags",
    label: "Tags",
    labelKey: "nav.tags",
    description: "Rename, merge, and delete your personal tags",
    descriptionKey: "nav.tagsDescription",
    path: "/tags",
    icon: Tags,
    audience: "authenticated",
    permission: "library:read",
    group: "personal",
  },
  {
    id: "user-data",
    label: "Your data",
    labelKey: "nav.userData",
    description: "Export or import your marks, progress, lists, and tags",
    descriptionKey: "nav.userDataDescription",
    path: "/user-data",
    icon: ArchiveRestore,
    audience: "authenticated",
    permission: "library:read",
    group: "personal",
  },
  {
    id: "workflows",
    label: "Workflows",
    labelKey: "nav.workflows",
    description: "Run built-in operations and preset workflows",
    descriptionKey: "nav.workflowsDescription",
    path: "/workflows",
    icon: Workflow,
    audience: "admin",
    permission: "workflows:run",
    group: "manage",
  },
  {
    id: "metadata",
    label: "Metadata",
    labelKey: "nav.workManagement",
    description: "Browse metadata, resolve work issues, and configure metadata settings",
    descriptionKey: "nav.workManagementDescription",
    path: "/metadata",
    icon: Database,
    audience: "admin",
    permission: "metadata:sync",
    group: "manage",
  },
  {
    id: "settings",
    label: "Settings",
    labelKey: "nav.settings",
    description: "Manage your account, playback, and recommendation preferences",
    descriptionKey: "nav.settingsDescription",
    path: "/settings",
    icon: Settings,
    audience: "authenticated",
    permission: undefined,
    group: "app",
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
    group: "app",
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
  if (item.id === "metadata") return hasPermission("sources:write") || hasPermission("metadata:sync");
  if (item.permission && !hasPermission(item.permission)) return false;
  return true;
}
