import {
  Download,
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
  icon: LucideIcon;
  permission?: string;
};

export const navItems = [
  { id: "library", label: "Library", icon: Library, permission: undefined },
  { id: "now-playing", label: "Now Playing", icon: Play, permission: undefined },
  { id: "favorites", label: "Favorites", icon: Heart, permission: undefined },
  { id: "circles", label: "Circles", icon: Users, permission: undefined },
  { id: "tags", label: "Tags", icon: Tags, permission: undefined },
  { id: "workflows", label: "Workflows", icon: Workflow, permission: "workflows:run" },
  { id: "downloads", label: "Downloads", icon: Download, permission: "downloads:manage" },
  { id: "users", label: "Users", icon: ShieldCheck, permission: "users:manage" },
  { id: "settings", label: "Settings", icon: Settings, permission: undefined },
] as const satisfies readonly NavItem[];

export type PageID = (typeof navItems)[number]["id"];
