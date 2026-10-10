import {
  BookmarkPlus,
  Check,
  ChevronDown,
  Captions,
  Cloud,
  Clock3,
  Database,
  ExternalLink,
  FolderCog,
  GitFork,
  HardDrive,
  HardDriveDownload,
  Loader2,
  RefreshCw,
  Unlink,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { WorkCardListButton, WorkCardQuickMarkButton } from "@/components/work-card/WorkCardShell";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import type { RemoteSourceAvailability } from "@/features/work-detail/source/sourceContextModel";
import type { ListeningStatus } from "@/lib/api";
import { useTranslation } from "react-i18next";

export type DetailActionMode = "local" | "tracked_unforked" | "tracked_forked" | "remote_source";

export function WorkIdentityActionBar({
  busy,
  listeningStatus,
  favorite,
  listWorkId,
  onEnsureListWork,
  onListSaved,
  onResume,
  onMark,
  canMark,
  onEditMetadata,
}: {
  busy: boolean;
  listeningStatus: ListeningStatus;
  favorite: boolean;
  listWorkId: number | null;
  onEnsureListWork?: () => Promise<number | null>;
  onListSaved?: (favorite: boolean, workID: number) => void;
  onResume?: () => void;
  onMark: (status: ListeningStatus) => void;
  /** Checked before the mark menu opens. */
  canMark?: () => boolean;
  onEditMetadata?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8"
        disabled={busy || !onResume}
        onClick={onResume}
        title={onResume ? t("detailActions.resumeSavedPlayback") : t("detailActions.noUnfinishedPlayback")}
      >
        <Clock3 className="h-4 w-4" />
        {t("detailActions.resume")}
      </Button>
      <WorkCardQuickMarkButton
        value={listeningStatus}
        disabled={busy}
        showLabel
        responsiveLabel
        canOpen={canMark}
        onChange={onMark}
      />
      <WorkCardListButton
        workId={listWorkId}
        active={favorite}
        disabled={busy}
        showLabel
        responsiveLabel
        ensureWorkId={onEnsureListWork}
        onSaved={onListSaved}
      />
      {onEditMetadata && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 px-0 sm:w-auto sm:px-3"
          title={t("detailActions.editMetadata")}
          aria-label={t("detailActions.editMetadata")}
          disabled={busy}
          onClick={onEditMetadata}
        >
          <Database className="h-4 w-4" />
          <span className="hidden sm:inline">{t("detailActions.metadata")}</span>
        </Button>
      )}
    </>
  );
}

