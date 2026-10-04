import { CircleAlert, FileWarning, LayoutGrid, MicVocal, Settings, Unlink, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { IconRail, type IconRailItem } from "@/components/ui/icon-rail";
import { toastFromError, useToast } from "@/components/ui/toast";
import type { MaintenanceToolbarSlots } from "@/features/maintenance/MaintenanceControls";
import { WorkMaintenance } from "@/features/maintenance/WorkMaintenance";
import { MetadataSettingsPanel } from "@/features/maintenance/MetadataSettingsPanel";
import { VoiceAliasMaintenance } from "@/features/maintenance/VoiceAliasMaintenance";
import { WorkMetadataEditorModal } from "@/features/work-detail/metadata";
import { api, type MaintenanceWork, type WorkDetail } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { metadataIssueRunFromLocation } from "@/lib/metadataMaintenance";

type MetadataView = "works" | "aliases";
type MetadataRailValue = "catalog" | "all" | "metadata" | "no_source" | "aliases";

const ALIASES_VIEW_PARAM = "aliases";

const railIcons: Record<MetadataRailValue, LucideIcon> = {
  catalog: LayoutGrid,
  all: CircleAlert,
  metadata: FileWarning,
  no_source: Unlink,
  aliases: MicVocal,
};

function reasonFromLocation() {
  const params = new URLSearchParams(window.location.search);
  if (metadataIssueRunFromLocation()) return "metadata";
  const reason = params.get("reason");
  if (reason === "catalog" || reason === "all" || reason === "metadata" || reason === "no_source") return reason;
  return params.get("tab") === "unlinked" ? "no_source" : "catalog";
}

function viewFromLocation(): MetadataView {
  return new URLSearchParams(window.location.search).get("view") === ALIASES_VIEW_PARAM ? "aliases" : "works";
}

// The requested reason and view fall back to what the viewer may open.
function availableReasonFromLocation(canSyncMetadata: boolean, canManageSources: boolean) {
  const requested = reasonFromLocation();
  if (requested === "metadata" && !canSyncMetadata) return "catalog";
  if (requested === "no_source" && !canManageSources) return "catalog";
  return requested;
}

function availableViewFromLocation(canSyncMetadata: boolean): MetadataView {
  return canSyncMetadata ? viewFromLocation() : "works";
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
 * views and the voice actor alias view, beside a header holding the active
 * view's search, list controls, and selection actions (rendered into slots)
 * and the settings popover. Views own their own tables; this page owns the
 * URL state, decides whether search fits inline, and composes the metadata
 * editor that the work table opens from its action column.
 */
export function WorkManagementPage({
  canSyncMetadata,
  canManageSources,
  canEditMetadata = false,
  readOnly = false,
}: {
  canSyncMetadata: boolean;
  canManageSources: boolean;
  canEditMetadata?: boolean;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [reason, setReason] = useState(() => availableReasonFromLocation(canSyncMetadata, canManageSources));
  const [runId, setRunId] = useState<number | null>(metadataIssueRunFromLocation);
  const [view, setView] = useState<MetadataView>(() => availableViewFromLocation(canSyncMetadata));
  const [settingsOpen, setSettingsOpen] = useState(settingsFromLocation);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const [inlineSearchSlot, setInlineSearchSlot] = useState<HTMLDivElement | null>(null);
  const [searchRowSlot, setSearchRowSlot] = useState<HTMLDivElement | null>(null);
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
      setSettingsOpen(settingsFromLocation());
    };
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATION_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATION_EVENT, sync);
    };
  }, [canManageSources, canSyncMetadata]);

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
  const showAliases = () => {
    window.history.replaceState(window.history.state, "", `/metadata?view=${ALIASES_VIEW_PARAM}`);
    setView("aliases");
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
  const editWork = async (work: MaintenanceWork, onSaved: () => void) => {
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
    ["catalog", t("workManagement.all"), true],
    ["all", t("workMaintenance.all"), true],
    ["metadata", t("workMaintenance.metadata"), canSyncMetadata],
    ["no_source", t("workMaintenance.noSource"), canManageSources],
    ["aliases", t("workManagement.voiceAliases"), canSyncMetadata],
  ];
  const railItems: IconRailItem<MetadataRailValue>[] = railEntries
    .filter(([, , available]) => available)
    .map(([value, label]) => ({
      value,
      label,
      icon: railIcons[value],
      id: `metadata-tab-${value}`,
      controls: value === "aliases" ? "metadata-aliases" : "metadata-records",
      separated: value === "aliases",
    }));
  const railSelected = (view === "aliases" ? "aliases" : reason) as MetadataRailValue;

  return (
    <div className="min-w-0 space-y-3">
      {readOnly && <DemoReadOnlyNotice />}
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:gap-4">
        <IconRail
          label={t("workMaintenance.reason")}
          labelsStorageKey="kikoto:metadata-rail-labels-shown"
          items={railItems}
          selected={railSelected}
          onSelect={(value) => (value === "aliases" ? showAliases() : showWorks(value))}
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div ref={headerRef} className="flex min-h-10 items-center gap-2">
            {/* Wide layouts name the current view here; the compact rail already labels it. */}
            <h2 ref={titleRef} className="shrink-0 whitespace-nowrap text-base font-semibold max-lg:hidden">
              {railItems.find((item) => item.value === railSelected)?.label}
            </h2>
            <div ref={setInlineSearchSlot} className="contents" />
            <div ref={headerActionsRef} className="ml-auto flex shrink-0 items-center gap-2">
              <div ref={setActionsSlot} className="contents" />
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
          <div ref={setSearchRowSlot} className="empty:hidden" />
          {view === "aliases" ? (
            <VoiceAliasMaintenance canManage={canSyncMetadata && !readOnly} readOnly={readOnly} toolbar={toolbar} />
          ) : (
            <WorkMaintenance
              canManageSources={canManageSources}
              canSyncMetadata={canSyncMetadata}
              readOnly={readOnly}
              reason={reason}
              runId={runId}
              toolbar={toolbar}
              onFilterChange={showWorks}
              editingWorkId={editingWorkId}
              onEditWork={canEditMetadata ? (work, onSaved) => void editWork(work, onSaved) : undefined}
            />
          )}
        </div>
      </div>
      {editor && (
        <WorkMetadataEditorModal
          work={editor.work}
          readOnly={readOnly}
          onClose={() => setEditor(null)}
          onSaved={editor.onSaved}
          onLinkChanged={editor.onSaved}
        />
      )}
    </div>
  );
}
