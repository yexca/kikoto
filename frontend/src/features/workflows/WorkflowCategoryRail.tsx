import { BellRing, Cloud, Library, TrendingUp, type LucideIcon } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";

import type { WorkflowCategory, WorkflowCategoryGroup } from "./workflowCategories";

const categoryIcons: Record<WorkflowCategory, LucideIcon> = {
  basic: Library,
  collect: TrendingUp,
  follow: BellRing,
  remote: Cloud,
};

export const workflowCategoryPanelId = "workflow-category-panel";

export function workflowCategoryTabId(category: WorkflowCategory) {
  return `workflow-category-tab-${category}`;
}

/**
 * Chooses a workflow category. Wide layouts show an icon rail beside the
 * workflow tabs; the mobile navigation layout shows a row of icons above them
 * with the active category labelled.
 */
export function WorkflowCategoryRail({
  groups,
  selected,
  onSelect,
}: {
  groups: WorkflowCategoryGroup[];
  selected: WorkflowCategory | null;
  onSelect: (category: WorkflowCategory) => void;
}) {
  const { t } = useTranslation();
  const mobile = useMobileNavigationLayout();
  const listRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={t("workflowPage.workflowCategories")}
      aria-orientation={mobile ? "horizontal" : "vertical"}
      className="app-scrollbar flex min-w-0 shrink-0 gap-1 overflow-x-auto lg:sticky lg:top-20 lg:flex-col lg:self-start lg:overflow-visible lg:border-r lg:pr-2"
    >
      {groups.map((group, index) => {
        const Icon = categoryIcons[group.category];
        const label = t(`workflowPage.categories.${group.category}`);
        const active = selected === group.category;
        return (
          <Button
            key={group.category}
            id={workflowCategoryTabId(group.category)}
            role="tab"
            aria-selected={active}
            aria-controls={workflowCategoryPanelId}
            tabIndex={active ? 0 : -1}
            title={label}
            variant="ghost"
            className={`relative h-10 min-w-11 shrink-0 justify-center gap-2 px-3 lg:h-11 lg:w-11 lg:px-0 ${
              active ? "bg-primary/10 text-foreground [&>svg]:text-primary" : "text-muted-foreground"
            }`}
            onClick={() => onSelect(group.category)}
            onKeyDown={(event) => {
              const previous = event.key === "ArrowUp" || event.key === "ArrowLeft";
              const next = event.key === "ArrowDown" || event.key === "ArrowRight";
              const target = next
                ? (index + 1) % groups.length
                : previous
                  ? (index - 1 + groups.length) % groups.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? groups.length - 1
                      : -1;
              if (target < 0) return;
              event.preventDefault();
              onSelect(groups[target].category);
              const tabs = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
              tabs?.[target]?.focus({ preventScroll: true });
            }}
          >
            {active && (
              <span
                aria-hidden="true"
                className="absolute inset-x-2 bottom-0 h-[3px] rounded-full bg-primary lg:inset-x-auto lg:inset-y-2 lg:left-0 lg:h-auto lg:w-[3px]"
              />
            )}
            <Icon className="h-5 w-5" />
            {/* Compact layouts name only the active category; the rest keep an accessible name and tooltip. */}
            <span className={`text-sm lg:sr-only ${active ? "" : "sr-only"}`}>{label}</span>
          </Button>
        );
      })}
    </div>
  );
}
