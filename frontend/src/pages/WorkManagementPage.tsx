import { ExternalLink, Settings } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader } from "@/components/ui/dialog";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
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
 * attention views and the voice actor alias view, plus the settings dialog and
 * sync shortcut. Views own their own tables; this page owns the URL state.
 */
export function WorkManagementPage({
  canSyncMetadata,
  canManageSources,
  canOpenWorkflows,
  readOnly = false,
}: {
  canSyncMetadata: boolean;
  canManageSources: boolean;
  canOpenWorkflows: boolean;
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

  const reasonTabs = [
    ["catalog", "workManagement.all"],
    ["all", "workMaintenance.all"],
    ...(canSyncMetadata ? [["metadata", "workMaintenance.metadata"]] : []),
    ...(canManageSources ? [["no_source", "workMaintenance.noSource"]] : []),
  ];

  return (
    <div className="min-w-0 space-y-4">
      {readOnly && <DemoReadOnlyNotice />}
      <div className="flex items-center justify-between gap-3">
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
        <div className="flex shrink-0 gap-2">
          {canManageSources && (
            <Button
              variant="toolbar"
              aria-label={t("workManagement.settings")}
              title={t("workManagement.settings")}
              onClick={() => showSettings(true)}
            >
              <Settings className="h-4 w-4" />
              <span className="hidden sm:inline">{t("workManagement.settings")}</span>
            </Button>
          )}
          {canSyncMetadata && canOpenWorkflows && (
            <Button
              variant="toolbar"
              aria-label={t("workManagement.openSync")}
              title={t("workManagement.openSync")}
              onClick={() => {
                window.history.pushState({}, "", "/workflows?workflow=metadata_sync");
                window.dispatchEvent(new Event(NAVIGATION_EVENT));
              }}
            >
              <ExternalLink className="h-4 w-4" />
              <span className="hidden sm:inline">{t("workManagement.openSync")}</span>
            </Button>
          )}
        </div>
      </div>
      {view === "aliases" ? (
        <VoiceAliasMaintenance canManage={canSyncMetadata && !readOnly} readOnly={readOnly} />
      ) : (
        <WorkMaintenance
          canManageSources={canManageSources}
          canSyncMetadata={canSyncMetadata}
          readOnly={readOnly}
          reason={reason}
          runId={runId}
          onFilterChange={showWorks}
        />
      )}
      {canManageSources && settingsOpen && (
        <Dialog onClose={() => showSettings(false)} size="xl">
          <DialogHeader
            title={t("workManagement.settings")}
            icon={<Settings className="h-4 w-4" />}
            onClose={() => showSettings(false)}
            closeLabel={t("common.close")}
          />
          <MetadataSettingsPanel readOnly={readOnly} />
        </Dialog>
      )}
    </div>
  );
}
