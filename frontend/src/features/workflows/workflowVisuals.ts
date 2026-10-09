import {
  BellRing,
  BookCopy,
  Cloud,
  DatabaseZap,
  Download,
  FileAudio,
  Flame,
  FolderSearch,
  HeartPulse,
  Languages,
  Library,
  Mic,
  Radar,
  TrendingUp,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import type { WorkflowCategory } from "./workflowCategories";

export const workflowCategoryIcons: Record<WorkflowCategory, LucideIcon> = {
  basic: Library,
  collect: TrendingUp,
  follow: BellRing,
  remote: Cloud,
};

const workflowIcons: Record<string, LucideIcon> = {
  local_library_scan: FolderSearch,
  local_media_index: FileAudio,
  metadata_sync: DatabaseZap,
  metadata_genre_names: Languages,
  remote_popular_collection: TrendingUp,
  dlsite_popular_collection: Flame,
  availability_watch: Radar,
  remote_work_fetch: Download,
  source_health_check: HeartPulse,
  circle_follow: Users,
  series_follow: BookCopy,
  voice_follow: Mic,
};

/** A neutral glyph that tells workflows apart; status color stays on the run state, never on the icon. */
export function workflowIcon(code: string): LucideIcon {
  return workflowIcons[code] ?? Workflow;
}
