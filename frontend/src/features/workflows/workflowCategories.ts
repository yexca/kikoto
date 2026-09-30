import type { WorkflowDefinition } from "@/lib/api";

export const workflowCategories = ["basic", "collect", "follow", "remote"] as const;

export type WorkflowCategory = (typeof workflowCategories)[number];

const workflowCategoryByCode: Record<string, WorkflowCategory> = {
  local_library_scan: "basic",
  local_media_index: "basic",
  metadata_sync: "basic",
  remote_popular_collection: "collect",
  dlsite_popular_collection: "collect",
  circle_follow: "follow",
  series_follow: "follow",
  voice_follow: "follow",
  availability_watch: "remote",
  remote_work_fetch: "remote",
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
