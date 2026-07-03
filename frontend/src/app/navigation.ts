import {
  Database,
  Download,
  Heart,
  Library,
  Play,
  Settings,
  Tags,
  Users,
  Workflow,
} from "lucide-react";

export const navItems = [
  { id: "library", label: "Library", icon: Library },
  { id: "now-playing", label: "Now Playing", icon: Play },
  { id: "favorites", label: "Favorites", icon: Heart },
  { id: "circles", label: "Circles", icon: Users },
  { id: "tags", label: "Tags", icon: Tags },
  { id: "sources", label: "Sources", icon: Database },
  { id: "workflows", label: "Workflows", icon: Workflow },
  { id: "downloads", label: "Downloads", icon: Download },
  { id: "settings", label: "Settings", icon: Settings },
] as const;

export type PageID = (typeof navItems)[number]["id"];
