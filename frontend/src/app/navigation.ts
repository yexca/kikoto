import {
  Activity,
  Heart,
  Library,
  Play,
  Settings,
  Tags,
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
  permission?: string;
};

export const navItems = [
  { id: "library", label: "Library", path: "/", icon: Library, permission: undefined },
  { id: "now-playing", label: "Now Playing", path: "/now-playing", icon: Play, permission: undefined },
  { id: "favorites", label: "Favorites", path: "/favorites", icon: Heart, permission: undefined },
  { id: "circles", label: "Circles", path: "/circles", icon: Users, permission: undefined },
  { id: "tags", label: "Tags", path: "/tags", icon: Tags, permission: undefined },
  { id: "workflows", label: "Workflows", path: "/workflows", icon: Workflow, permission: "workflows:run" },
  { id: "runs", label: "Runs", path: "/runs", icon: Activity, permission: "workflows:run" },
  { id: "users", label: "Users", path: "/users", icon: ShieldCheck, permission: "users:manage" },
  { id: "settings", label: "Settings", path: "/settings", icon: Settings, permission: undefined },
] as const satisfies readonly NavItem[];

export type PageID = (typeof navItems)[number]["id"];
