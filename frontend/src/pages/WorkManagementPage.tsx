import { Building2, Tags, FolderPlus, LayoutGrid, MicVocal, Settings, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { IconRail, type IconRailItem } from "@/components/ui/icon-rail";
import { useRailOrientation } from "@/components/ui/rail-labels";
import { cx } from "@/lib/classNames";
import { toastFromError, useToast } from "@/components/ui/toast";
import type { MaintenanceToolbarSlots } from "@/features/maintenance/MaintenanceControls";
import { WorkMaintenance } from "@/features/maintenance/WorkMaintenance";
import { CustomWorkAddDialog, CustomWorkNotice } from "@/features/maintenance/CustomWorkMaintenance";
import { MetadataSettingsPanel } from "@/features/maintenance/MetadataSettingsPanel";
import { MetadataEntryMaintenance } from "@/features/maintenance/MetadataEntryMaintenance";
import { VoiceAliasMaintenance } from "@/features/maintenance/VoiceAliasMaintenance";
import { WorkReasonFilter, catalogWorkReasons, type CatalogWorkReason } from "@/features/maintenance/WorkReasonFilter";
import { WorkMetadataEditorModal } from "@/features/work-detail/metadata";
import { api, type MaintenanceCounts, type WorkDetail } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { metadataIssueRunFromLocation } from "@/lib/metadataMaintenance";

type MetadataView = "works" | "aliases" | "tags" | "circles";
// DLsite works holds every catalog `reason` behind its own filter; custom works keep theirs.
type MetadataRailValue = "dlsite" | "custom" | "aliases" | "tags" | "circles";

const railIcons: Record<MetadataRailValue, LucideIcon> = {
  dlsite: LayoutGrid,
  custom: FolderPlus,
  aliases: MicVocal,
  tags: Tags,
  circles: Building2,
};

function reasonFromLocation() {
  const params = new URLSearchParams(window.location.search);
  if (metadataIssueRunFromLocation()) return "metadata";
  // `view=custom` opens Add custom work over the custom works list.
  if (params.get("view") === "custom") return "custom";
  const reason = params.get("reason");
  if (
    reason === "catalog" ||
    reason === "all" ||
    reason === "metadata" ||
    reason === "no_source" ||
    reason === "custom"
  )
    return reason;
  return params.get("tab") === "unlinked" ? "no_source" : "catalog";
}

function viewFromLocation(): MetadataView {
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "aliases" || view === "tags" || view === "circles" ? view : "works";
}

function addCustomWorkFromLocation(canCreateCustomWorks: boolean) {
  return canCreateCustomWorks && new URLSearchParams(window.location.search).get("view") === "custom";
}

// The requested reason and view fall back to what the viewer may open.
function availableReasonFromLocation(canSyncMetadata: boolean, canManageSources: boolean) {
  const requested = reasonFromLocation();
  if (requested === "metadata" && !canSyncMetadata) return "catalog";
  if (requested === "no_source" && !canManageSources) return "catalog";
  return requested;
}

function availableViewFromLocation(canSyncMetadata: boolean): MetadataView {
  const view = viewFromLocation();
  return view === "aliases" && !canSyncMetadata ? "works" : view;
}

function settingsFromLocation() {
  return new URLSearchParams(window.location.search).get("tab") === "settings";
}

// Narrowest search field worth showing inline; below it the field collapses to an icon.
const INLINE_SEARCH_MIN_WIDTH = 224;
const HEADER_GAP = 8;

/**
 * Whether the header row has room for an inline search field between the view
 * title and the actions. Widths come from content (`scrollWidth`) and exclude
 * the collapsed-search toggle, so switching modes does not change the answer.
 */
function useInlineSearchFits(
  header: RefObject<HTMLElement | null>,
  title: RefObject<HTMLElement | null>,
  actions: RefObject<HTMLElement | null>,
) {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const measure = () => {
      if (!header.current || !actions.current) return;
      const toggle = actions.current.querySelector<HTMLElement>("[data-search-toggle]");
      const actionsWidth = actions.current.scrollWidth - (toggle ? toggle.offsetWidth + HEADER_GAP : 0);
      // A title hidden in compact layouts measures zero and needs no gap.
      const titleWidth = title.current?.offsetWidth ? title.current.scrollWidth + HEADER_GAP : 0;
      setFits(header.current.clientWidth >= titleWidth + actionsWidth + INLINE_SEARCH_MIN_WIDTH + HEADER_GAP);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const element of [header.current, title.current, actions.current]) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [header, title, actions]);
  return fits;
}

