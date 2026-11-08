import { CalendarClock, ChevronRight, Eye, Power, type LucideIcon } from "lucide-react";
import { Fragment, useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";

import { RailLabelsToggle, useRailLabelsShown } from "@/components/ui/rail-labels";
import type { WorkflowDefinition, WorkflowRun, WorkflowTrigger } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { RunStatusDot, useRunLabels } from "./RunOverview";
import type { WorkflowCategoryGroup } from "./workflowCategories";
import { workflowCategoryIcons, workflowIcon } from "./workflowVisuals";

const automationGlyphs: { type: string; icon: LucideIcon; label: string }[] = [
  { type: "startup", icon: Power, label: "workflowPage.console.automationStartup" },
  { type: "schedule", icon: CalendarClock, label: "workflowPage.console.automationSchedule" },
  { type: "filesystem_event", icon: Eye, label: "workflowPage.console.automationWatch" },
];

const LABELS_SHOWN_KEY = "kikoto:workflow-rail-labels-shown";

/**
 * Every visible workflow, grouped by category, one line each: its name, a dot
 * on its icon for the latest run, and its active automation. Wide layouts keep
 * it beside the selected workflow and can collapse it to an icon rail; the
 * mobile layout shows it as the landing list that opens a workflow.
 */
export function WorkflowNavigator({
  groups,
  selectedId,
  latestRun,
  triggers,
  mobile,
  onSelect,
}: {
  groups: WorkflowCategoryGroup[];
  selectedId: number | null;
  latestRun: (code: string) => WorkflowRun | null | undefined;
  triggers: WorkflowTrigger[];
  mobile: boolean;
  onSelect: (definition: WorkflowDefinition) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLElement>(null);
  const [labelsShown, toggleLabels] = useRailLabelsShown(LABELS_SHOWN_KEY, true);
  const collapsed = !labelsShown && !mobile;

  useEffect(() => {
    if (mobile) return;
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [mobile, selectedId]);

  const navigation = (
    <nav
      ref={listRef}
      aria-label={t("workflowPage.workflowTabs")}
      className={cn("min-w-0", !mobile && "app-scrollbar min-h-0 overflow-y-auto")}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-workflow-item]") ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
        items[next]?.focus();
      }}
    >
      <div className={cn("grid", mobile ? "gap-5" : collapsed ? "gap-1" : "gap-4")}>
        {groups.map((group, index) => (
          <Fragment key={group.category}>
            {collapsed && index > 0 && <span aria-hidden className="mx-2 my-1 h-px bg-border" />}
            <NavigatorGroup
              group={group}
              selectedId={selectedId}
              latestRun={latestRun}
              triggers={triggers}
              mobile={mobile}
              collapsed={collapsed}
              onSelect={onSelect}
            />
          </Fragment>
        ))}
      </div>
    </nav>
  );
  if (mobile) return navigation;

  return (
    <div
      className={cn(
        "lg:sticky lg:top-20 lg:flex lg:max-h-[calc(100dvh-6rem)] lg:shrink-0 lg:flex-col lg:gap-1 lg:self-start lg:border-r",
        collapsed ? "lg:pr-2" : "lg:w-60 lg:pr-3 xl:w-64 2xl:w-72",
      )}
    >
      {navigation}
      <span aria-hidden className="mx-2 my-1 h-px shrink-0 bg-border" />
      <RailLabelsToggle expanded={!collapsed} onToggle={toggleLabels} />
    </div>
  );
}

