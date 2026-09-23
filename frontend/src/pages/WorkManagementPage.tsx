import { Settings } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import type { MaintenanceToolbarSlots } from "@/features/maintenance/MaintenanceControls";
import { WorkMaintenance } from "@/features/maintenance/WorkMaintenance";
import { MetadataSettingsPanel } from "@/features/maintenance/MetadataSettingsPanel";
import { VoiceAliasMaintenance } from "@/features/maintenance/VoiceAliasMaintenance";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { metadataIssueRunFromLocation } from "@/lib/metadataMaintenance";

type MetadataView = "works" | "aliases";

const ALIASES_VIEW_PARAM = "aliases";

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

function settingsFromLocation() {
  return new URLSearchParams(window.location.search).get("tab") === "settings";
}

// Narrowest search field worth showing inline; below it the field collapses to an icon.
const INLINE_SEARCH_MIN_WIDTH = 224;
const HEADER_GAP = 8;

/**
 * Whether the header row has room for an inline search field between the tabs
 * and the actions. Widths come from content (`scrollWidth`) and exclude the
 * collapsed-search toggle, so switching modes does not change the answer.
 */
function useInlineSearchFits(
  header: RefObject<HTMLElement | null>,
  tabs: RefObject<HTMLElement | null>,
  actions: RefObject<HTMLElement | null>,
) {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const measure = () => {
      if (!header.current || !tabs.current || !actions.current) return;
      const toggle = actions.current.querySelector<HTMLElement>("[data-search-toggle]");
      const actionsWidth = actions.current.scrollWidth - (toggle ? toggle.offsetWidth + HEADER_GAP : 0);
      const required = tabs.current.scrollWidth + actionsWidth + INLINE_SEARCH_MIN_WIDTH + HEADER_GAP * 2;
      setFits(header.current.clientWidth >= required);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const element of [header.current, tabs.current, actions.current]) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [header, tabs, actions]);
  return fits;
}

function moveTabFocus(event: KeyboardEvent<HTMLButtonElement>) {
  const tabs = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const current = tabs.indexOf(event.currentTarget);
  const next =
    event.key === "ArrowRight"
      ? (current + 1) % tabs.length
      : event.key === "ArrowLeft"
        ? (current + tabs.length - 1) % tabs.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : -1;
  if (next < 0) return;
  event.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}

/**
 * Metadata page shell: one tab strip that switches between the saved-work
 * attention views and the voice actor alias view, plus the settings popover.
 * The header is one row: tabs, then the active view's search, list controls,
 * and selection actions rendered into slots. Views own their own tables; this
 * page owns the URL state and decides whether search fits inline.
 */
export function WorkManagementPage({
  canSyncMetadata,
  canManageSources,
  readOnly = false,
}: {
  canSyncMetadata: boolean;
  canManageSources: boolean;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const availableReason = () => {
    const requested = reasonFromLocation();
    if (requested === "metadata" && !canSyncMetadata) return "catalog";
    if (requested === "no_source" && !canManageSources) return "catalog";
    return requested;
  };
  const availableView = () => (canSyncMetadata ? viewFromLocation() : "works");
  const [reason, setReason] = useState(availableReason);
  const [runId, setRunId] = useState<number | null>(metadataIssueRunFromLocation);
  const [view, setView] = useState<MetadataView>(availableView);
  const [settingsOpen, setSettingsOpen] = useState(settingsFromLocation);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const [inlineSearchSlot, setInlineSearchSlot] = useState<HTMLDivElement | null>(null);
  const [searchRowSlot, setSearchRowSlot] = useState<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const headerActionsRef = useRef<HTMLDivElement>(null);
  const settingsAnchorRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => {
      setReason(availableReason());
      setRunId(metadataIssueRunFromLocation());
      setView(availableView());
      setSettingsOpen(settingsFromLocation());
    };
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATION_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATION_EVENT, sync);
    };
  }, [canManageSources, canSyncMetadata]);

  const tabListRef = useRef<HTMLDivElement>(null);
  const inlineSearch = useInlineSearchFits(headerRef, tabListRef, headerActionsRef);
  const toolbar: MaintenanceToolbarSlots = {
    actions: actionsSlot,
    search: inlineSearch ? inlineSearchSlot : searchRowSlot,
    compactSearch: !inlineSearch,
  };
  useEffect(() => {
    tabListRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [reason, view]);

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

  const reasonTabs = [
    ["catalog", "workManagement.all"],
    ["all", "workMaintenance.all"],
    ...(canSyncMetadata ? [["metadata", "workMaintenance.metadata"]] : []),
    ...(canManageSources ? [["no_source", "workMaintenance.noSource"]] : []),
  ];

  return (
    <div className="min-w-0 space-y-3">
      {readOnly && <DemoReadOnlyNotice />}
      <div ref={headerRef} className="flex items-center gap-2 max-sm:flex-wrap">
        <div
          ref={tabListRef}
          role="tablist"
          aria-label={t("workMaintenance.reason")}
          className={segmentedListClassName("min-w-0")}
        >
          {reasonTabs.map(([value, label]) => {
            const selected = view === "works" && reason === value;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls="metadata-records"
                id={`metadata-tab-${value}`}
                className={segmentedItemClassName(selected)}
                onClick={() => showWorks(value)}
                onKeyDown={moveTabFocus}
                tabIndex={selected ? 0 : -1}
              >
                {t(label)}
              </button>
            );
          })}
          {canSyncMetadata && (
            <>
              <span className="my-1.5 w-px shrink-0 bg-border" aria-hidden="true" />
              <button
                type="button"
                role="tab"
                aria-selected={view === "aliases"}
                aria-controls="metadata-aliases"
                id="metadata-tab-aliases"
                className={segmentedItemClassName(view === "aliases")}
                onClick={showAliases}
                onKeyDown={moveTabFocus}
                tabIndex={view === "aliases" ? 0 : -1}
              >
                {t("workManagement.voiceAliases")}
              </button>
            </>
          )}
        </div>
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
        />
      )}
    </div>
  );
}
