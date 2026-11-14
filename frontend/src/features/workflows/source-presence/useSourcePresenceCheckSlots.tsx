import { useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { openWorkflowPath, workflowRunPath } from "@/features/workflows/workflowLinks";
import type { FileSource } from "@/lib/api";

import { SourcePresenceCheckDialog } from "./SourcePresenceCheckDialog";
import { SourcePresenceCheckLine } from "./SourcePresenceCheckLine";
import { useSourcePresenceChecks } from "./useSourcePresenceChecks";

/**
 * What a remote source list shows of each source's library work check: the
 * line under the source, the action that opens its check, and that dialog.
 * Running or scheduling a check needs `workflows:run` beside the source
 * settings' own `sources:write`; Demo opens it read-only.
 */
export function useSourcePresenceCheckSlots({
  enabled,
  sources,
  readOnly,
}: {
  /** The list is shown to a viewer who manages sources. */
  enabled: boolean;
  sources: FileSource[];
  readOnly: boolean;
}) {
  const auth = useAuth();
  const canRun = auth.demoMode || auth.hasPermission("workflows:run");
  const canOpenActivity = !auth.demoMode && auth.hasPermission("workflows:run");
  const { checks, refresh } = useSourcePresenceChecks(enabled && canRun);
  const [openSourceId, setOpenSourceId] = useState<number | null>(null);
  const openSource = sources.find((source) => source.id === openSourceId) ?? null;
  const openRun = canOpenActivity ? (runId: number) => openWorkflowPath(workflowRunPath(runId)) : undefined;

  return {
    refresh,
    renderSourceCheck: (source: FileSource) =>
      checks[source.id] ? <SourcePresenceCheckLine check={checks[source.id]} onOpenRun={openRun} /> : null,
    onOpenSourceCheck: canRun ? (source: FileSource) => setOpenSourceId(source.id) : undefined,
    dialog: openSource ? (
      <SourcePresenceCheckDialog
        source={openSource}
        check={checks[openSource.id]}
        readOnly={readOnly}
        canOpenActivity={canOpenActivity}
        onChanged={refresh}
        onClose={() => setOpenSourceId(null)}
      />
    ) : null,
  };
}
