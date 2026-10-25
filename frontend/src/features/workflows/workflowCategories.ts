import type { WorkflowDefinition } from "@/lib/api";

export const workflowCategories = ["basic", "collect", "catalog", "remote"] as const;

export type WorkflowCategory = (typeof workflowCategories)[number];

/** Built-in workflows in the order the page lists them; other visible codes follow. */
export const builtInWorkflowOrder = [
  "local_library_scan",
  "local_media_index",
  "metadata_sync",
  "metadata_genre_names",
  "remote_popular_collection",
  "dlsite_popular_collection",
  "availability_watch",
  "remote_work_fetch",
  "source_presence_check",
  "creator_subscription_refresh",
  "circle_catalog_sync",
  "series_catalog_sync",
  "voice_catalog_sync",
];

const workflowCategoryByCode: Record<string, WorkflowCategory> = {
  local_library_scan: "basic",
  local_media_index: "basic",
  metadata_sync: "basic",
  metadata_genre_names: "basic",
  remote_popular_collection: "collect",
  dlsite_popular_collection: "collect",
  circle_catalog_sync: "catalog",
  series_catalog_sync: "catalog",
  voice_catalog_sync: "catalog",
  creator_subscription_refresh: "catalog",
  availability_watch: "remote",
  remote_work_fetch: "remote",
  source_presence_check: "remote",
};

/** Workflows without a declared category, such as a read-only run context, stay with the basic set. */
export function workflowCategory(code: string): WorkflowCategory {
  return workflowCategoryByCode[code] ?? "basic";
}

export type WorkflowCategoryGroup = {
  category: WorkflowCategory;
  definitions: WorkflowDefinition[];
};

/** Groups ordered definitions by category, omitting categories without a visible workflow. */
export function groupWorkflowDefinitions(definitions: WorkflowDefinition[]): WorkflowCategoryGroup[] {
  return workflowCategories
    .map((category) => ({
      category,
      definitions: definitions.filter((definition) => workflowCategory(definition.code) === category),
    }))
    .filter((group) => group.definitions.length > 0);
}
