import { BookMarked, FilePenLine, FolderPlus, MicVocal, Tags, Users, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { Button } from "@/components/ui/button";
import { contentPageClassName } from "@/components/ui/page-width";
import { SubNavTabs, type SubNavItem } from "@/components/ui/sub-nav";
import { toastFromError, useToast } from "@/components/ui/toast";
import type { MaintenanceToolbarSlots } from "@/features/maintenance/MaintenanceControls";
import { WorkMaintenance } from "@/features/maintenance/WorkMaintenance";
import { CustomWorkAddDialog, CustomWorkNotice } from "@/features/maintenance/CustomWorkMaintenance";
import { MetadataEntryMaintenance } from "@/features/maintenance/MetadataEntryMaintenance";
import { VoiceAliasMaintenance } from "@/features/maintenance/VoiceAliasMaintenance";
import { WorkReasonFilter, type CatalogWorkReason } from "@/features/maintenance/WorkReasonFilter";
import { WorkMetadataEditorModal } from "@/features/work-detail/metadata";
import { api, type MaintenanceCounts, type WorkDetail } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { startLoad } from "@/lib/effectScope";
import { metadataIssueRunFromLocation } from "@/lib/metadataMaintenance";
import { cn } from "@/lib/tailwindClassNames";

type MetadataView = "works" | "aliases" | "tags" | "circles";
// DLsite works holds every catalog `reason` behind its own filter; custom works keep theirs.
type MetadataTabValue = "dlsite" | "custom" | "aliases" | "tags" | "circles";

const tabIcons: Record<MetadataTabValue, LucideIcon> = {
  dlsite: BookMarked,
  custom: FilePenLine,
  tags: Tags,
  circles: Users,
  aliases: MicVocal,
};

/**
 * The work list a link names. Links that name one kind of attention, metadata
 * issues or no available source, open Needs attention, whose rows name what
 * each work needs; a run's issue link keeps its run scope beside it.
 */
function reasonFromLocation() {
  const params = new URLSearchParams(window.location.search);
  if (metadataIssueRunFromLocation()) return "all";
  // `view=custom` opens Add custom work over the custom works list.
  if (params.get("view") === "custom") return "custom";
  const reason = params.get("reason");
  if (reason === "catalog" || reason === "all" || reason === "custom") return reason;
  if (reason === "metadata" || reason === "no_source" || params.get("tab") === "unlinked") return "all";
  return "catalog";
}

function viewFromLocation(): MetadataView {
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "aliases" || view === "tags" || view === "circles" ? view : "works";
}

function addCustomWorkFromLocation(canCreateCustomWorks: boolean) {
  return canCreateCustomWorks && new URLSearchParams(window.location.search).get("view") === "custom";
}

// The requested view falls back to what the viewer may open.
function availableViewFromLocation(canSyncMetadata: boolean): MetadataView {
  const view = viewFromLocation();
  return view === "aliases" && !canSyncMetadata ? "works" : view;
}

// Narrowest search field worth showing inline; below it the field collapses to an icon.
const INLINE_SEARCH_MIN_WIDTH = 224;
const HEADER_GAP = 8;

/**
 * Whether the header row has room for an inline search field beside the
 * actions. Widths come from content (`scrollWidth`) and exclude the
 * collapsed-search toggle, so switching modes does not change the answer.
 */
function useInlineSearchFits(header: RefObject<HTMLElement | null>, actions: RefObject<HTMLElement | null>) {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const measure = () => {
      if (!header.current || !actions.current) return;
      const toggle = actions.current.querySelector<HTMLElement>("[data-search-toggle]");
      const actionsWidth = actions.current.scrollWidth - (toggle ? toggle.offsetWidth + HEADER_GAP : 0);
      setFits(header.current.clientWidth >= actionsWidth + INLINE_SEARCH_MIN_WIDTH + HEADER_GAP);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const element of [header.current, actions.current]) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [header, actions]);
  return fits;
}

/**
 * Metadata page shell: tabs along the top that switch between the saved-work
 * views and the tag, circle, and voice actor views, above a header holding the active
 * view's search, list controls, and selection actions (rendered into slots),
 * and the DLsite works filter. Views own their own tables; this page owns the
 * URL state, decides whether search fits inline, and composes the metadata
 * editor that the work table opens from its action column.
 */
