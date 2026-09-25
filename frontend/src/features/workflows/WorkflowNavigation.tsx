import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { WorkflowDefinition } from "@/lib/api";

export const builtInWorkflowOrder = [
  "local_library_scan",
  "local_media_index",
  "metadata_sync",
  "remote_popular_collection",
  "dlsite_popular_collection",
  "availability_watch",
  "remote_work_fetch",
  "circle_follow",
  "series_follow",
  "voice_follow",
];

export function WorkflowNavigation({
  definitions,
  selectedId,
  onSelect,
  actions,
}: {
  definitions: WorkflowDefinition[];
  selectedId: number | null;
  onSelect: (definition: WorkflowDefinition) => void;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    stripRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);

  return (
    <div className="flex min-w-0 items-center gap-1 border-b pb-1">
      <div
        ref={stripRef}
        className="app-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto"
        role="tablist"
        aria-label={t("workflowPage.workflowTabs")}
      >
        {definitions.map((definition, index) => {
          const fullName = t(`workflowPage.builtInDefinitions.${definition.code}.name`, {
            defaultValue: definition.displayName,
          });
          const label = t(`workflowPage.shortNames.${definition.code}`, { defaultValue: fullName });
          const selected = selectedId === definition.id;
          return (
            <Button
              key={definition.id}
              id={`workflow-tab-${definition.id}`}
              role="tab"
              aria-label={fullName}
              aria-selected={selected}
              aria-controls="workflow-definition-panel"
              tabIndex={selected ? 0 : -1}
              title={fullName}
              variant="ghost"
              className={`relative h-11 shrink-0 rounded-b-none border-b-2 px-3 text-sm ${selected ? "border-primary bg-secondary text-foreground" : "border-transparent text-muted-foreground"}`}
              onClick={() => onSelect(definition)}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % definitions.length
                    : event.key === "ArrowLeft"
                      ? (index - 1 + definitions.length) % definitions.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? definitions.length - 1
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                onSelect(definitions[next]);
                const tabs = stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                tabs?.[next]?.focus({ preventScroll: true });
              }}
            >
              <span className="max-w-40 truncate">{label}</span>
            </Button>
          );
        })}
      </div>
      {actions}
    </div>
  );
}