/**
 * Metadata page shell: an icon rail that switches between the saved-work
 * views and the tag, circle, and voice actor views, beside a header holding the active
 * view's search, list controls, and selection actions (rendered into slots)
 * and the settings popover. Views own their own tables; this page owns the
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
  const [reason, setReason] = useState(() => availableReasonFromLocation(canSyncMetadata, canManageSources));
  const [runId, setRunId] = useState<number | null>(metadataIssueRunFromLocation);
  const [view, setView] = useState<MetadataView>(() => availableViewFromLocation(canSyncMetadata));
  const [addingCustomWork, setAddingCustomWork] = useState(() => addCustomWorkFromLocation(canCreateCustomWorks));
  const [listRevision, setListRevision] = useState(0);
  // Whether the rename notice is accepted; null until the custom works view asks.
  const [customNotice, setCustomNotice] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(settingsFromLocation);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const [inlineSearchSlot, setInlineSearchSlot] = useState<HTMLDivElement | null>(null);
  const [searchRowSlot, setSearchRowSlot] = useState<HTMLDivElement | null>(null);
  // The row leaves the work table its full width; the column rail remains a choice.
  const [railOrientation, toggleRailOrientation] = useRailOrientation("kikoto:metadata-rail-orientation", "horizontal");
  const [counts, setCounts] = useState<MaintenanceCounts | null>(null);
  const [countsRevision, setCountsRevision] = useState(0);
  const [editor, setEditor] = useState<{ work: WorkDetail; onSaved: () => void } | null>(null);
  const [editingWorkId, setEditingWorkId] = useState<number | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const headerActionsRef = useRef<HTMLDivElement>(null);
  const settingsAnchorRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => {
      setReason(availableReasonFromLocation(canSyncMetadata, canManageSources));
      setRunId(metadataIssueRunFromLocation());
      setView(availableViewFromLocation(canSyncMetadata));
      setAddingCustomWork(addCustomWorkFromLocation(canCreateCustomWorks));
      setSettingsOpen(settingsFromLocation());
    };
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATION_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATION_EVENT, sync);
    };
  }, [canCreateCustomWorks, canEditMetadata, canManageSources, canSyncMetadata]);

  const needsCustomNotice = view === "works" && reason === "custom" && canCreateCustomWorks && customNotice === null;
  useEffect(() => {
    if (!needsCustomNotice) return;
    const controller = new AbortController();
    api.getCustomWorkNotice(controller.signal).then(
      (result) => setCustomNotice(result.noticeAccepted),
      // Without an answer the list stays usable and Add stays disabled.
      () => undefined,
    );
    return () => controller.abort();
  }, [needsCustomNotice]);

  // Counts are a guide beside the views; without them the rail simply shows none.
  useEffect(() => {
    const controller = new AbortController();
    api.getMaintenanceCounts(controller.signal).then(
      (next) => setCounts(next),
      () => undefined,
    );
    return () => controller.abort();
  }, [countsRevision, listRevision]);
  const refreshCounts = () => setCountsRevision((value) => value + 1);

  const inlineSearch = useInlineSearchFits(headerRef, titleRef, headerActionsRef);
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
  const showSettings = (open: boolean) => {
    const url = new URL(window.location.href);
    if (open) url.searchParams.set("tab", "settings");
    else url.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    setSettingsOpen(open);
  };
  // Keyboard users land inside the portaled popover and return to its trigger
  // when it closes from within; an outside click keeps the clicked focus.
  useEffect(() => {
    if (settingsOpen) settingsPanelRef.current?.focus({ preventScroll: true });
  }, [settingsOpen]);
  const closeSettings = () => {
    const focusInside = settingsPanelRef.current?.contains(document.activeElement) ?? false;
    showSettings(false);
    if (focusInside) settingsButtonRef.current?.focus({ preventScroll: true });
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

  const railEntries: Array<[MetadataRailValue, string, boolean]> = [
    ["dlsite", t("workManagement.dlsiteWorks"), true],
    ["custom", t("customWorks.rail"), true],
    ["tags", t("metadataEntries.tags"), true],
    ["circles", t("metadataEntries.circles"), true],
    ["aliases", t("workManagement.voiceAliases"), canSyncMetadata],
  ];
  const railCount = (value: MetadataRailValue) => {
    if (!counts) return undefined;
    const count = value === "dlsite" ? counts.catalog : value === "custom" ? counts.custom : undefined;
    if (count === undefined) return undefined;
    return { count, description: t("workManagement.workCount", { count }) };
  };
  const filterReasons = catalogWorkReasons.filter(
    (value) => (value !== "metadata" || canSyncMetadata) && (value !== "no_source" || canManageSources),
  );
  const filterCounts: Partial<Record<CatalogWorkReason, number>> = counts
    ? { catalog: counts.catalog, all: counts.all, metadata: counts.metadata, no_source: counts.noSource }
    : {};
  const railItems: IconRailItem<MetadataRailValue>[] = railEntries
    .filter(([, , available]) => available)
    .map(([value, label]) => ({
      value,
      label,
      badge: railCount(value),
      icon: railIcons[value],
      id: `metadata-tab-${value}`,
      controls:
        value === "aliases"
          ? "metadata-aliases"
          : value === "tags" || value === "circles"
            ? `metadata-${value}`
            : "metadata-records",
      separated: value === "tags",
      groupLabel: t(
        value === "aliases" || value === "tags" || value === "circles"
          ? "metadataEntries.entriesGroup"
          : "metadataEntries.worksGroup",
      ),
      description: t(
        value === "aliases" || value === "tags" || value === "circles"
          ? "metadataEntries.entriesGroup"
          : "metadataEntries.worksGroup",
      ),
    }));
  const catalogReason = view === "works" && reason !== "custom" ? (reason as CatalogWorkReason) : null;
  const railSelected: MetadataRailValue = view === "works" ? (catalogReason ? "dlsite" : "custom") : view;
  const customView = view === "works" && reason === "custom" && canCreateCustomWorks;
  // Administrators accept the rename notice when they first open the custom works view.
  const customNoticeLocked = customView && customNotice === false;
  const closeAddCustomWork = () => {
    // A `view=custom` link that opened the dialog settles on the custom works list.
    if (new URLSearchParams(window.location.search).get("view") === "custom") showWorks("custom");
    setAddingCustomWork(false);
  };

  return (
    <div className="min-w-0 space-y-3">
      {readOnly && <DemoReadOnlyNotice />}
      <div className={cx("flex min-w-0 flex-col gap-3", railOrientation === "vertical" && "lg:flex-row lg:gap-4")}>
        <IconRail
          label={t("workMaintenance.reason")}
          labelsStorageKey="kikoto:metadata-rail-labels-shown"
          items={railItems}
          selected={railSelected}
          orientation={railOrientation}
          onToggleOrientation={toggleRailOrientation}
          onSelect={(value) =>
            value === "aliases" || value === "tags" || value === "circles"
              ? showEntries(value)
              : showWorks(value === "dlsite" ? "catalog" : value)
          }
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div ref={headerRef} className="flex min-h-10 items-center gap-2" data-toast-avoid>
            {/* A wide column rail leaves the current view unnamed here; every row rail names it. */}
            <h2
              ref={titleRef}
              className={cx(
                "shrink-0 whitespace-nowrap text-base font-semibold max-lg:hidden",
                railOrientation === "horizontal" && "hidden",
              )}
            >
              {railItems.find((item) => item.value === railSelected)?.label}
            </h2>
            <div ref={setInlineSearchSlot} className="contents" />
            <div ref={headerActionsRef} className="ml-auto flex shrink-0 items-center gap-2">
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
              {canManageSources && (
                <div ref={settingsAnchorRef} className="relative">
                  <Button
                    ref={settingsButtonRef}
                    variant="toolbar"
                    size="icon-sm"
                    aria-label={t("workManagement.settings")}
                    aria-expanded={settingsOpen}
                    aria-haspopup="dialog"
                    title={t("workManagement.settings")}
                    onClick={() => showSettings(!settingsOpen)}
                  >
                    <Settings className="h-4 w-4" />
                  </Button>
                  <AnchoredPopover
                    open={settingsOpen}
                    anchorRef={settingsAnchorRef}
                    ariaLabel={t("workManagement.settings")}
                    preserveOnNestedLayers
                    className="w-[min(24rem,calc(100vw-1.5rem))]"
                    onOpenChange={(open) => (open ? showSettings(true) : closeSettings())}
                  >
                    <div ref={settingsPanelRef} tabIndex={-1} className="outline-none">
                      <MetadataSettingsPanel readOnly={readOnly} onClose={closeSettings} />
                    </div>
                  </AnchoredPopover>
                </div>
              )}
            </div>
          </div>
          <div ref={setSearchRowSlot} className="empty:hidden" data-toast-avoid />
          {catalogReason && (
            <WorkReasonFilter
              reasons={filterReasons}
              selected={catalogReason}
              counts={filterCounts}
              onSelect={(next) => showWorks(next)}
            />
          )}
          <p className="-mt-1 text-xs text-muted-foreground">
            {t(`workManagement.viewDescriptions.${catalogReason ?? railSelected}`)}
          </p>
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