export function WorkManagementPage({
  preferenceRevision = 0,
  canSyncMetadata,
  canManageSources,
  canEditMetadata = false,
  canCreateCustomWorks = false,
  readOnly = false,
}: {
  preferenceRevision?: number;
  canSyncMetadata: boolean;
  canManageSources: boolean;
  canEditMetadata?: boolean;
  canCreateCustomWorks?: boolean;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [reason, setReason] = useState(reasonFromLocation);
  const [runId, setRunId] = useState<number | null>(metadataIssueRunFromLocation);
  const [view, setView] = useState<MetadataView>(() => availableViewFromLocation(canSyncMetadata));
  const [addingCustomWork, setAddingCustomWork] = useState(() => addCustomWorkFromLocation(canCreateCustomWorks));
  const [listRevision, setListRevision] = useState(0);
  // Whether the rename notice is accepted; null until the custom works view asks.
  const [customNotice, setCustomNotice] = useState<boolean | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const [inlineSearchSlot, setInlineSearchSlot] = useState<HTMLDivElement | null>(null);
  const [searchRowSlot, setSearchRowSlot] = useState<HTMLDivElement | null>(null);
  const [counts, setCounts] = useState<MaintenanceCounts | null>(null);
  const [countsRevision, setCountsRevision] = useState(0);
  const [editor, setEditor] = useState<{ work: WorkDetail; onSaved: () => void } | null>(null);
  const [editingWorkId, setEditingWorkId] = useState<number | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const headerActionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => {
      setReason(reasonFromLocation());
      setRunId(metadataIssueRunFromLocation());
      setView(availableViewFromLocation(canSyncMetadata));
      setAddingCustomWork(addCustomWorkFromLocation(canCreateCustomWorks));
    };
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATION_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATION_EVENT, sync);
    };
  }, [canCreateCustomWorks, canSyncMetadata]);

  const needsCustomNotice = view === "works" && reason === "custom" && canCreateCustomWorks && customNotice === null;
  useEffect(() => {
    if (!needsCustomNotice) return;
    // Without an answer the list stays usable and Add stays disabled.
    return startLoad((signal) => api.getCustomWorkNotice(signal), {
      onSuccess: (result) => setCustomNotice(result.noticeAccepted),
    });
  }, [needsCustomNotice]);

  // Counts are a guide beside the views; without them the rail simply shows none.
  useEffect(
    () => startLoad((signal) => api.getMaintenanceCounts(signal), { onSuccess: setCounts }),
    [countsRevision, listRevision],
  );
  const refreshCounts = () => setCountsRevision((value) => value + 1);

  const inlineSearch = useInlineSearchFits(headerRef, headerActionsRef);
  const toolbar: MaintenanceToolbarSlots = {
    actions: actionsSlot,
    search: inlineSearch ? inlineSearchSlot : searchRowSlot,
    compactSearch: !inlineSearch,
  };

  const showWorks = (nextReason: string, nextRun: number | null = null) => {
    const params = new URLSearchParams({ reason: nextReason });
    if (nextRun) params.set("metadataRun", String(nextRun));
    window.history.replaceState(window.history.state, "", `/metadata?${params}`);
    setReason(nextReason);
    setRunId(nextRun);
    setView("works");
  };
  const showEntries = (nextView: "tags" | "circles" | "aliases") => {
    window.history.replaceState(window.history.state, "", `/metadata?view=${nextView}`);
    setView(nextView);
  };
  // The editor changes one work's overrides or metadata link; the list reloads after either.
  const editWork = async (work: { id: number }, onSaved: () => void) => {
    setEditingWorkId(work.id);
    try {
      setEditor({ work: await api.getWorkSummary(work.id), onSaved });
    } catch (error) {
      toast.notify(toastFromError(error, t("workMaintenance.editLoadFailed")));
    } finally {
      setEditingWorkId(null);
    }
  };

  const tabEntries: Array<[MetadataTabValue, string, boolean]> = [
    ["dlsite", t("workManagement.dlsiteWorks"), true],
    ["custom", t("customWorks.rail"), true],
    ["tags", t("metadataEntries.tags"), true],
    ["circles", t("metadataEntries.circles"), true],
    ["aliases", t("workManagement.voiceAliases"), canSyncMetadata],
  ];
  const tabCount = (value: MetadataTabValue) => {
    if (!counts) return undefined;
    const count = value === "dlsite" ? counts.catalog : value === "custom" ? counts.custom : undefined;
    if (count === undefined) return undefined;
    return { count, description: t("workManagement.workCount", { count }) };
  };
  const filterCounts: Partial<Record<CatalogWorkReason, number>> = counts
    ? { catalog: counts.catalog, all: counts.all }
    : {};
  const tabItems: SubNavItem<MetadataTabValue>[] = tabEntries
    .filter(([, , available]) => available)
    .map(([value, label]) => {
      const entries = value === "aliases" || value === "tags" || value === "circles";
      const group = t(entries ? "metadataEntries.entriesGroup" : "metadataEntries.worksGroup");
      const count = tabCount(value);
      return {
        value,
        label,
        icon: tabIcons[value],
        // The count is a guide beside the name; the description reads it after the group.
        suffix: count ? (
          <span aria-hidden="true" className="text-xs font-normal tabular-nums text-muted-foreground">
            {count.count}
          </span>
        ) : undefined,
        id: `metadata-tab-${value}`,
        controls:
          value === "aliases"
            ? "metadata-aliases"
            : value === "tags" || value === "circles"
              ? `metadata-${value}`
              : "metadata-records",
        separated: value === "tags",
        description: [group, count?.description].filter(Boolean).join(", "),
      };
    });
  const catalogReason = view === "works" && reason !== "custom" ? (reason as CatalogWorkReason) : null;
  const tabSelected: MetadataTabValue = view === "works" ? (catalogReason ? "dlsite" : "custom") : view;
  const customView = view === "works" && reason === "custom" && canCreateCustomWorks;
  // Administrators accept the rename notice when they first open the custom works view.
  const customNoticeLocked = customView && customNotice === false;
  const closeAddCustomWork = () => {
    // A `view=custom` link that opened the dialog settles on the custom works list.
    if (new URLSearchParams(window.location.search).get("view") === "custom") showWorks("custom");
    setAddingCustomWork(false);
  };

  return (
    <div className={cn(contentPageClassName, "min-w-0 space-y-3")}>
      {readOnly && <DemoReadOnlyNotice />}
      <div className="flex min-w-0 flex-col gap-3">
        <SubNavTabs
          label={t("workMaintenance.reason")}
          items={tabItems}
          selected={tabSelected}
          onSelect={(value) =>
            value === "aliases" || value === "tags" || value === "circles"
              ? showEntries(value)
              : showWorks(value === "dlsite" ? "catalog" : value)
          }
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div ref={headerRef} className="flex min-h-10 items-center gap-2" data-toast-avoid>
            <div ref={setInlineSearchSlot} className="contents" />
            <div ref={headerActionsRef} className="ml-auto flex shrink-0 items-center gap-2">
              {catalogReason && (
                <WorkReasonFilter selected={catalogReason} counts={filterCounts} onSelect={(next) => showWorks(next)} />
              )}
              <div ref={setActionsSlot} className="contents" />
              {customView && (
                <Button
                  variant="toolbar"
                  size="sm"
                  disabled={customNotice !== true}
                  aria-label={t("customWorks.addTitle")}
                  title={t("customWorks.addTitle")}
                  onClick={() => setAddingCustomWork(true)}
                >
                  <FolderPlus className="h-4 w-4" />
                  <span className="max-sm:sr-only">{t("customWorks.add")}</span>
                </Button>
              )}
            </div>
          </div>
          <div ref={setSearchRowSlot} className="empty:hidden" data-toast-avoid />
          {view === "aliases" ? (
            <VoiceAliasMaintenance canManage={canSyncMetadata && !readOnly} readOnly={readOnly} toolbar={toolbar} />
          ) : view === "tags" || view === "circles" ? (
            <MetadataEntryMaintenance
              key={view}
              kind={view}
              canManage={canEditMetadata && !readOnly}
              toolbar={toolbar}
            />
          ) : (
            <div className="relative">
              <div inert={customNoticeLocked} aria-hidden={customNoticeLocked || undefined}>
                <WorkMaintenance
                  preferenceRevision={preferenceRevision}
                  listRevision={listRevision}
                  canManageSources={canManageSources}
                  canSyncMetadata={canSyncMetadata}
                  readOnly={readOnly}
                  reason={reason}
                  runId={runId}
                  toolbar={toolbar}
                  onFilterChange={showWorks}
                  onChanged={refreshCounts}
                  editingWorkId={editingWorkId}
                  onEditWork={canEditMetadata ? (work, onSaved) => void editWork(work, onSaved) : undefined}
                />
              </div>
              {customNoticeLocked && (
                <div className="absolute inset-0 z-10 bg-background/70 px-4 pt-6 backdrop-blur-[2px]">
                  <CustomWorkNotice onAccepted={() => setCustomNotice(true)} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {addingCustomWork && customNotice === true && (
        <CustomWorkAddDialog onClose={closeAddCustomWork} onCreated={() => setListRevision((value) => value + 1)} />
      )}
      {editor && (
        <WorkMetadataEditorModal
          work={editor.work}
          readOnly={readOnly}
          canSyncMetadata={canSyncMetadata}
          onClose={() => setEditor(null)}
          onSaved={editor.onSaved}
          onLinkChanged={editor.onSaved}
        />
      )}
    </div>
  );
}
