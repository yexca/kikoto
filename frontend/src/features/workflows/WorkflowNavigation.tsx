import { Filter, Plus } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import type { WorkflowDefinition } from "@/lib/api";

export type WorkflowFilter = "all" | "built-in" | "custom";

export const builtInWorkflowOrder = [
  "local_library_scan",
  "metadata_sync",
  "remote_popular_collection",
  "dlsite_popular_collection",
  "availability_watch",
];

export function matchesWorkflowFilter(definition: WorkflowDefinition, filter: WorkflowFilter) {
  return filter === "all" || definition.scope === (filter === "built-in" ? "system" : "user");
}

export function WorkflowNavigation({
  definitions,
  filter,
  selectedId,
  onSelect,
  onFilterChange,
  onCreate,
  actions,
}: {
  definitions: WorkflowDefinition[];
  filter: WorkflowFilter;
  selectedId: number | null;
  onSelect: (definition: WorkflowDefinition) => void;
  onFilterChange: (filter: WorkflowFilter) => void;
  onCreate: () => void;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLButtonElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const visible = definitions.filter((definition) => matchesWorkflowFilter(definition, filter));
  const labels = {
    all: t("workflowPage.allDefinitions"),
    "built-in": t("workflowPage.builtIn"),
    custom: t("workflowPage.custom"),
  };

  useEffect(() => {
    stripRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId, filter]);

  const closeFilter = (open: boolean) => {
    setFilterOpen(open);
    if (!open) filterRef.current?.focus({ preventScroll: true });
  };

  return (
    <div className="flex min-w-0 items-center gap-1 border-b pb-1">
      <div
        ref={stripRef}
        className="app-scrollbar flex min-w-0 items-center overflow-x-auto"
        role="tablist"
        aria-label={t("workflowPage.workflowTabs")}
      >
        {visible.map((definition, index) => {
          const builtIn = definition.scope === "system";
          const fullName = builtIn
            ? t(`workflowPage.builtInDefinitions.${definition.code}.name`, { defaultValue: definition.displayName })
            : definition.displayName;
          const label = builtIn
            ? t(`workflowPage.shortNames.${definition.code}`, { defaultValue: fullName })
            : fullName;
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
              className={`relative h-11 shrink-0 rounded-b-none border-b-2 px-3 text-sm ${selected ? "border-primary bg-secondary text-foreground" : "border-transparent text-muted-foreground"} ${index > 0 && !builtIn && visible[index - 1].scope === "system" ? "ml-3" : ""}`}
              onClick={() => onSelect(definition)}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % visible.length
                    : event.key === "ArrowLeft"
                      ? (index - 1 + visible.length) % visible.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? visible.length - 1
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                onSelect(visible[next]);
                const tabs = stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                tabs?.[next]?.focus({ preventScroll: true });
              }}
            >
              <span className="max-w-40 truncate">{label}</span>
            </Button>
          );
        })}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-11 w-11 shrink-0"
        aria-label={t("workflowPage.newWorkflow")}
        title={t("workflowPage.newWorkflow")}
        onClick={onCreate}
      >
        <Plus className="h-4 w-4" />
      </Button>
      <Button
        ref={filterRef}
        variant="ghost"
        size="icon"
        className={`relative ml-auto h-11 w-11 shrink-0 ${filter !== "all" ? "bg-secondary text-primary" : "text-muted-foreground"}`}
        aria-label={t("workflowPage.filterDefinitions")}
        title={`${t("workflowPage.filterDefinitions")}: ${labels[filter]}`}
        aria-expanded={filterOpen}
        aria-haspopup="dialog"
        onClick={() => setFilterOpen(!filterOpen)}
      >
        <Filter className="h-4 w-4" />
        {filter !== "all" && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-primary" />}
      </Button>
      {actions}
      <AnchoredPopover
        open={filterOpen}
        anchorRef={filterRef}
        onOpenChange={closeFilter}
        ariaLabel={t("workflowPage.filterDefinitions")}
        className="w-52 p-1.5"
      >
        <div role="radiogroup" aria-label={t("workflowPage.workflowDefinitionType")}>
          {(["all", "built-in", "custom"] as const).map((value) => (
            <label
              key={value}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 text-sm hover:bg-muted focus-within:ring-2 focus-within:ring-ring"
            >
              <input
                type="radio"
                name="workflow-filter"
                value={value}
                checked={filter === value}
                autoFocus={filter === value}
                onChange={() => {
                  onFilterChange(value);
                  closeFilter(false);
                }}
                className="accent-primary"
              />
              <span>{labels[value]}</span>
              <span aria-hidden="true" className="ml-auto text-xs text-muted-foreground">
                {definitions.filter((definition) => matchesWorkflowFilter(definition, value)).length}
              </span>
            </label>
          ))}
        </div>
      </AnchoredPopover>
    </div>
  );
}