export function MediaContextActionBar({
  layout = "menu",
  busy,
  mode,
  contextKey,
  onTrack,
  trackDisabled,
  trackDisabledReason,
  onUntrack,
  canUntrack,
  untrackDisabled = false,
  forkSources = [],
  currentForkSource,
  onFork,
  onFetch,
  remoteSourceWorkUrl,
  remoteSourceName,
  sourceLabel,
  sourceStatus,
  sourceDetailsLoading = false,
  onManageCache,
  manageCacheDisabled = false,
  onManageFiles,
  onManageLyrics,
  onRefreshLocalFiles,
}: {
  busy: boolean;
  mode: DetailActionMode;
  contextKey: string;
  onTrack?: () => void;
  trackDisabled?: boolean;
  trackDisabledReason?: string;
  onUntrack?: () => void;
  /** Checked at the first untrack click, before asking for confirmation. */
  canUntrack?: () => boolean;
  untrackDisabled?: boolean;
  forkSources?: RemoteSourceAvailability[];
  currentForkSource?: RemoteSourceAvailability | null;
  onFork?: (remote: RemoteSourceAvailability) => void;
  onFetch?: () => void;
  remoteSourceWorkUrl?: string;
  remoteSourceName?: string;
  sourceLabel?: string;
  sourceStatus?: string;
  sourceDetailsLoading?: boolean;
  onManageCache?: () => void;
  manageCacheDisabled?: boolean;
  onManageFiles?: () => void;
  onManageLyrics?: () => void;
  onRefreshLocalFiles?: () => void;
  /** `list` renders the actions inline, for a panel that already names the source. */
  layout?: SourceActionLayout;
}) {
  const { t } = useTranslation();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsAnchorRef = useRef<HTMLDivElement | null>(null);
  const optionsButtonRef = useRef<HTMLButtonElement | null>(null);
  const optionsMenuRef = useRef<HTMLDivElement | null>(null);
  const optionsMenuId = useId();
  const [untrackConfirming, setUntrackConfirming] = useState(false);
  const hasForkOptions = (mode === "tracked_unforked" || mode === "tracked_forked") && Boolean(onFork);
  const hasOptions = Boolean(
    onTrack ||
    onUntrack ||
    hasForkOptions ||
    onFetch ||
    remoteSourceWorkUrl ||
    onManageCache ||
    onManageFiles ||
    onManageLyrics ||
    onRefreshLocalFiles ||
    sourceDetailsLoading,
  );
  const SourceIcon = mode === "local" ? HardDrive : mode === "remote_source" ? Cloud : GitFork;
  const displaySourceLabel = sourceLabel || remoteSourceName || t("detailActions.source");
  const sourceActionsLabel = t("detailActions.sourceActionsFor", { source: displaySourceLabel });

  useEffect(() => {
    setOptionsOpen(false);
    setUntrackConfirming(false);
  }, [contextKey]);

  useEffect(() => {
    if (busy) {
      setOptionsOpen(false);
      setUntrackConfirming(false);
    }
  }, [busy]);

  useEffect(() => {
    if (!optionsOpen) setUntrackConfirming(false);
  }, [optionsOpen]);

  useEffect(() => {
    if (!optionsOpen) return;
    const frame = window.requestAnimationFrame(() => {
      firstEnabledMenuItem(optionsMenuRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [optionsOpen]);

  const closeOptions = () => setOptionsOpen(false);
  const runOption = (action: () => void) => {
    closeOptions();
    action();
  };
  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeOptions();
      optionsButtonRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = enabledMenuItems(optionsMenuRef.current);
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (currentIndex + 1 + items.length) % items.length
            : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  const renderItems = (layout: SourceActionLayout) => (
    <>
      {sourceDetailsLoading && (
        <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("detailActions.loadingSourceDetails")}
        </div>
      )}
      {mode === "remote_source" && onTrack && (
        <SourceOptionButton
          layout={layout}
          icon={<BookmarkPlus className="h-4 w-4" />}
          label={t("detailActions.track")}
          detail={trackDisabled ? trackDisabledReason || t("detailActions.alreadyTracked") : undefined}
          disabled={busy || trackDisabled}
          onClick={() => runOption(onTrack)}
        />
      )}
      {hasForkOptions && (
        <div className="border-t px-1 pt-1 first:border-t-0">
          <div className="px-1 py-1 text-2xs font-medium uppercase text-muted-foreground">
            {mode === "tracked_forked" ? t("detailActions.switchFork") : t("detailActions.forkFrom")}
          </div>
          {forkSources.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">{t("detailActions.noForkSourceAvailable")}</div>
          ) : (
            forkSources.map((remote) => {
              const active = currentForkSource?.source.id === remote.source.id;
              return (
                <SourceOptionButton
                  key={remote.source.id}
                  layout={layout}
                  icon={<GitFork className="h-4 w-4" />}
                  label={remote.source.displayName}
                  trailing={active ? <Check className="h-3.5 w-3.5 text-primary" /> : undefined}
                  disabled={busy || active}
                  onClick={() => runOption(() => onFork!(remote))}
                />
              );
            })
          )}
        </div>
      )}
      {onUntrack && (
        <>
          <div className="my-1 border-t first:hidden" />
          <SourceOptionButton
            layout={layout}
            icon={<Unlink className="h-4 w-4" />}
            label={untrackConfirming ? t("detailActions.confirmUntrack") : t("detailActions.untrack")}
            detail={untrackConfirming ? t("detailActions.clickAgainToConfirm") : t("detailActions.stopTrackingSource")}
            tone="danger"
            disabled={busy || untrackDisabled}
            onClick={() => {
              if (!untrackConfirming) {
                if (canUntrack && !canUntrack()) {
                  closeOptions();
                  return;
                }
                setUntrackConfirming(true);
                return;
              }
              setUntrackConfirming(false);
              runOption(onUntrack);
            }}
          />
        </>
      )}
      {onFetch && (
        <SourceOptionButton
          layout={layout}
          icon={<HardDriveDownload className="h-4 w-4" />}
          label={t("detailActions.fetch")}
          disabled={busy}
          onClick={() => runOption(onFetch)}
        />
      )}
      {remoteSourceWorkUrl && (
        <a
          role={layout === "menu" ? "menuitem" : undefined}
          tabIndex={layout === "menu" ? -1 : undefined}
          className={sourceOptionClassName(layout, "default")}
          href={remoteSourceWorkUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={t("detailActions.openOriginOn", { source: remoteSourceName || t("detailActions.source") })}
          onClick={closeOptions}
        >
          <ExternalLink className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("detailActions.openOrigin")}</span>
        </a>
      )}
      {(onManageCache || onManageFiles || onManageLyrics || onRefreshLocalFiles) && (
        <div className="my-1 border-t first:hidden" />
      )}
      {onRefreshLocalFiles && (
        <SourceOptionButton
          layout={layout}
          icon={<RefreshCw className={`h-4 w-4 ${busy && layout === "list" ? "animate-spin" : ""}`} />}
          label={t("detailActions.refreshLocalFiles")}
          disabled={busy}
          onClick={() => runOption(onRefreshLocalFiles)}
        />
      )}
      {onManageCache && (
        <SourceOptionButton
          layout={layout}
          icon={<HardDrive className="h-4 w-4" />}
          label={t("detailActions.manageCache")}
          detail={manageCacheDisabled ? t("detailActions.noCachedFiles") : undefined}
          disabled={busy || manageCacheDisabled}
          onClick={() => runOption(onManageCache)}
        />
      )}
      {onManageFiles && (
        <SourceOptionButton
          layout={layout}
          icon={<FolderCog className="h-4 w-4" />}
          label={t("detailActions.manageFiles")}
          disabled={busy}
          onClick={() => runOption(onManageFiles)}
        />
      )}
      {onManageLyrics && (
        <SourceOptionButton
          layout={layout}
          icon={<Captions className="h-4 w-4" />}
          label={t("detailActions.manageLyrics")}
          disabled={busy}
          onClick={() => runOption(onManageLyrics)}
        />
      )}
    </>
  );

  if (layout === "list") {
    return (
      <div role="group" aria-label={sourceActionsLabel} className="space-y-0.5 text-sm">
        {hasOptions ? (
          renderItems("list")
        ) : (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {t("detailActions.noActionsFor", { source: displaySourceLabel })}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="relative shrink-0" ref={optionsAnchorRef}>
      <Button
        ref={optionsButtonRef}
        variant="outline"
        size="sm"
        className="relative h-8 w-8 px-0 sm:w-auto sm:min-w-[6.5rem] sm:pl-3 sm:pr-7"
        disabled={busy || !hasOptions}
        aria-label={sourceActionsLabel}
        aria-haspopup="menu"
        aria-expanded={optionsOpen}
        aria-controls={optionsOpen ? optionsMenuId : undefined}
        title={hasOptions ? sourceActionsLabel : t("detailActions.noActionsFor", { source: displaySourceLabel })}
        onClick={() => setOptionsOpen((open) => !open)}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <SourceIcon className="h-4 w-4" />}
        <span className="hidden sm:inline">{t("detailActions.source")}</span>
        <ChevronDown className="absolute right-2 hidden h-3 w-3 sm:block" />
      </Button>
      <AnchoredPopover
        open={optionsOpen && !busy}
        anchorRef={optionsAnchorRef}
        onOpenChange={setOptionsOpen}
        className="w-[min(13rem,calc(100vw-1.5rem))] p-1 text-sm"
        bottomCollisionPadding={96}
        zIndex={70}
      >
        <div
          id={optionsMenuId}
          ref={optionsMenuRef}
          role="menu"
          aria-label={t("detailActions.selectedSourceOptions")}
          onKeyDown={handleMenuKeyDown}
        >
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            <span className="block truncate">{displaySourceLabel}</span>
            {sourceStatus && <span className="mt-0.5 block text-2xs font-normal">{sourceStatus}</span>}
          </div>
          {renderItems("menu")}
        </div>
      </AnchoredPopover>
    </div>
  );
}

export type SourceActionLayout = "menu" | "list";

function sourceOptionClassName(layout: SourceActionLayout, tone: "default" | "danger") {
  const toneClassName =
    tone === "danger" ? "text-destructive hover:bg-destructive/10 focus:bg-destructive/10" : "hover:bg-muted";
  const layoutClassName =
    layout === "menu"
      ? "rounded px-2 py-2 focus:bg-muted focus:outline-none"
      : "rounded-md px-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return `flex w-full items-center gap-2.5 text-left disabled:pointer-events-none disabled:opacity-50 ${layoutClassName} ${toneClassName}`;
}

function SourceOptionButton({
  layout,
  icon,
  label,
  detail,
  trailing,
  disabled = false,
  tone = "default",
  onClick,
}: {
  layout: SourceActionLayout;
  icon: ReactNode;
  label: string;
  detail?: string;
  trailing?: ReactNode;
  disabled?: boolean;
  tone?: "default" | "danger";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={layout === "menu" ? "menuitem" : undefined}
      tabIndex={layout === "menu" ? -1 : undefined}
      className={sourceOptionClassName(layout, tone)}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={`shrink-0 ${tone === "danger" ? "" : "text-muted-foreground"}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {detail && <span className="block truncate text-2xs text-muted-foreground">{detail}</span>}
      </span>
      {trailing}
    </button>
  );
}

function enabledMenuItems(root: HTMLDivElement | null) {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
}

function firstEnabledMenuItem(root: HTMLDivElement | null) {
  return enabledMenuItems(root)[0];
}
