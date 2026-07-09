import {
  Activity,
  Heart,
  Info,
  Library,
  MicVocal,
  Settings,
  ShieldCheck,
  Users,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type NavItem = {
  id: string;
  label: string;
  path: string;
  icon: LucideIcon;
  audience: "public" | "authenticated" | "admin";
  permission?: string;
};

export const navItems = [
  { id: "library", label: "Library", path: "/", icon: Library, audience: "public", permission: undefined },
  { id: "favorites", label: "Favorites", path: "/favorites", icon: Heart, audience: "authenticated", permission: undefined },
  { id: "circles", label: "Circles", path: "/circles", icon: Users, audience: "public", permission: undefined },
  { id: "voice-actors", label: "Voice Actors", path: "/voices", icon: MicVocal, audience: "public", permission: undefined },
  { id: "workflows", label: "Workflows", path: "/workflows", icon: Workflow, audience: "admin", permission: "workflows:run" },
  { id: "activity", label: "Activity", path: "/activity", icon: Activity, audience: "admin", permission: "workflows:run" },
  { id: "users", label: "Users", path: "/users", icon: ShieldCheck, audience: "admin", permission: "users:manage" },
  { id: "settings", label: "Settings", path: "/settings", icon: Settings, audience: "authenticated", permission: undefined },
  { id: "about", label: "About", path: "/about", icon: Info, audience: "public", permission: undefined },
] as const satisfies readonly NavItem[];

export type PageID = (typeof navItems)[number]["id"];
export type NavigationItem = (typeof navItems)[number];
export type AuthViewState = "anonymous" | "authenticated";

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

function canAccessNavigationItem(item: NavigationItem, state: AuthViewState, hasPermission: (permission: string) => boolean) {
  if (item.audience === "authenticated" && state === "anonymous") return false;
  if (item.audience === "admin" && state === "anonymous") return false;
  if (item.permission && !hasPermission(item.permission)) return false;
  return true;
}
