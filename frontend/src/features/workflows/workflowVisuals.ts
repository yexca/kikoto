import {
  BellRing,
  BookCopy,
  Cloud,
  DatabaseZap,
  Download,
  FileAudio,
  Flame,
  FolderSearch,
  FolderSync,
  Languages,
  Library,
  ListChecks,
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
  catalog: FolderSync,
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
  source_presence_check: ListChecks,
  circle_catalog_sync: Users,
  series_catalog_sync: BookCopy,
  voice_catalog_sync: Mic,
  creator_subscription_refresh: BellRing,
};

/** A neutral glyph that tells workflows apart; status color stays on the run state, never on the icon. */
export function workflowIcon(code: string): LucideIcon {
  return workflowIcons[code] ?? Workflow;
}
