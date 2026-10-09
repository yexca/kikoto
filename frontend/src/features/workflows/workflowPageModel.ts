import i18n from "@/i18n";
import type { MetadataSyncFormValues } from "@/features/workflows/metadataSyncModel";
import type { PresetFormValues } from "@/features/workflows/presetWorkflowModel";
import type { MetadataSyncOptions, WorkflowDefinition } from "@/lib/api";

/** Copy, built-in workflow tables, and run option types shared by the Workflows page panels. */

export const workflowCopy = (key: string, options?: Record<string, unknown>) => i18n.t(`workflowPage.${key}`, options);

export function localizedWorkflowDefinition(definition: WorkflowDefinition) {
  if (definition.scope !== "system") return definition;
  const key = `workflowPage.builtInDefinitions.${definition.code}`;
  return {
    ...definition,
    displayName: i18n.exists(`${key}.name`) ? i18n.t(`${key}.name`) : definition.displayName,
    description: i18n.exists(`${key}.description`) ? i18n.t(`${key}.description`) : definition.description,
  };
}

export type WorkflowNode = {
  id: string;
  type: string;
  displayName?: string;
  config?: Record<string, unknown>;
};

export type SystemRunKind =
  | "local_scan"
  | "local_media_index"
  | "metadata_sync"
  | "remote_popular"
  | "remote_fetch"
  | "dlsite_popular"
  | "source_health_check"
  | "preset";

export type SystemRunOptions = {
  followUpRun?: boolean;
  localMediaIndexMode?: LocalScanMode;
  metadataSync?: MetadataSyncOptions;
};

export type DLsitePopularPeriod = "day" | "week" | "month" | "year";
export type LocalScanMode = "incremental" | "full";

export type DLsitePopularRunOptions = {
  period: DLsitePopularPeriod;
  releaseWindow: "30d" | "";
  year: number;
  tagNameTemplate: string;
  skipTag: boolean;
};

export type RemotePopularRunOptions = {
  sourceId: number;
  action: "track" | "fetch";
  limit: number;
  tagNameTemplate: string;
  skipTag: boolean;
};

export type RemoteFetchRunOptions = {
  sourceId: number;
  sourceDisplayName: string;
  workCode: string;
  excludeExtensions: string[];
};

export type SystemWorkflowTriggerConfig = {
  followUpRun: boolean;
  scanMode: LocalScanMode;
  sourceId: number;
  action: "track" | "fetch";
  limit: number;
  period: DLsitePopularPeriod;
  releaseWindow: "30d" | "";
  year: number;
  tagNameTemplate: string;
  skipTag: boolean;
};

export type CurrentTriggerRunOptions = {
  code: string;
  systemConfig?: SystemWorkflowTriggerConfig;
  presetValues?: PresetFormValues;
  metadataSync?: MetadataSyncFormValues;
};

export const manuallyRunnableSystemWorkflows: Record<string, SystemRunKind[]> = {
  availability_watch: [],
  local_library_scan: ["local_scan"],
  local_media_index: ["local_media_index"],
  metadata_sync: ["metadata_sync"],
  remote_popular_collection: ["remote_popular"],
  remote_work_fetch: ["remote_fetch"],
  dlsite_popular_collection: ["dlsite_popular"],
  source_health_check: ["source_health_check"],
};

export const configurableSystemWorkflowCodes = new Set(Object.keys(manuallyRunnableSystemWorkflows));

export function parseNodes(definitionJson: string): WorkflowNode[] {
  try {
    const parsed = JSON.parse(definitionJson) as { nodes?: unknown } | null;
    if (!Array.isArray(parsed?.nodes)) return [];
    return parsed.nodes.flatMap((node): WorkflowNode[] => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return [];
      const { id, type, displayName, config } = node as Record<string, unknown>;
      if (typeof id !== "string" || !id || typeof type !== "string" || !type) return [];
      return [
        {
          id,
          type,
          ...(typeof displayName === "string" && displayName ? { displayName } : {}),
          ...(config && typeof config === "object" && !Array.isArray(config)
            ? { config: config as Record<string, unknown> }
            : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

export function parseJSONRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
