import { BellRing, Cloud, LayoutGrid, Library, TrendingUp, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { IconRail } from "@/components/ui/icon-rail";

import type { WorkflowCategoryGroup, WorkflowCategoryView } from "./workflowCategories";

const categoryIcons: Record<WorkflowCategoryView, LucideIcon> = {
  all: LayoutGrid,
  basic: Library,
  collect: TrendingUp,
  follow: BellRing,
  remote: Cloud,
};

export const workflowCategoryPanelId = "workflow-category-panel";

export function workflowCategoryTabId(category: WorkflowCategoryView) {
  return `workflow-category-tab-${category}`;
}

/**
 * Chooses a workflow category, led by All. Wide layouts show an icon rail
 * beside the workflow tabs; the mobile navigation layout shows a row of icons
 * above them with the active category labelled.
 */
export function WorkflowCategoryRail({
  groups,
  selected,
  onSelect,
}: {
  groups: WorkflowCategoryGroup[];
  selected: WorkflowCategoryView | null;
  onSelect: (category: WorkflowCategoryView) => void;
}) {
  const { t } = useTranslation();
  const views: WorkflowCategoryView[] = ["all", ...groups.map((group) => group.category)];
  return (
    <IconRail
      label={t("workflowPage.workflowCategories")}
      selected={selected}
      onSelect={onSelect}
      items={views.map((view) => ({
        value: view,
        label: t(`workflowPage.categories.${view}`),
        icon: categoryIcons[view],
        id: workflowCategoryTabId(view),
        controls: workflowCategoryPanelId,
      }))}
    />
  );
}