function NavigatorGroup({
  group,
  selectedId,
  latestRun,
  triggers,
  mobile,
  collapsed,
  onSelect,
}: {
  group: WorkflowCategoryGroup;
  selectedId: number | null;
  latestRun: (code: string) => WorkflowRun | null | undefined;
  triggers: WorkflowTrigger[];
  mobile: boolean;
  collapsed: boolean;
  onSelect: (definition: WorkflowDefinition) => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const CategoryIcon = workflowCategoryIcons[group.category];
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      {/* An icon rail separates categories with dividers; the heading still names each group. */}
      <h3
        id={headingId}
        className={cn(
          "flex items-center gap-1.5 px-2 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground",
          collapsed && "sr-only",
        )}
      >
        <CategoryIcon className="h-3.5 w-3.5" aria-hidden />
        {t(`workflowPage.categories.${group.category}`)}
      </h3>
      <ul className={cn("grid", mobile ? "overflow-hidden rounded-lg border bg-card" : "gap-0.5")}>
        {group.definitions.map((definition, index) => (
          <li key={definition.id} className={cn(mobile && index > 0 && "border-t")}>
            <NavigatorItem
              definition={definition}
              selected={!mobile && definition.id === selectedId}
              run={latestRun(definition.code)}
              triggers={triggers.filter((trigger) => trigger.workflowDefinitionId === definition.id && trigger.enabled)}
              mobile={mobile}
              collapsed={collapsed}
              onSelect={() => onSelect(definition)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function NavigatorItem({
  definition,
  selected,
  run,
  triggers,
  mobile,
  collapsed,
  onSelect,
}: {
  definition: WorkflowDefinition;
  selected: boolean;
  run: WorkflowRun | null | undefined;
  triggers: WorkflowTrigger[];
  mobile: boolean;
  collapsed: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const labels = useRunLabels();
  const statusId = useId();
  const Icon = workflowIcon(definition.code);
  const fullName = t(`workflowPage.builtInDefinitions.${definition.code}.name`, {
    defaultValue: definition.displayName,
  });
  const label = t(`workflowPage.shortNames.${definition.code}`, { defaultValue: fullName });
  const glyphs = automationGlyphs.filter((glyph) => triggers.some((trigger) => trigger.triggerType === glyph.type));
  const status = run ? labels.status(run.status) : run === null ? t("workflowPage.console.neverRun") : "";
  return (
    <button
      type="button"
      data-workflow-item=""
      aria-label={fullName}
      aria-describedby={statusId}
      aria-current={selected ? "true" : undefined}
      title={fullName}
      className={cn(
        "group/item relative flex w-full min-w-0 items-center gap-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        mobile
          ? "min-h-14 px-3 py-2 hover:bg-muted/50 active:bg-muted/70"
          : collapsed
            ? "h-11 w-11 justify-center rounded-md hover:bg-muted/50 active:bg-muted/70"
            : "min-h-11 rounded-md px-2 py-1 hover:bg-muted/50 active:bg-muted/70",
        selected && "bg-primary/10 hover:bg-primary/10",
      )}
      onClick={onSelect}
    >
      {selected && <span aria-hidden className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-primary" />}
      <span
        className={cn(
          "relative grid h-9 w-9 shrink-0 place-items-center rounded-md transition-colors",
          selected ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground group-hover/item:text-foreground",
        )}
      >
        <Icon className="h-[18px] w-[18px]" aria-hidden />
        {/* The latest run is a dot on the icon; the description names it. */}
        {/* The badge reaches the rail's edge, so it clips a spinning status that would otherwise scroll the rail. */}
        {run && (
          <span className="absolute -bottom-1 -right-1 grid h-4 w-4 place-items-center overflow-hidden rounded-full bg-background">
            <RunStatusDot status={run.status} decorative />
          </span>
        )}
      </span>
      <span className={cn("flex min-w-0 flex-1 items-center gap-2", collapsed && "sr-only")}>
        <span className={cn("min-w-0 flex-1 truncate text-sm", selected ? "font-semibold" : "font-medium")}>
          {label}
        </span>
        {glyphs.length > 0 && (
          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground" aria-hidden>
            {glyphs.map((glyph) => {
              const GlyphIcon = glyph.icon;
              return (
                <span key={glyph.type} title={t(glyph.label)}>
                  <GlyphIcon className="h-3.5 w-3.5" />
                </span>
              );
            })}
          </span>
        )}
      </span>
      <span id={statusId} className="sr-only">
        {[status, ...glyphs.map((glyph) => t(glyph.label))].filter(Boolean).join(", ")}
      </span>
      {mobile && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
    </button>
  );
}
