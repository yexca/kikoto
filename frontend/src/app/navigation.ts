import {
  Activity,
  Heart,
  Library,
  Settings,
  ShieldCheck,
  MicVocal,
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
  { id: "favorites", label: "Favorites", path: "/favorites", icon: Heart, permission: undefined },
  { id: "circles", label: "Circles", path: "/circles", icon: Users, permission: undefined },
  { id: "voice-actors", label: "Voice Actors", path: "/voices", icon: MicVocal, permission: undefined },
  { id: "workflows", label: "Workflows", path: "/workflows", icon: Workflow, permission: "workflows:run" },
  { id: "activity", label: "Activity", path: "/activity", icon: Activity, permission: "workflows:run" },
  { id: "users", label: "Users", path: "/users", icon: ShieldCheck, permission: "users:manage" },
  { id: "settings", label: "Settings", path: "/settings", icon: Settings, permission: undefined },
] as const satisfies readonly NavItem[];

export type PageID = (typeof navItems)[number]["id"];
