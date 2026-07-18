import {
  BookmarkPlus,
  Check,
  ChevronDown,
  Cloud,
  Clock3,
  Database,
  Edit3,
  ExternalLink,
  GitFork,
  HardDrive,
  HardDriveDownload,
  Loader2,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { WorkCardListButton, WorkCardQuickMarkButton } from "@/components/work-card/WorkCardShell";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import type { RemoteSourceAvailability } from "@/features/work-detail/source/sourceContextModel";
import type { ListeningStatus } from "@/lib/api";

export type DetailActionMode = "local" | "tracked_unforked" | "tracked_forked" | "remote_source";

export function WorkIdentityActionBar({
  busy,
  canPlay = false,
  listeningStatus,
  favorite,
  listWorkId,
  onEnsureListWork,
  onListSaved,
  onPlay,
  onResume,
  onMark,
  onSync,
  onEditMetadata,
  dlsiteUrl,
  metadataSyncBusy = false,
  syncLabel = "Refresh metadata",
}: {
  busy: boolean;
  canPlay?: boolean;
  listeningStatus: ListeningStatus;
  favorite: boolean;
  listWorkId: number | null;
  onEnsureListWork?: () => Promise<number | null>;
  onListSaved?: (favorite: boolean, workID: number) => void;
  onPlay?: () => void;
  onResume?: () => void;
  onMark: (status: ListeningStatus) => void;
  onSync?: () => void;
  onEditMetadata?: () => void;
  dlsiteUrl: string;
  metadataSyncBusy?: boolean;
  syncLabel?: string;
}) {
  const [manageMenuOpen, setManageMenuOpen] = useState(false);
  const manageMenuRef = useRef<HTMLDivElement | null>(null);

  return (
    <>
      {onPlay && (
        <Button size="sm" className="h-8" disabled={!canPlay || busy} onClick={onPlay}>
          <Play className="h-4 w-4" />
          Play
        </Button>
      )}
      {onResume && (
        <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={onResume}>
          <Clock3 className="h-4 w-4" />
          Resume
        </Button>
      )}
      <WorkCardQuickMarkButton value={listeningStatus} disabled={busy} showLabel responsiveLabel onChange={onMark} />
      <WorkCardListButton
        workId={listWorkId}
        active={favorite}
        disabled={busy}
        showLabel
        responsiveLabel
        ensureWorkId={onEnsureListWork}
        onSaved={onListSaved}
      />
      {dlsiteUrl && (
        <Button variant="outline" size="sm" className="h-8 w-8 px-0 sm:w-auto sm:px-3" asChild title="Open DLsite">
          <a href={dlsiteUrl} target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4" />
            <span className="hidden sm:inline">DLsite</span>
          </a>
        </Button>
      )}
      {(onSync || onEditMetadata) && (
        <div className="relative" ref={manageMenuRef}>
          <Button variant="outline" size="sm" className="relative h-8 w-8 px-0 sm:w-auto sm:pl-3 sm:pr-7" title="Manage metadata" aria-label="Manage metadata" disabled={busy} onClick={() => setManageMenuOpen((open) => !open)}>
            <Database className="h-4 w-4" />
            <span className="hidden sm:inline">Metadata</span>
            <ChevronDown className="absolute right-2 hidden h-3 w-3 sm:block" />
          </Button>
          <AnchoredPopover open={manageMenuOpen} anchorRef={manageMenuRef} onOpenChange={setManageMenuOpen} className="w-52 p-1 text-sm" zIndex={70}>
            {onSync && (
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                disabled={metadataSyncBusy}
                onClick={() => {
                  setManageMenuOpen(false);
                  onSync();
                }}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${metadataSyncBusy ? "animate-spin" : ""}`} />
                <span>{metadataSyncBusy ? "Metadata refresh running" : syncLabel}</span>
              </button>
            )}
            {onEditMetadata && (
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                onClick={() => {
                  setManageMenuOpen(false);
                  onEditMetadata();
                }}
              >
                <Edit3 className="h-3.5 w-3.5" />
                <span>Edit metadata</span>
              </button>
            )}
          </AnchoredPopover>
        </div>
      )}
    </>
  );
}

export function MediaContextActionBar({
  busy,
  mode,
  contextKey,
  onTrack,
  trackDisabled,
  trackDisabledReason,
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
  onRefreshLocalFiles,
}: {
  busy: boolean;
  mode: DetailActionMode;
  contextKey: string;
  onTrack?: () => void;
  trackDisabled?: boolean;
  trackDisabledReason?: string;
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
  onRefreshLocalFiles?: () => void;
}) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsAnchorRef = useRef<HTMLDivElement | null>(null);
  const optionsButtonRef = useRef<HTMLButtonElement | null>(null);
  const optionsMenuRef = useRef<HTMLDivElement | null>(null);
  const optionsMenuId = useId();
  const hasForkOptions = (mode === "tracked_unforked" || mode === "tracked_forked") && Boolean(onFork);
  const hasOptions = Boolean(onTrack || hasForkOptions || onFetch || remoteSourceWorkUrl || onManageCache || onManageFiles || onRefreshLocalFiles || sourceDetailsLoading);
  const SourceIcon = mode === "local" ? HardDrive : mode === "remote_source" ? Cloud : GitFork;
  const displaySourceLabel = sourceLabel || remoteSourceName || "Source";

  useEffect(() => {
    setOptionsOpen(false);
  }, [contextKey]);

  useEffect(() => {
    if (busy) setOptionsOpen(false);
  }, [busy]);

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
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  return (
    <div className="relative shrink-0" ref={optionsAnchorRef}>
      <Button
        ref={optionsButtonRef}
        variant="outline"
        size="sm"
        className="relative h-8 w-8 px-0 sm:w-auto sm:min-w-[6.5rem] sm:pl-3 sm:pr-7"
        disabled={busy || !hasOptions}
        aria-label={`Source actions for ${displaySourceLabel}`}
        aria-haspopup="menu"
        aria-expanded={optionsOpen}
        aria-controls={optionsOpen ? optionsMenuId : undefined}
        title={hasOptions ? `Source actions for ${displaySourceLabel}` : `No actions for ${displaySourceLabel}`}
        onClick={() => setOptionsOpen((open) => !open)}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <SourceIcon className="h-4 w-4" />}
        <span className="hidden sm:inline">Source</span>
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
        <div id={optionsMenuId} ref={optionsMenuRef} role="menu" aria-label="Selected source options" onKeyDown={handleMenuKeyDown}>
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            <span className="block truncate">{displaySourceLabel}</span>
            {sourceStatus && <span className="mt-0.5 block text-[11px] font-normal">{sourceStatus}</span>}
          </div>
          {sourceDetailsLoading && (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading source details
            </div>
          )}
          {mode === "remote_source" && onTrack && (
            <SourceOptionButton
              icon={<BookmarkPlus className="h-4 w-4" />}
              label="Track"
              detail={trackDisabled ? trackDisabledReason || "Already tracked" : undefined}
              disabled={trackDisabled}
              onClick={() => runOption(onTrack)}
            />
          )}
          {hasForkOptions && (
            <div className="border-t px-1 pt-1 first:border-t-0">
              <div className="px-1 py-1 text-[11px] font-medium uppercase text-muted-foreground">
                {mode === "tracked_forked" ? "Switch fork" : "Fork from"}
              </div>
              {forkSources.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">No fork source available</div>
              ) : forkSources.map((remote) => {
                const active = currentForkSource?.source.id === remote.source.id;
                return (
                  <SourceOptionButton
                    key={remote.source.id}
                    icon={<GitFork className="h-4 w-4" />}
                    label={remote.source.displayName}
                    trailing={active ? <Check className="h-3.5 w-3.5 text-primary" /> : undefined}
                    disabled={active}
                    onClick={() => runOption(() => onFork!(remote))}
                  />
                );
              })}
            </div>
          )}
          {onFetch && (
            <SourceOptionButton
              icon={<HardDriveDownload className="h-4 w-4" />}
              label="Fetch"
              onClick={() => runOption(onFetch)}
            />
          )}
          {remoteSourceWorkUrl && (
            <a
              role="menuitem"
              tabIndex={-1}
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-muted focus:bg-muted focus:outline-none"
              href={remoteSourceWorkUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open on ${remoteSourceName || "source"}`}
              onClick={closeOptions}
            >
              <ExternalLink className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">Open origin</span>
            </a>
          )}
          {(onManageCache || onManageFiles || onRefreshLocalFiles) && <div className="my-1 border-t" />}
          {onRefreshLocalFiles && (
            <SourceOptionButton
              icon={<RefreshCw className="h-4 w-4" />}
              label="Refresh local files"
              onClick={() => runOption(onRefreshLocalFiles)}
            />
          )}
          {onManageCache && (
            <SourceOptionButton
              icon={<HardDrive className="h-4 w-4" />}
              label="Manage cache"
              detail={manageCacheDisabled ? "No cached files" : undefined}
              disabled={manageCacheDisabled}
              onClick={() => runOption(onManageCache)}
            />
          )}
          {onManageFiles && (
            <SourceOptionButton
              icon={<Trash2 className="h-4 w-4" />}
              label="Manage files"
              tone="danger"
              onClick={() => runOption(onManageFiles)}
            />
          )}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function SourceOptionButton({
  icon,
  label,
  detail,
  trailing,
  disabled = false,
  tone = "default",
  onClick,
}: {
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
      role="menuitem"
      tabIndex={-1}
      className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left focus:bg-muted focus:outline-none disabled:pointer-events-none disabled:opacity-50 ${
        tone === "danger" ? "text-destructive hover:bg-destructive/10 focus:bg-destructive/10" : "hover:bg-muted"
      }`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {detail && <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>}
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
